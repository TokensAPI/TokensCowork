// DSH 0.2 侧栏“插件”页（@deepseek-ai/dsh-client-ui-plugin-manager）的安装入口。
// 插件安装统一走插件市场；该页的“添加插件”可按 npm 包名、Git 地址或本地目录直接安装，
// 绕过私有 Registry、版本与兼容性检查，因此去掉入口。刷新、启停、配置与卸载保持上游行为。
import { replacePatternOnce } from '../../pipeline/anchors.mjs'

const MARKER = '/* TokensCowork: plugin page install entry removed; install through the plugin market. */'

/** 不渲染右上角“添加插件”按钮，并让 openInstall 不再打开安装对话框。可重复执行。 */
export function removePluginPageInstall(source) {
  if (source.includes(MARKER)) {
    if (source.includes('onClick: props.openInstall') || source.includes('"plugin_add_button_click"')) {
      throw new Error('incomplete plugin page install entry removal')
    }
    return source
  }
  // 工具栏 children 里刷新按钮之后的“添加插件”按钮；刷新按钮保留。
  let next = replacePatternOnce(source,
    /, \(0, react_jsx_runtime\.jsx\)\(_deepseek_ai_dsh_client_ui_primitives\.Button, \{\s*variant: "primary",\s*size: "sm",\s*className: PluginManagerPage_module_css_default\.addButton,[\s\S]*?onClick: props\.openInstall,\s*children: t\(state\.install\.requestId === void 0 \? "addPlugin" : "installViewTask"\)\s*\}\)\]/u,
    ` ${MARKER}]`,
    'plugin page add button')
  // 没有其他入口调用 openInstall；保留属性避免调用方报错，但不再打开对话框。
  next = replacePatternOnce(next,
    /openInstall: \(\) => \{\s*this\.ctx\.get\("productAnalytics"\)\?\.track\("plugin_add_button_click", \{\}\);/u,
    `openInstall: () => { ${MARKER} return;`,
    'plugin page openInstall')
  return next
}
