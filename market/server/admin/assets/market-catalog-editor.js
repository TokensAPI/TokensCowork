/** Metadata and lifecycle UI. Permission editing remains a separate controller. */
export function catalogEditor({ request, action, reload, close, isBusy }) {
  const $ = (id) => document.getElementById(id)
  let selected = null,
    generatedId = '',
    baseline = '',
    pending = null
  const draft = () =>
    JSON.stringify(
      [
        'catalog-id',
        'catalog-package',
        'catalog-name',
        'catalog-summary',
        'catalog-repository',
        'catalog-version',
        'catalog-kind',
        'catalog-registry',
        'catalog-commit',
        'catalog-mode',
      ].map((id) => $(id).value),
    )
  function sourceFields() {
    $('catalog-mode').value = $('catalog-kind').value === 'npm' ? 'latest' : 'pinned'
    $('catalog-mode').disabled = true
    $('catalog-repository').required = $('catalog-kind').value !== 'npm'
    $('catalog-commit-label').hidden = $('catalog-kind').value === 'npm'
    $('catalog-commit').required = $('catalog-kind').value !== 'npm'
    $('catalog-registry-label').hidden = $('catalog-kind').value !== 'npm'
  }
  function open(plugin = null) {
    if (isBusy()) return
    selected = plugin
    generatedId = ''
    $('catalog-form').reset()
    $('catalog-error').textContent = ''
    $('catalog-readme-panel').hidden = true
    $('catalog-readme-summary').textContent = ''
    $('catalog-title').textContent = plugin ? '编辑插件' : '新建插件'
    $('catalog-id').value = plugin?.id ?? ''
    $('catalog-id').readOnly = !!plugin
    $('catalog-package').value = plugin?.package ?? ''
    $('catalog-name').value = plugin?.displayName ?? ''
    $('catalog-summary').value = plugin?.summary ?? ''
    $('catalog-repository').value = plugin?.repository ?? ''
    $('catalog-version').value = plugin?.version ?? '1.0.0'
    $('catalog-mode').value = plugin?.versionMode ?? 'pinned'
    $('catalog-kind').value = plugin?.npm === false ? 'github' : 'npm'
    $('catalog-registry').value = plugin?.registry ?? 'npm'
    $('catalog-commit').value = plugin?.installSource?.commit ?? ''
    sourceFields()
    baseline = draft()
    $('catalog-dialog').showModal()
  }
  $('catalog-kind').onchange = sourceFields
  $('catalog-use-readme').onclick = () => {
    if (isBusy()) return
    $('catalog-summary').value = $('catalog-readme-summary').textContent
  }
  $('cancel-catalog').onclick = () => close('catalog-dialog')
  $('catalog-dialog').addEventListener('cancel', (event) => {
    event.preventDefault()
    close('catalog-dialog')
  })
  $('catalog-import').onclick = () =>
    action(
      async () => {
        const pkg = $('catalog-package').value.trim()
        if (!pkg) throw new Error('请先填写 npm 包名或粘贴 npm 链接')
        const data = await request(
          '/api/admin/npm-package?package=' +
            encodeURIComponent(pkg) +
            '&version=' +
            encodeURIComponent(
              $('catalog-import-version').value.trim() || 'latest',
            ),
        )
        $('catalog-package').value = data.package
        if (!selected && (!$('catalog-id').value.trim() || $('catalog-id').value === generatedId)) {
          generatedId = data.suggestedId
          $('catalog-id').value = generatedId
        }
        $('catalog-version').value = data.version
        $('catalog-name').value = data.displayName
        $('catalog-summary').value = data.summary
        $('catalog-readme-summary').textContent = data.readmeSummary || ''
        $('catalog-readme-notice').textContent = data.readmeNotice || ''
        $('catalog-readme-panel').hidden = !data.readmeSummary
        $('catalog-repository').value = data.repository
        $('catalog-kind').value = 'npm'
        sourceFields()
        $('catalog-error').textContent =
          '已读取，可核对资料后保存草稿。' +
          (data.prerelease ? '当前是预发布版本，桌面安装器暂不支持上架安装。' : '') +
          (data.license ? `npm 许可证：${data.license}。` : 'npm 未声明许可证。') +
          '上架前仍须完成完整生产依赖许可证检查。' +
          (data.readmeSummary ? '下方提供 README 简介建议，可点击采用。' : (data.readmeNotice || ''))
      },
      { errorTarget: 'catalog-error' },
    )
  $('catalog-form').onsubmit = (event) => {
    event.preventDefault()
    if (isBusy()) return
    const npm = $('catalog-kind').value === 'npm'
    const metadata = {
      id: $('catalog-id').value.trim(),
      package: $('catalog-package').value.trim(),
      displayName: $('catalog-name').value.trim(),
      summary: $('catalog-summary').value.trim(),
      repository: $('catalog-repository').value.trim(),
      version: $('catalog-version').value.trim(),
      npm,
      ...(npm ? { registry: $('catalog-registry').value } : {}),
      ...(!npm
        ? {
            installSource: {
              kind: 'github',
              commit: $('catalog-commit').value.trim(),
            },
          }
        : {}),
    }
    action(
      async () => {
        const result = await request('/api/admin/catalog', {
          operation: selected ? 'edit' : 'create',
          id: metadata.id,
          revision: selected?.revision,
          metadata,
          versionMode: $('catalog-mode').value,
        })
        $('catalog-dialog').close()
        await reload(
          result.state === 'draft'
            ? '插件已保存为草稿。配置权限并完成检查后，再点击上架。'
            : '插件信息已保存。',
        )
      },
      { errorTarget: 'catalog-error' },
    )
  }
  const labels = {
    publish: '上架插件',
    archive: '下架插件',
    trash: '移入回收站',
    restore: '恢复为草稿',
    purge: '彻底删除',
  }
  function transition(plugin, operation, isPublic) {
    if (isBusy()) return
    pending = { plugin, operation }
    $('lifecycle-form').reset()
    $('lifecycle-error').textContent = ''
    $('lifecycle-title').textContent =
      labels[operation] + ' · ' + plugin.displayName
    $('lifecycle-submit').textContent = labels[operation]
    $('lifecycle-submit').className = operation === 'purge' ? 'danger' : ''
    $('purge-confirm-label').hidden = operation !== 'purge'
    $('purge-confirm-id').required = operation === 'purge'
    $('purge-confirm-id').value = ''
    $('purge-target-id').textContent = plugin.id
    $('publish-checks').hidden = operation !== 'publish'
    $('publish-public-label').hidden = operation !== 'publish' || !isPublic
    $('publish-public').required = operation === 'publish' && isPublic
    $('lifecycle-description').textContent = {
      publish: isPublic
        ? '此插件将对所有人公开。若仅给指定企业使用，请先取消并配置访问权限。'
        : '此插件将按已保存的组织或 Key 权限上架。',
      archive:
        '下架后不再出现在市场，也不能通过市场私有下载入口下载。不会卸载用户已经安装的插件。',
      trash:
        '移入回收站后不再展示。插件资料和授权关系保留，可恢复为草稿；不会删除外部 npm 包。',
      restore: '恢复后仍是草稿，不会立即公开。原授权关系保持不变。',
      purge: '不可恢复：删除市场资料及该插件的组织、Key 授权，保留操作日志。不删除 npm 包、私有存储文件或用户已安装的插件。彻底删除后此 ID 可重新使用。',
    }[operation]
    $('lifecycle-dialog').showModal()
  }
  $('cancel-lifecycle').onclick = () => {
    if (!isBusy()) $('lifecycle-dialog').close()
  }
  $('lifecycle-dialog').addEventListener('cancel', (event) => {
    if (isBusy()) event.preventDefault()
  })
  $('lifecycle-form').onsubmit = (event) => {
    event.preventDefault()
    if (isBusy()) return
    const { plugin, operation } = pending
    if (operation === 'purge' && $('purge-confirm-id').value !== plugin.id) {
      $('lifecycle-error').textContent = '请输入完整插件 ID 确认彻底删除'
      return
    }
    action(
      async () => {
        await request('/api/admin/catalog', {
          id: plugin.id,
          revision: plugin.revision,
          operation,
          ...(operation === 'purge' ? { confirmId: $('purge-confirm-id').value } : {}),
          confirmPublic: $('publish-public').checked,
        })
        $('lifecycle-dialog').close()
        await reload(labels[operation] + '成功。')
      },
      { errorTarget: 'lifecycle-error' },
    )
  }
  $('new-plugin').onclick = () => open()
  return {
    open,
    transition,
    dirty: () => $('catalog-dialog').open && draft() !== baseline,
    clear: () => {
      $('catalog-dialog').close()
      $('lifecycle-dialog').close()
      selected = null
      pending = null
    },
  }
}
