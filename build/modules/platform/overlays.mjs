/* ====================================================================
 * platform 覆盖登记表
 * 系统代理回退、Windows ACL 启动链与安装器、打包身份与 macOS 单架构签名。
 * ==================================================================== */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { desktopFiles as d, installedOverlay } from '../../pipeline/stage-targets.mjs'
import {
  alignFsExtArchitecture,
  alignMacEntitlementArchitecture,
  alignMacReleaseChecks,
  alignMacReleaseVerification,
  alignPackagedAgentsAnywhereCheck,
  configureDesktopPackage,
} from './desktop-packaging-overlay.mjs'
import { bridgeDesktopSystemProxy, bridgeWebFetchSystemProxy } from './system-proxy-overlay.mjs'
import { addWindowsAclHostConsole, addWindowsAclInfrastructureFuse, alignWindowsAclConsoleSpec } from './windows-acl-overlay.mjs'
import { addWindowsInstallerGuard, pinNsisResources } from './windows-installer-overlay.mjs'

const asset = (...parts) => resolve(import.meta.dirname, ...parts)

export default [
  {
    id: 'platform.system-proxy-bridge',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'compatibility',
    files: { main: d.main, supervisor: d.hostProcess, host: d.hostProcessEntry },
    apply: ({ main, supervisor, host }) => ({
      main: bridgeDesktopSystemProxy(main, 'main'),
      supervisor: bridgeDesktopSystemProxy(supervisor, 'supervisor'),
      host: bridgeDesktopSystemProxy(host, 'host'),
    }),
    why: '主进程、supervisor 与隔离 Host 之间建立按 URL 查询 Electron 系统代理的通道，供 web-fetch 回退使用。',
    retireWhen: '随 platform.web-fetch-proxy-fallback 一起移除。',
  },
  {
    id: 'platform.mac-adhoc-sign',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'compatibility',
    copy: [[asset('mac-adhoc-sign.ts'), 'dsh-plugin-desktop/scripts/mac-unsigned-after-pack.ts']],
    why: '无正式签名凭据时，替换上游 afterPack 回调为 ad-hoc 签名。',
    retireWhen: '上游提供等效的未签名打包接口后复用。',
  },
  {
    id: 'platform.mac-entitlements-plist',
    phase: 'prepare',
    upstream: ['dsh'],
    kind: 'compatibility',
    // macos-entitlements：应用与 Helper 的签名；jit / node-x64：2.0.18 起给解释器载荷里的 Node 二进制签名（sign-runtime.ts）。
    copy: ['macos-entitlements.plist', 'jit-entitlements.plist', 'node-x64-entitlements.plist'].map(file => [
      resolve(import.meta.dirname, '../../..', 'desktop/deepseek-harness/apps/desktop/scripts', file),
      `deepseek-harness/apps/desktop/scripts/${file}`,
    ]),
    why: '上游 mac 打包配置与解释器载荷签名都把 entitlements 指向同级 Harness 仓库，而 staging 不复制 Harness；按原路径放入清单，codesign 才能读到。',
    retireWhen: '上游把 entitlements 清单移回 dsh-plugin-desktop 内部后移除。',
  },
  {
    id: 'platform.harness-primary-runtime-lock',
    phase: 'prepare',
    upstream: ['dsh'],
    kind: 'compatibility',
    copy: [
      [resolve(import.meta.dirname, '../../..', 'desktop/deepseek-harness/scripts/primary-runtime/lock.json'), 'deepseek-harness/scripts/primary-runtime/lock.json'],
      [resolve(import.meta.dirname, '../../..', 'desktop/deepseek-harness/scripts/primary-runtime/smoke.py'), 'deepseek-harness/scripts/primary-runtime/smoke.py'],
    ],
    why: '2.0.18 起随包分发 Python/Node 解释器载荷，准备脚本从同级 Harness 读 primary-runtime/lock.json 与 smoke.py，而 staging 不复制 Harness；按原路径放入这两个文件。',
    retireWhen: '上游把解释器锁文件移进 dsh-plugin-desktop 后移除。',
  },
  {
    id: 'platform.windows-acl-assets',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'workaround',
    copy: [
      [asset('assets/windows/acl/host-console.ts'), 'dsh-plugin-desktop/src/windows-acl-host-console.ts'],
      [asset('assets/windows/acl/infrastructure-fuse.ts'), 'dsh-plugin-desktop/src/windows-acl-infrastructure-fuse.ts'],
      [asset('assets/windows/acl/product.spec.ts'), 'dsh-plugin-desktop/tests/windows-acl-product.spec.ts'],
    ],
    why: '宿主控制台、基础设施熔断的实现与其 staging 回归，供下面两条 ACL 覆盖引用。',
    retireWhen: '随 ACL 控制台与熔断覆盖一起移除。',
  },
  {
    id: 'platform.fs-ext-architecture',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'compatibility',
    files: { script: d.fsExtPrepare },
    apply: ({ script }) => ({ script: alignFsExtArchitecture(script) }),
    why: 'fs-ext 原生绑定按外层显式指定的架构编译，macOS 两个架构分别构建。',
    retireWhen: '上游 CLI 接受架构参数后移除。',
  },
  {
    id: 'platform.windows-acl-console',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'workaround',
    files: { runner: d.windowsAclRunner, spec: d.windowsPwshSandboxTests },
    apply: ({ runner, spec }) => ({
      runner: addWindowsAclHostConsole(runner),
      spec: alignWindowsAclConsoleSpec(spec),
    }),
    why: '以产品无窗口控制台替换上游 AllocConsole，修复 0xC0000142 与连续闪窗。',
    retireWhen: '上游覆盖等效启动与后台窗口行为，并通过相同 Windows 真机回归后删除。',
  },
  {
    id: 'platform.windows-acl-fuse',
    phase: 'prepare',
    upstream: ['desktop', 'dsh'],
    kind: 'workaround',
    files: { sandbox: d.windowsPwshSandbox },
    apply: ({ sandbox }) => ({ sandbox: addWindowsAclInfrastructureFuse(sandbox) }),
    why: '空输出的 0xC0000142 归类为沙箱基础设施失败，按会话与模式熔断，避免重复启动。',
    retireWhen: '上游提供等效 ACL 失败恢复，并通过相同 Windows 真机回归后删除。',
  },
  {
    id: 'platform.web-fetch-proxy-fallback',
    phase: 'installed',
    upstream: ['dsh'],
    kind: 'compatibility',
    ...installedOverlay('@deepseek-ai/dsh-web-fetch-http', bridgeWebFetchSystemProxy,
      'web-fetch-http is not installed; system proxy bridge cannot be verified'),
    why: '上游已有统一出站代理；仅在没有现有路由和显式代理变量时按请求 URL 查询系统代理，NO_PROXY 与内网限制优先。',
    retireWhen: '上游网页抓取原生支持按 URL 的系统代理回退，且无代理、PAC、取消和内网拒绝回归通过后删除。',
  },
  {
    id: 'platform.package-identity',
    phase: 'configure',
    upstream: ['desktop', 'product'],
    kind: 'customization',
    files: { desktopPackage: d.desktopPackage },
    apply: ({ desktopPackage }, { product, options }) => {
      configureDesktopPackage(desktopPackage, product.product, options.packagingTarget ?? 'default')
      return { desktopPackage }
    },
    why: '产品版本、appId、安装器名称与 GUID、afterSign 公证回调；按打包目标剔除异架构原生依赖（Windows 剔 arm64/ia32，单架构 macOS 按上游 x64ArchFiles 清单剔另一个架构），否则安装包翻倍、签名公证时间翻倍。',
    retireWhen: '产品身份始终保留；上游支持配置化架构裁剪后缩减对应部分。',
  },
  {
    id: 'platform.mac-packaged-uv-check',
    phase: 'configure',
    upstream: ['desktop'],
    kind: 'compatibility',
    files: { verifier: d.verifyPackagedRuntime },
    apply: ({ verifier }) => ({ verifier: alignPackagedAgentsAnywhereCheck(verifier) }),
    why: '上游 afterPack 要求两个架构的 uv 都在包里；剔除异架构后只按 DSH_MAC_ARCH 检查本架构那一个。',
    retireWhen: '随 platform.mac-single-arch-release 一起移除。',
  },
  {
    id: 'platform.nsis-resources',
    phase: 'configure',
    upstream: ['desktop'],
    kind: 'workaround',
    files: { desktopPackage: d.desktopPackage },
    apply: ({ desktopPackage }) => {
      pinNsisResources(desktopPackage)
      return { desktopPackage }
    },
    why: 'NSIS 3.12 捆绑包把 ANSI 版 nsisunz.dll 放进 Unicode 目录；保留新编译器，解压改用验证过的资源。',
    retireWhen: 'electron-builder 资源修复后，覆盖安装与卸载 smoke 通过再删除。',
  },
  {
    id: 'platform.windows-installer-guard',
    phase: 'configure',
    upstream: ['desktop'],
    kind: 'workaround',
    files: {
      desktopPackage: d.desktopPackage,
      guard: { path: 'dsh-plugin-desktop/build/tokenscowork-upgrade-guard.nsh', optional: true },
    },
    apply: ({ desktopPackage }) => addWindowsInstallerGuard(desktopPackage,
      readFileSync(asset('assets/windows/installer/upgrade-guard.nsh'), 'utf8')),
    why: '升级时检查占用、卸载时保留用户数据；拒绝上游改为卸载删除用户数据。',
    retireWhen: '上游安装器等效处理占用与卸载，覆盖安装与卸载 smoke 通过后逐项移除。',
  },
  {
    id: 'platform.mac-single-arch-release',
    phase: 'configure',
    upstream: ['desktop'],
    kind: 'compatibility',
    files: { script: d.releaseMac },
    apply: ({ script }) => ({ script: alignMacReleaseChecks(script) }),
    why: 'macOS 只构建 runner 原生架构，不重复 Universal；共享质量检查由 Windows 任务承担，公证交给产品回调。',
    retireWhen: '上游支持配置化架构与质量门禁后缩减。',
  },
  {
    id: 'platform.mac-release-verification',
    phase: 'configure',
    upstream: ['desktop'],
    kind: 'compatibility',
    files: { script: d.verifyMacRelease },
    apply: ({ script }) => ({ script: alignMacReleaseVerification(script) }),
    why: '只校验所选原生架构，保留全部签名与公证门禁。',
    retireWhen: '随 platform.mac-single-arch-release 一起移除。',
  },
  {
    id: 'platform.mac-entitlement-arch',
    phase: 'configure',
    upstream: ['desktop'],
    kind: 'compatibility',
    files: { script: d.verifyMacEntitlements },
    apply: ({ script }) => ({ script: alignMacEntitlementArchitecture(script) }),
    why: '按所选原生架构核对主程序与全部 Helper 的实际签名。',
    retireWhen: '随 platform.mac-single-arch-release 一起移除。',
  },
  {
    id: 'platform.mac-notarization-hook',
    phase: 'configure',
    upstream: ['product'],
    kind: 'customization',
    copy: [[asset('mac-notarization.mjs'), 'dsh-plugin-desktop/scripts/product-notarize.mjs']],
    why: 'afterSign 先保存已签名应用、摘要和 Apple 提交编号，再等待公证；超时后可由恢复工作流续接原提交。',
    retireWhen: '始终保留；签名凭据隔离与可恢复公证是产品发布要求。',
  },
]

/** 本模块不修改 staging 的脚本：诊断与外层工具。 */
export const checks = [
  { file: 'staging-windows-acl-smoke.mjs', runBy: '手动：构建后用真实 Electron 验证 ACL runner' },
  { file: 'mac-signing-resolve.mjs', runBy: 'build/build.mjs、macos-build.mjs 与发布工作流选择签名模式' },
  { file: 'mac-notarization.mjs', runBy: '复制为 afterSign 回调；恢复工作流直接调用' },
]
