/* ============================================================
 * 产品覆盖：运行时模块解析
 * ============================================================
 * 用户 profile 可以安装和更新第三方插件，但不能用其中残留的 DSH
 * 内核包覆盖当前 Desktop 自带的内核。否则两个 dsh-tools 实例会产生
 * 不相等的 Symbol，ToolRuntime 注册与 Agent Loop 查询无法对上。
 * ============================================================ */

/**
 * 将 Desktop 的自身入口和所有 @deepseek-ai/* 包锚定到当前安装目录。
 * 普通第三方插件仍按上游逻辑从所选 profile 解析。
 *
 * 这是上游 35035b69（fix(desktop): anchor upstream profile modules）
 * 针对当前产品固定 Desktop 版本的最小回移。
 *
 * @param source - staging 副本中 module-resolution.ts 的完整内容。
 * @returns 已加入核心包锚定策略的源码。
 * @throws 上游解析器锚点变化时抛出，中断打包等待人工复查。
 */
export function anchorDesktopCoreModules(source) {
  const normalized = source.replaceAll('\r\n', '\n')
  const importAnchor = "import { registerHooks } from 'node:module'"
  const constantsAnchor = "const DESKTOP_PACKAGE_NAME = 'dsh-plugin-desktop'"
  const bareSpecifierAnchor = `function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !URL.canParse(specifier)
}`
  const loaderAnchor = `      if (fromLoader && specifier === DESKTOP_PACKAGE_NAME) {
        return { shortCircuit: true, url: DESKTOP_ENTRY_URL }
      }`

  for (const anchor of [importAnchor, constantsAnchor, bareSpecifierAnchor, loaderAnchor]) {
    if (normalized.split(anchor).length !== 2) {
      throw new Error('prepare-desktop: 未找到上游模块解析锚点，请复查 profile 核心包隔离策略')
    }
  }

  return normalized
    .replace(
      importAnchor,
      "import { createRequire, registerHooks } from 'node:module'\nimport { pathToFileURL } from 'node:url'",
    )
    .replace(
      constantsAnchor,
      `${constantsAnchor}\nconst UPSTREAM_PACKAGE_SCOPE = '@deepseek-ai/'\nconst DESKTOP_REQUIRE = createRequire(DESKTOP_ENTRY_URL)`,
    )
    .replace(
      bareSpecifierAnchor,
      `${bareSpecifierAnchor}\n\n/** Resolve a current Desktop core package without consulting the selected profile. */\nfunction resolveDesktopSpecifier(specifier: string): string | undefined {\n  const isDesktopPackage =\n    specifier === DESKTOP_PACKAGE_NAME || specifier.startsWith(\`\${DESKTOP_PACKAGE_NAME}/\`)\n  const isUpstreamPackage = specifier.startsWith(UPSTREAM_PACKAGE_SCOPE)\n  if (!isDesktopPackage && !isUpstreamPackage) return\n  const resolved = DESKTOP_REQUIRE.resolve(specifier)\n  return pathToFileURL(resolved).href\n}`,
    )
    .replace(
      loaderAnchor,
      `      if (fromLoader) {\n        const desktopUrl = resolveDesktopSpecifier(specifier)\n        if (desktopUrl !== undefined) return { shortCircuit: true, url: desktopUrl }\n      }`,
    )
}

/**
 * 给上游 module-resolution 单测加入核心包隔离回归案例。
 * 测试显式模拟 profile 中存在另一份 dsh-tools，确保解析不会落入 profile。
 *
 * @param source - staging 副本中 module-resolution.spec.ts 的完整内容。
 * @returns 已加入回归案例和 createRequire mock 的测试源码。
 * @throws 上游测试锚点变化时抛出，中断打包等待人工复查。
 */
