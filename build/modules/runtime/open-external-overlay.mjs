/* ============================================================
 * 产品覆盖：外部浏览器登录桥（tokens-login）
 * ============================================================
 * 隔离 Host 下插件进程没有 shell 能力。为 tokens-login 插件在
 * desktopRuntime 桥上增加一个窄能力 openExternal：把部署站点自己的
 * 登录页交给用户默认浏览器打开（账号密码 / OAuth / 钱包 / 通行密钥
 * 全部由站点与浏览器渲染），登录结果经插件自己监听的 127.0.0.1 回调
 * 交回。除该方法外不暴露任何 Electron 面；URL 仅允许 HTTPS，本机回环
 * 地址可用 HTTP（与插件 normalizeSite 同一口径，供本地自建站点开发）。
 * 每个锚点自带守护：上游代码变动导致锚点失配时装配立即失败，等待
 * 人工复查，绝不静默漏掉覆盖。
 * ============================================================ */

const MARKER = 'productOpenExternal'

function replaceOnce(source, anchor, value, label) {
  if (source.split(anchor).length !== 2) {
    throw new Error(`prepare-desktop: 未找到上游${label}锚点，请复查外部浏览器登录桥覆盖`)
  }
  return source.replace(anchor, value)
}

/**
 * 在 DesktopRuntime 接口上声明可选的 openExternal 能力。
 * @param source - staging 副本中 runtime.ts 的完整内容。
 * @returns 追加接口成员后的源码（统一 LF）。
 * @throws 已应用或上游接口锚点变化时抛出，中断打包待人工复查。
 */
export function declareOpenExternalCapability(source) {
  const normalized = source.replaceAll('\r\n', '\n')
  if (normalized.includes('openExternal')) {
    throw new Error('prepare-desktop: runtime.ts 已包含 openExternal，请勿重复应用外部浏览器登录桥覆盖')
  }
  const anchor = [
    '  /** Open the isolated native Profile creator, focusing an existing instance. */',
    "  openProfileCreateWindow(options: Omit<ProfileCreateWindowOptions, 'locale'>): void",
  ].join('\n')
  return replaceOnce(normalized, anchor, `${anchor}

  /**
   * Product overlay (TokensCowork): hand a sign-in URL to the user's default
   * browser. Everything the deployment offers — password, OAuth, wallet
   * extensions, passkeys — works there, and the signed-in session rides a
   * loopback callback back to the plugin.
   */
  openExternal?(url: string): Promise<void>`, 'DesktopRuntime 接口')
}

/**
 * 在 Host↔主进程桥两侧接入 openExternal：Host 代理转发，主进程 handler
 * 调用本文件追加的实现。
 * @param source - staging 副本中 host-runtime-bridge.ts 的完整内容。
 * @returns 双侧接线并追加主进程实现后的源码（统一 LF）。
 * @throws 已应用或上游桥锚点变化时抛出，中断打包待人工复查。
 */
export function bridgeOpenExternal(source) {
  let bridge = source.replaceAll('\r\n', '\n')
  if (bridge.includes(MARKER)) {
    throw new Error('prepare-desktop: host-runtime-bridge.ts 已包含外部浏览器登录桥，请勿重复应用')
  }
  bridge = replaceOnce(
    bridge,
    [
      "      void send('native:openProfileCreateWindow', [callback.id])",
      '    },',
      '  }',
      '  return runtime',
    ].join('\n'),
    [
      "      void send('native:openProfileCreateWindow', [callback.id])",
      '    },',
      "    openExternal: url => send<void>('native:openExternal', [url]),",
      '  }',
      '  return runtime',
    ].join('\n'),
    'Host 运行时代理',
  )
  bridge = replaceOnce(
    bridge,
    [
      "  handle('native:openProfileCreateWindow', ([id]) => runtime.openProfileCreateWindow({",
      '    onSubmit: name => callback(`${id}:submit`, [name]), onCancel: () => report(callback(`${id}:cancel`)),',
      '  }))',
    ].join('\n'),
    [
      "  handle('native:openProfileCreateWindow', ([id]) => runtime.openProfileCreateWindow({",
      '    onSubmit: name => callback(`${id}:submit`, [name]), onCancel: () => report(callback(`${id}:cancel`)),',
      '  }))',
      "  handle('native:openExternal', ([url]) => productOpenExternal(url))",
    ].join('\n'),
    '原生 handler 绑定',
  )
  return `${bridge}
/* ============================================================
 * Product overlay (TokensCowork): external-browser sign-in.
 * The tokens-login plugin hands the deployment's own login page to the
 * user's default browser. HTTPS, or HTTP on a loopback host: that is the
 * same rule the plugin's own site setting applies, so a site it accepts
 * always opens, and a developer running the console locally is not left
 * with a door that refuses its own configuration. Refusing every other
 * scheme keeps this from becoming a general "launch anything" hole in the
 * native surface. The handshake back to the app rides a loopback callback
 * the plugin listens on, so nothing else needs to be exposed here. Runs in
 * the Electron main process only; the utility-process Host reaches it
 * through the native:openExternal RPC.
 * ============================================================ */
export async function productOpenExternal(url: unknown): Promise<void> {
  const target = new URL(String(url ?? ''))
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname.toLowerCase())
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback)) {
    throw new Error('openExternal: HTTPS origin required')
  }
  const electron = await import('electron')
  await electron.shell.openExternal(target.href)
}
`
}

/** 一次装配两个目标文件；staging-prepare 的唯一入口。 */
export function addDesktopOpenExternal({ bridge, runtime }) {
  return {
    bridge: bridgeOpenExternal(bridge),
    runtime: declareOpenExternalCapability(runtime),
  }
}
