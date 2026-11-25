/**
 * A fictional GitHub release list in the shape releases.json has (tag, pre-release flag, date,
 * bilingual notes with 「本次更新」 and the components table, installers), for the local QA server
 * and the console screenshots. Every name, number and sentence here is made up.
 */
const notes = (version, previous, summary, sections, components) => [
  `# TokensCowork v${version}`, '',
  summary, '',
  '[中文](#user-content-release-notes-zh) | [English](#user-content-release-notes-en)', '',
  '<a name="release-notes-zh"></a>', '',
  '## 本次更新', '',
  ...sections.flatMap(([title, items]) => [`### ${title}`, '', ...items.map(item => `- ${item}`), '']),
  '### 内置组件与插件', '',
  '| 组件 | 版本 |', '|---|---|',
  ...components.map(([name, value]) => `| ${name} | ${value} |`), '',
  '## 下载说明', '', '见附件。', '',
  `[完整变更](https://github.com/TokensAPI/TokensCowork/compare/v${previous}...v${version})`, '',
  '<a name="release-notes-en"></a>', '',
  "## What's New", '', '- (English notes, not shown in the console.)', '',
].join('\n')

const COMPONENTS = [['Desktop', '2.1.0'], ['DSH', '0.2.2'], ['TokensCowork 更新', '0.2.1'], ['Tokens Cowork UI', '0.2.32'], ['TokensAPI 模型', '0.2.32'], ['联网搜索', '0.2.6']]
const installers = version => [
  [`TokensCowork-${version}-windows-amd64-installer.exe`, 271_000_000],
  [`TokensCowork-${version}-macos-arm64-installer.dmg`, 398_000_000],
  [`TokensCowork-${version}-macos-amd64-installer.dmg`, 412_000_000],
  [`TokensCowork-${version}-SHA256SUMS.txt`, 338],
].map(([name, size]) => ({ name, size, browser_download_url: `https://github.com/TokensAPI/TokensCowork/releases/download/v${version}/${name}`, content_type: 'application/octet-stream' }))

const entry = (version, prerelease, publishedAt, body) => ({
  tag_name: `v${version}`, name: `TokensCowork v${version}`, html_url: `https://github.com/TokensAPI/TokensCowork/releases/tag/v${version}`,
  draft: false, prerelease, published_at: publishedAt, body, assets: installers(version),
})

export const DEMO_RELEASES = [
  entry('0.8.2', true, '2026-11-25T08:00:00Z', notes('0.8.2', '0.8.1', '在 v0.8.1 基础上，会话列表支持按项目分组；修复切换模型后输入框偶尔失去焦点的问题。（示例说明）', [
    ['✨ 新功能与优化', ['会话列表可以按项目分组显示，分组可折叠。', '设置页新增「快捷键」一节，列出全部快捷键。']],
    ['🐛 问题修复', ['切换模型后输入框偶尔失去焦点，现已修复。']],
  ], COMPONENTS)),
  entry('0.8.1', true, '2026-11-24T08:00:00Z', notes('0.8.1', '0.8.0', '在 v0.8.0 基础上，修复长对话导出为 Markdown 时图片丢失的问题。（示例说明）', [
    ['🐛 问题修复', ['长对话导出为 Markdown 时图片丢失，现已修复。', '托盘菜单在深色模式下文字看不清，现已修复。']],
  ], COMPONENTS)),
  entry('0.8.0', true, '2026-11-22T08:00:00Z', notes('0.8.0', '0.7.19', '新的大版本：界面整体改版，侧栏可以自定义；插件市场支持按分类浏览；启动速度提升约三成。（示例说明）', [
    ['✨ 新功能与优化', [
      '界面整体改版：新的配色与图标，侧栏条目可以拖动排序、隐藏。',
      '插件市场「发现」页按分类浏览，支持按名称搜索。',
      '启动速度提升约三成：首次打开窗口前不再等待插件全部加载。',
      '对话中的代码块可以一键复制，并显示语言名称。',
      '新增「最近使用的文件」入口，在输入框上方显示。',
    ]],
    ['🐛 问题修复', [
      '网络切换后偶尔需要重启才能继续对话，现已修复。',
      '中文输入法候选词遮住输入框，现已修复。',
      '设置页部分开关状态没有保存，现已修复。',
    ]],
    ['⚠️ 其他变更', ['不再支持 macOS 12 及更早版本。', '日志文件改为按天分开保存，保留 14 天。']],
  ], COMPONENTS)),
  entry('0.7.19', false, '2026-11-21T08:00:00Z', notes('0.7.19', '0.7.18', '在 v0.7.18 基础上修复四个问题，汇总 v0.7.17 至 v0.7.19 的全部改动。（示例说明）', [
    ['🐛 问题修复', ['长会话中回答被反复截断，现已修复。', '插件更新偶尔卡住，现已修复。']],
  ], COMPONENTS.map(([name, value]) => [name, name === 'Desktop' ? '2.0.18' : value]))),
]
