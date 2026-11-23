<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { notify, toast } from '../feedback'

/**
 * The toast, in the top layer (popover) so it shows above an open dialog, bottom right -- the same
 * element and classes as /admin/'s #message.
 */
const box = ref<HTMLOutputElement>()
watch(
  () => toast.serial,
  async () => {
    await nextTick()
    const el = box.value as (HTMLOutputElement & { showPopover?: () => void; hidePopover?: () => void }) | undefined
    if (!el) return
    try {
      el.hidePopover?.()
      if (toast.message) el.showPopover?.()
    } catch {}
  },
)
</script>

<template>
  <output
    id="message"
    ref="box"
    popover="manual"
    :hidden="!toast.message"
    :class="['alert', 'alert-important', 'alert-dismissible', toast.kind === 'error' ? 'alert-danger' : 'alert-success']"
    :role="toast.kind === 'error' ? 'alert' : 'status'"
    aria-live="polite"
  >
    <div>{{ toast.message }}</div>
    <button class="btn-close" type="button" aria-label="关闭提示" @click="notify()"></button>
  </output>
</template>