export function addDesktopCoreModuleResolutionTests(source) {
  const normalized = source.replaceAll('\r\n', '\n')
  const importAnchor = "import { beforeEach, describe, expect, it, vi } from 'vitest'"
  const hooksAnchor = `  deregister: vi.fn(),
}))`
  const moduleMockAnchor = `vi.mock('node:module', () => ({
  registerHooks: vi.fn((definition: { resolve: typeof hooks.resolve }) => {
    hooks.resolve = definition.resolve
    return { deregister: hooks.deregister }
  }),
}))`
  const beforeEachAnchor = `    hooks.resolve = undefined
    hooks.deregister.mockClear()`
  const desktopExpectationAnchor = "      url: new URL('../lib/index.js', new URL('../src/module-resolution.ts', import.meta.url)).href,"
  const insertionAnchor = "  it('resolves dependencies of a linked profile plugin through the selected profile', () => {"

  for (const anchor of [
    importAnchor,
    hooksAnchor,
    moduleMockAnchor,
    beforeEachAnchor,
    desktopExpectationAnchor,
    insertionAnchor,
  ]) {
    if (normalized.split(anchor).length !== 2) {
      throw new Error('prepare-desktop: 未找到上游模块解析测试锚点，请复查核心包隔离回归测试')
    }
  }

  const resolverMock = `  desktopResolve: vi.fn((specifier: string) => {
    const exports: Record<string, string> = {
      'dsh-plugin-desktop': '/current/dsh-plugin-desktop/lib/index.js',
      '@deepseek-ai/dsh-tools': '/current/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
    }
    const resolved = exports[specifier]
    if (resolved !== undefined) return resolved
    const error = new Error(\`Package not found in current Desktop installation: \${specifier}\`)
    Object.assign(error, { code: 'ERR_MODULE_NOT_FOUND' })
    throw error
  }),`

  const regressionTests = `  it('anchors DSH core packages to the current Desktop even when the profile has another copy', () => {
    const profileBaseUrl = 'file:///C:/Users/test/profile/package.json'
    const profileToolsUrl = 'file:///C:/Users/test/profile/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => {
      if (specifier === '@deepseek-ai/dsh-tools' && context.parentURL === profileBaseUrl) {
        return { url: profileToolsUrl }
      }
      throw new Error(\`Unexpected profile resolution: \${specifier}\`)
    })
    const loaderEntryUrl = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')

    expect(hooks.resolve?.(
      '@deepseek-ai/dsh-tools',
      { parentURL: loaderEntryUrl },
      nextResolve,
    )).toEqual({
      shortCircuit: true,
      url: pathToFileURL('/current/node_modules/@deepseek-ai/dsh-tools/lib/index.js').href,
    })
    expect(nextResolve).not.toHaveBeenCalled()
    expect(hooks.desktopResolve).toHaveBeenCalledWith('@deepseek-ai/dsh-tools')
  })

  it('fails closed instead of loading a profile-only DSH core package', () => {
    installProfilePackageResolver('file:///C:/Users/test/profile/package.json')
    const nextResolve = vi.fn()
    const missingError = new Error('Package not found in current Desktop installation')
    hooks.desktopResolve.mockImplementationOnce(() => { throw missingError })

    expect(() => hooks.resolve?.(
      '@deepseek-ai/dsh-old-profile-only',
      { parentURL: import.meta.resolve('@deepseek-ai/cordis-plugin-loader') },
      nextResolve,
    )).toThrow(missingError)
    expect(nextResolve).not.toHaveBeenCalled()
  })

`

  return normalized
    .replace(importAnchor, `${importAnchor}\nimport { pathToFileURL } from 'node:url'`)
    .replace(hooksAnchor, `  deregister: vi.fn(),\n${resolverMock}\n}))`)
    .replace(moduleMockAnchor, moduleMockAnchor.replace(
      "vi.mock('node:module', () => ({",
      "vi.mock('node:module', () => ({\n  createRequire: vi.fn(() => ({ resolve: hooks.desktopResolve })),",
    ))
    .replace(beforeEachAnchor, `${beforeEachAnchor}\n    hooks.desktopResolve.mockClear()`)
    .replace(
      desktopExpectationAnchor,
      "      url: pathToFileURL('/current/dsh-plugin-desktop/lib/index.js').href,",
    )
    .replace(insertionAnchor, `${regressionTests}${insertionAnchor}`)
}
