/* ====================================================================
 * updates 覆盖登记表
 * 关闭官方 DSH Desktop 更新，更新入口交给内置的产品更新插件。
 * ==================================================================== */
import { desktopFiles as d, pluginEnabled, productPlugin } from '../../pipeline/stage-targets.mjs'
import {
  alignProductUpdateCommand,
  configureProductUpdates,
  disableUpstreamUpdates,
  verifyDisabledUpdateMenu,
  verifyProductUpdateMenu,
} from './updates-overlay.mjs'

const hasUpdatePlugin = product => pluginEnabled(product, 'tokens-version-updates')

export default [
  {
    id: 'updates.disable-official',
    phase: 'prepare',
    upstream: ['desktop'],
    kind: 'customization',
    files: { patch: d.desktopPatchSource },
    apply: ({ patch }) => ({ patch: disableUpstreamUpdates(patch) }),
    why: '上游 desktop-updates 指向官方 DSH Desktop 发布，与本产品无关，始终停用。',
    retireWhen: '上游可配置产品 Release 来源时，改为配置并删除停用条目。',
  },
  {
    id: 'updates.profile-menu-check',
    phase: 'prepare',
    upstream: ['desktop', 'plugin:tokens-version-updates'],
    kind: 'customization',
    files: { verifier: d.profileBootVerifier },
    apply: ({ verifier }, { product }) => ({
      verifier: hasUpdatePlugin(product) ? verifyProductUpdateMenu(verifier) : verifyDisabledUpdateMenu(verifier),
    }),
    why: '停用官方更新后，Profile 启动验收改为：有更新插件时必须出现产品菜单，没有时更新菜单必须全部隐藏。',
    retireWhen: '随 updates.disable-official 一起移除。',
  },
  {
    id: 'updates.tray-command-id',
    phase: 'plugins',
    upstream: ['desktop', 'plugin:tokens-version-updates'],
    kind: 'compatibility',
    when: ({ product }) => hasUpdatePlugin(product),
    files: { entry: productPlugin('tokens-version-updates', 'index.js') },
    apply: ({ entry }) => ({ entry: alignProductUpdateCommand(entry) }),
    why: '新版顶部菜单按 check-for-updates ID 查找命令；给产品更新插件的托盘项补齐 ID，复用原有手动检查。',
    retireWhen: '更新插件原生注册相同 ID，或 Desktop 改用新的更新命令 API 时移除；不能只按菜单文案验收。',
  },
  {
    id: 'updates.release-source',
    phase: 'configure',
    upstream: ['product', 'plugin:tokens-version-updates'],
    kind: 'customization',
    when: ({ product }) => hasUpdatePlugin(product),
    files: { patch: d.desktopPatch },
    apply: ({ patch }, { product }) => {
      const match = /^(?<owner>[^/]+)\/(?<repo>[^/]+)$/u.exec(product.product.repository ?? '')
      if (match?.groups === undefined) throw new Error('product repository must use owner/repository format')
      return { patch: configureProductUpdates(patch, product.product, match.groups.owner, match.groups.repo) }
    },
    why: '让更新插件跟随当前产品名与发布仓库，不修改只读插件子模块。',
    retireWhen: '插件自身读取产品配置后移除。',
  },
]
