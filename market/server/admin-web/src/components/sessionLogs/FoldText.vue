<script setup lang="ts">
import { computed, ref } from 'vue'

/**
 * Text that may be long: its first `lines` lines (or nothing, with lines 0) and a toggle that builds
 * the full text only when asked for, so a large session stays responsive. Short text is shown whole.
 */
const props = withDefaults(defineProps<{ text: string; lines?: number; code?: boolean; label?: string; className?: string }>(), {
  lines: 3, code: false, label: '展开', className: '',
})
const open = ref(false)
const built = ref(false)
const all = computed(() => props.text.split('\n'))
const short = computed(() => all.value.length <= Math.max(props.lines, 1) && props.text.length <= 600)
const textClass = computed(() => ['log-text', props.code && 'log-code'])
const count = computed(() => `${props.label}（${all.value.length} 行 · ${props.text.length.toLocaleString('zh-CN')} 字符）`)
function toggle() {
  open.value = !open.value
  if (open.value) built.value = true
}
</script>

<template>
  <div :class="['log-fold', className, open && 'open']">
    <pre v-if="lines && short" :class="textClass">{{ text }}</pre>
    <template v-else>
      <pre v-if="lines" v-show="!open" :class="[textClass, 'log-preview']">{{ all.slice(0, lines).join('\n').slice(0, 400) + '…' }}</pre>
      <pre v-if="built" v-show="open" :class="[textClass, 'log-full']">{{ text }}</pre>
      <button type="button" class="btn btn-sm log-toggle" @click="toggle">{{ open ? '收起' : count }}</button>
    </template>
  </div>
</template>
