<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * Tabler's modal on a native <dialog>, as everywhere at /admin/: showModal() gives the top layer,
 * the focus trap and Esc. `open` drives it; every way of closing (Esc, the X, a form with
 * method="dialog") ends in `close`. While `locked` (a save in flight) Esc does nothing.
 */
const props = withDefaults(defineProps<{ open: boolean; labelledby: string; describedby?: string; size?: '' | 'sm' | 'lg' | 'xl'; scrollable?: boolean; locked?: boolean }>(), {
  describedby: undefined, size: '', scrollable: false, locked: false,
})
const emit = defineEmits<{ close: [returnValue: string] }>()
const dialog = ref<HTMLDialogElement>()

function sync() {
  const el = dialog.value
  if (!el) return
  if (props.open && !el.open) {
    el.returnValue = ''
    el.showModal()
  } else if (!props.open && el.open) el.close()
}
watch(() => props.open, sync)
onMounted(sync)
onBeforeUnmount(() => dialog.value?.open && dialog.value.close())

// Esc asks the page to close (it may keep the dialog open: a save in flight, or edits it asks about
// first); the dialog itself closes only when `open` turns false.
function onCancel(event: Event) {
  event.preventDefault()
  if (!props.locked) emit('close', '')
}
function onClose() {
  if (props.open) emit('close', dialog.value?.returnValue ?? '')
}
</script>

<template>
  <dialog ref="dialog" class="modal" :aria-labelledby="labelledby" :aria-describedby="describedby" @cancel="onCancel" @close="onClose">
    <div :class="['modal-dialog', 'modal-dialog-centered', size && `modal-${size}`, scrollable && 'modal-dialog-scrollable']">
      <slot />
    </div>
  </dialog>
</template>
