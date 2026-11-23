<script setup lang="ts">
import { computed } from 'vue'

/**
 * The pager every paged list shares, as at /admin/ (market-ui.js pager()): 「第 x-y 个 · 共 N 个」
 * on the left, then 「‹ 1 … 4 5 [6] 7 8 … 20 ›」 and the page size. Goes in a card's footer.
 */
const props = withDefaults(
  defineProps<{ page: number; pageSize: number; total: number; unit?: string; sizeUnit?: string; sizeLabel?: string; label: string; sizes?: number[]; disabled?: boolean }>(),
  { unit: '个', sizeUnit: '', sizeLabel: '', sizes: () => [10, 20, 50, 100], disabled: false },
)
const emit = defineEmits<{ go: [page: number]; size: [pageSize: number] }>()

const pages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)))
const info = computed(() => {
  const first = props.total ? (props.page - 1) * props.pageSize + 1 : 0
  return `第 ${first}-${Math.min(props.total, props.page * props.pageSize)} ${props.unit} · 共 ${props.total} ${props.unit}`
})
/** Page numbers with `null` for each gap: 1, the current page and two either side, the last. */
const numbers = computed(() => {
  const shown = new Set([1, pages.value])
  for (let n = props.page - 2; n <= props.page + 2; n++) if (n >= 1 && n <= pages.value) shown.add(n)
  const list: (number | null)[] = []
  let last = 0
  for (const n of [...shown].sort((a, b) => a - b)) {
    if (n - last > 1) list.push(null)
    list.push(n)
    last = n
  }
  return list
})
const go = (page: number) => {
  if (!props.disabled && page >= 1 && page <= pages.value && page !== props.page) emit('go', page)
}
</script>

<template>
  <div class="card-footer d-flex flex-wrap align-items-center gap-2">
    <p class="m-0 text-secondary">{{ info }}</p>
    <ul class="pagination m-0 ms-auto" :aria-label="label">
      <li :class="['page-item', page <= 1 && 'disabled']">
        <button type="button" class="page-link" :disabled="disabled || page <= 1" aria-label="上一页" @click="go(page - 1)">‹</button>
      </li>
      <template v-for="(n, index) in numbers" :key="n ?? `gap-${index}`">
        <li v-if="n === null" class="page-item disabled"><span class="page-link">…</span></li>
        <li v-else :class="['page-item', n === page && 'active']">
          <button type="button" class="page-link" :disabled="disabled" :aria-label="`第 ${n} 页`" :aria-current="n === page ? 'page' : undefined" @click="go(n)">{{ n }}</button>
        </li>
      </template>
      <li :class="['page-item', page >= pages && 'disabled']">
        <button type="button" class="page-link" :disabled="disabled || page >= pages" aria-label="下一页" @click="go(page + 1)">›</button>
      </li>
    </ul>
    <label class="d-flex align-items-center gap-2 text-secondary text-nowrap">
      每页<select class="form-select form-select-sm w-auto" :value="String(pageSize)" :disabled="disabled" :aria-label="sizeLabel || `每页${sizeUnit || unit}数`" @change="emit('size', Number(($event.target as HTMLSelectElement).value))">
        <option v-for="size in sizes" :key="size" :value="String(size)">{{ size }}</option>
      </select>{{ sizeUnit || unit }}
    </label>
  </div>
</template>
