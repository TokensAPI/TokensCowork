<script setup lang="ts" generic="T extends string | number">
import { computed, ref } from 'vue'

/**
 * One searchable checklist of the access dialog (organizations, Keys or users): the heading with how
 * many are ticked, a search box, and the list. Searching only narrows what is shown; ticked items
 * stay ticked. `chosen` is the dialog's own set, changed in place.
 */
const props = defineProps<{ title: string; options: { value: T; text: string; note?: string }[]; chosen: Set<T>; placeholder: string; searchLabel: string; empty: string }>()
const query = ref('')
const visible = computed(() => {
  const term = query.value.trim().toLowerCase()
  return props.options.filter((item) => item.text.toLowerCase().includes(term))
})
function toggle(value: T, on: boolean) {
  if (on) props.chosen.add(value)
  else props.chosen.delete(value)
}
</script>

<template>
  <div class="d-flex align-items-center mb-2"><h3 class="h4 m-0">{{ title }}</h3><span class="ms-auto text-secondary">已选 {{ chosen.size }} 个</span></div>
  <input v-model="query" class="form-control mb-2" type="search" :placeholder="placeholder" :aria-label="searchLabel" />
  <div class="list-group grant-list">
    <label v-for="item in visible" :key="item.value" class="list-group-item d-flex align-items-center gap-2">
      <input type="checkbox" class="form-check-input m-0" :checked="chosen.has(item.value)" @change="toggle(item.value, ($event.target as HTMLInputElement).checked)" />
      <span class="text-break">{{ item.text }}</span>
      <span v-if="item.note" class="badge bg-yellow-lt">{{ item.note }}</span>
    </label>
    <div v-if="!visible.length" class="list-group-item text-secondary">{{ options.length ? '没有匹配项，已选项仍保留。' : empty }}</div>
  </div>
</template>
