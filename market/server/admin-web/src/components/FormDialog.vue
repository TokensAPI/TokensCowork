<script setup lang="ts">
import ModalDialog from './ModalDialog.vue'

/**
 * A dialog that edits something and saves it: header (title, optional kicker above it, the X),
 * the fields, the error line, and 保存. While `pending` its controls are disabled, the save button
 * spins, and it cannot be closed; the page decides when it closes (on success).
 */
withDefaults(defineProps<{ open: boolean; id: string; title: string; kicker?: string; closeLabel: string; pending?: boolean; error?: string; submitLabel?: string; scrollable?: boolean }>(), {
  kicker: '', pending: false, error: '', submitLabel: '保存', scrollable: false,
})
const emit = defineEmits<{ submit: []; close: [] }>()
</script>

<template>
  <ModalDialog :open="open" :labelledby="`${id}-title`" :scrollable="scrollable" :locked="pending" @close="emit('close')">
    <form class="modal-content" :aria-busy="pending || undefined" @submit.prevent="pending || emit('submit')">
      <div class="modal-header">
        <div v-if="kicker" class="min-w-0">
          <div class="text-secondary small">{{ kicker }}</div>
          <h2 :id="`${id}-title`" class="modal-title text-break">{{ title }}</h2>
        </div>
        <h2 v-else :id="`${id}-title`" class="modal-title">{{ title }}</h2>
        <button class="btn-close" type="button" :aria-label="closeLabel" :disabled="pending" @click="emit('close')"></button>
      </div>
      <fieldset class="modal-body" :disabled="pending">
        <slot />
        <output class="d-block text-danger mt-3" role="alert">{{ error }}</output>
      </fieldset>
      <div class="modal-footer">
        <slot name="footer" />
        <button :class="['btn', 'btn-primary', pending && 'btn-loading']" type="submit" :disabled="pending">{{ submitLabel }}</button>
      </div>
    </form>
  </ModalDialog>
</template>
