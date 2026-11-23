import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DataPager from './DataPager.vue'

describe('the pager', () => {
  it('reads as at /admin/: the range, the first and last page, two either side of the current one', async () => {
    const pager = mount(DataPager, { props: { page: 6, pageSize: 20, total: 400, label: '列表分页' } })
    expect(pager.find('p').text()).toBe('第 101-120 个 · 共 400 个')
    expect(pager.findAll('.page-link').map((link) => link.text())).toEqual(['‹', '1', '…', '4', '5', '6', '7', '8', '…', '20', '›'])
    expect(pager.find('[aria-current="page"]').text()).toBe('6')
    await pager.find('button[aria-label="第 8 页"]').trigger('click')
    await pager.find('button[aria-label="下一页"]').trigger('click')
    await pager.find('select').setValue('50')
    expect(pager.emitted('go')).toEqual([[8], [7]])
    expect(pager.emitted('size')).toEqual([[50]])
  })

  it('an empty list is one page with nothing to step to', () => {
    const pager = mount(DataPager, { props: { page: 1, pageSize: 20, total: 0, label: '列表分页' } })
    expect(pager.find('p').text()).toBe('第 0-0 个 · 共 0 个')
    expect(pager.find('button[aria-label="上一页"]').attributes('disabled')).toBeDefined()
    expect(pager.find('button[aria-label="下一页"]').attributes('disabled')).toBeDefined()
  })
})
