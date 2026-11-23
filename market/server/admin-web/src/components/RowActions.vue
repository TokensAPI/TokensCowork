<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue'

/**
 * A row's actions, as at /admin/: one button, then 「更多」 with the rest. The menu is Tabler's
 * dropdown, opened here rather than by Bootstrap's script, and placed `fixed` under its toggle so a
 * scrolling table never clips it (above the toggle when there is no room below), following it when
 * the page scrolls or resizes. Esc or a click elsewhere closes it. `name` labels each control for assistive technology.
 */
export interface RowAction {
  label: string
  run: () => void
  danger?: boolean
}
const props = withDefaults(defineProps<{ name: string; primary?: RowAction | null; more?: (RowAction | 'divider')[]; disabled?: boolean }>(), {
  primary: null, more: () => [], disabled: false,
})

const open = ref(false)
const toggle = ref<HTMLButtonElement>()
const menu = ref<HTMLDivElement>()
const place = ref<Record<string, string>>({})

function onOutside(event: Event) {
  const target = event.target as Node | null
  if (target && (toggle.value?.contains(target) || menu.value?.contains(target))) return
  close()
}
function onKey(event: Event) {
  if ((event as KeyboardEvent).key !== 'Escape') return
  close()
  toggle.value?.focus()
}
function listen(on: boolean) {
  const method = on ? 'addEventListener' : 'removeEventListener'
  document[method]('pointerdown', onOutside, true)
  document[method]('keydown', onKey)
  window[method]('scroll', position, true)
  window[method]('resize', position)
}
/** Under the toggle, its right edges aligned; above it when the window has no room below. */
function position() {
  const button = toggle.value
  if (!button || !open.value) return
  const rect = button.getBoundingClientRect()
  const height = menu.value?.offsetHeight ?? 0
  const width = menu.value?.offsetWidth ?? 0
  const below = rect.bottom + 2
  const top = below + height > window.innerHeight && rect.top - 2 - height >= 0 ? rect.top - 2 - height : below
  place.value = { position: 'fixed', inset: 'auto', top: `${top}px`, left: `${Math.max(4, rect.right - width)}px` }
}
async function show() {
  // As Bootstrap does: the toggle takes the focus, which also scrolls it into view in a narrow table.
  toggle.value?.focus()
  open.value = true
  listen(true)
  position()
  // Measured once drawn, so the room check knows the menu's height.
  await nextTick()
  position()
}
function close() {
  if (!open.value) return
  open.value = false
  listen(false)
}
function pick(action: RowAction) {
  close()
  if (!props.disabled) action.run()
}
onBeforeUnmount(close)
</script>

<template>
  <div class="btn-list flex-nowrap justify-content-end">
    <button v-if="primary" type="button" :class="['btn']" :disabled="disabled" :aria-label="`${name} ${primary.label}`" @click="pick(primary)">{{ primary.label }}</button>
    <div v-if="more.length" class="dropdown">
      <button
        ref="toggle"
        type="button"
        :class="['btn', 'dropdown-toggle', open && 'show']"
        :disabled="disabled"
        :aria-expanded="open ? 'true' : 'false'"
        :aria-label="`${name} 更多操作`"
        @click="open ? close() : show()"
      >
        更多
      </button>
      <div ref="menu" :class="['dropdown-menu', 'dropdown-menu-end', open && 'show']" :style="open ? place : undefined">
        <template v-for="(item, index) in more" :key="item === 'divider' ? `divider-${index}` : item.label">
          <div v-if="item === 'divider'" class="dropdown-divider"></div>
          <button v-else type="button" :class="['dropdown-item', item.danger && 'text-danger']" :aria-label="`${name} ${item.label}`" @click="pick(item)">
            {{ item.label }}
          </button>
        </template>
      </div>
    </div>
  </div>
</template>
