<script setup lang="ts">
import ModalDialog from './ModalDialog.vue'

/**
 * A dialog that edits something and saves it, in Tabler's markup: the header (title, with a kicker
 * above it or a subtitle under it, and the X), the fields, the error line, and the save button.
 * While `pending` its controls are disabled, the save button spins and it cannot be closed; the page
 * decides when it closes (on success) and whether a close with unsaved edits asks first.
 */
withDefaults(
  defineProps<{
    open: boolean
    id: string
    title: string
    kicker?: string
    subtitle?: string
    closeLabel: string
    pending?: boolean
    error?: string
    errorClass?: string
    submitLabel?: string
    submitClass?: string
    submitDisabled?: boolean
    status?: string
    size?: '' | 'sm' | 'lg'
    scrollable?: boolean
  }>(),
  {
    kicker: '', subtitle: '', pending: false, error: '', errorClass: 'mt-3', submitLabel: '保存', submitClass: 'btn-primary', submitDisabled: false,
    status: '', size: '', scrollable: false,
  },
)
const emit = defineEmits<{ submit: []; close: [] }>()
</script>

<template>
  <ModalDialog :open="open" :labelledby="`${id}-title`" :size="size" :scrollable="scrollable" :locked="pending" @close="emit('close')">
    <form class="modal-content" :aria-busy="pending || undefined" @submit.prevent="pending || emit('submit')">
      <div v-if="status" :class="['modal-status', status]"></div>
      <div class="modal-header">
        <div v-if="kicker || subtitle" class="min-w-0">
          <div v-if="kicker" class="text-secondary small">{{ kicker }}</div>
          <h2 :id="`${id}-title`" class="modal-title text-break">{{ title }}</h2>
          <div v-if="subtitle" class="text-secondary small text-break">{{ subtitle }}</div>
        </div>
        <h2 v-else :id="`${id}-title`" class="modal-title text-break">{{ title }}</h2>
        <button class="btn-close" type="button" :aria-label="closeLabel" :disabled="pending" @click="emit('close')"></button>
      </div>
      <fieldset class="modal-body" :disabled="pending">
        <slot />
        <output :class="['d-block', 'text-danger', errorClass]" role="alert">{{ error }}</output>
      </fieldset>
      <div class="modal-footer">
        <slot name="footer" />
        <button :class="['btn', submitClass, pending && 'btn-loading']" type="submit" :disabled="pending || submitDisabled">{{ submitLabel }}</button>
      </div>
    </form>
  </ModalDialog>
</template>
