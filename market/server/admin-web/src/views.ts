/**
 * Every page of the console, in the sidebar's order, with the same titles and addresses as the
 * console at /admin/. `migrated` pages are drawn here; the others are still the old console's and
 * the sidebar links straight to them (/admin/#<page>) until they move.
 */
export interface View {
  id: string
  title: string
  description: string
  migrated: boolean
  /** Tabler icon paths (24 x 24, stroke). */
  icon: string[]
}

export const VIEWS: View[] = [
  { id: 'plugins', title: '插件', description: '管理插件资料、上架状态和访问范围。', migrated: false,
    icon: ['M4 7h3a1 1 0 0 0 1 -1v-1a2 2 0 0 1 4 0v1a1 1 0 0 0 1 1h3a1 1 0 0 1 1 1v3a1 1 0 0 0 1 1h1a2 2 0 0 1 0 4h-1a1 1 0 0 0 -1 1v3a1 1 0 0 1 -1 1h-3a1 1 0 0 1 -1 -1v-1a2 2 0 0 0 -4 0v1a1 1 0 0 1 -1 1h-3a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h1a2 2 0 0 0 0 -4h-1a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1'] },
  { id: 'organizations', title: '组织', description: '同步 TokensAPI 组织，查看每个组织能用的插件。', migrated: false,
    icon: ['M8 9l5 5v7h-5v-4m0 4h-5v-7l5 -5m1 1v-6a1 1 0 0 1 1 -1h10a1 1 0 0 1 1 1v17h-8', 'M13 7l0 .01', 'M17 7l0 .01', 'M17 11l0 .01', 'M17 15l0 .01'] },
  { id: 'users', title: '用户', description: '给 TokensAPI 用户单独授权插件，对该用户名下所有 Key 生效。', migrated: false,
    icon: ['M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0', 'M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2', 'M16 3.13a4 4 0 0 1 0 7.75', 'M21 21v-2a4 4 0 0 0 -3 -3.85'] },
  { id: 'keys', title: 'Key', description: '登记单独授权用的 Key，给它单独授权插件。', migrated: true,
    icon: ['M16.555 3.843l3.602 3.602a2.877 2.877 0 0 1 0 4.069l-2.643 2.643a2.877 2.877 0 0 1 -4.069 0l-.301 -.301l-6.558 6.558a2 2 0 0 1 -1.239 .578l-.175 .008h-1.172a1 1 0 0 1 -.993 -.883l-.007 -.117v-1.172a2 2 0 0 1 .467 -1.284l.119 -.13l.414 -.414h2v-2h2v-2l2.144 -2.144l-.301 -.301a2.877 2.877 0 0 1 0 -4.069l2.643 -2.643a2.877 2.877 0 0 1 4.069 0', 'M15 9h.01'] },
  { id: 'docs', title: '插件文档', description: '上传插件的 Markdown 使用文档和插件图标；用户在文档中心只看到自己有权限的插件。', migrated: false,
    icon: ['M14 3v4a1 1 0 0 0 1 1h4', 'M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2', 'M9 9l1 0', 'M9 13l6 0', 'M9 17l6 0'] },
  { id: 'session-logs', title: '会话日志', description: '客户端上传的会话日志。点一行查看对话，可下载原始 JSON、加备注和标签。', migrated: false,
    icon: ['M21 14l-3 -3h-7a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1h9a1 1 0 0 1 1 1v10', 'M14 15v2a1 1 0 0 1 -1 1h-7l-3 3v-10a1 1 0 0 1 1 -1h2'] },
  { id: 'activity', title: '操作记录', description: '最近的插件、访问范围和组织变更。', migrated: false,
    icon: ['M12 8l0 4l2 2', 'M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5'] },
]

/** An organization administrator's one page is its own organization. */
export const MY_ORGANIZATION = { title: '我的组织', description: '平台提供给本组织的插件；受限插件可以对本组织关闭，或指定只给哪些成员。' }

export const ICONS = {
  plus: ['M12 5l0 14', 'M5 12l14 0'],
  refresh: ['M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4', 'M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4'],
  logout: ['M14 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2', 'M9 12h12l-3 -3', 'M18 15l3 -3'],
  api: ['M4 13h5', 'M12 16v-8h3a2 2 0 0 1 2 2v1a2 2 0 0 1 -2 2h-3', 'M20 8v8', 'M9 16v-5.5a2.5 2.5 0 0 0 -5 0v5.5'],
  back: ['M9 14l-4 -4l4 -4', 'M5 10h11a4 4 0 1 1 0 8h-1'],
  external: ['M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6', 'M11 13l9 -9', 'M15 4h5v5'],
}

export const viewById = (id: string) => VIEWS.find((view) => view.id === id)
/** The old console's address for a page, so the two consoles can hand a page to each other. */
export const legacyHref = (id: string) => `/admin/#${id}`
