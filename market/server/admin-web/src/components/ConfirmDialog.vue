<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import ModalDialog from './ModalDialog.vue'
import { pendingConfirm, settleConfirm } from '../confirm'

const cancel = ref<HTMLButtonElement>()
watch(
  () => pendingConfirm.open,
  async (open) => {
    if (!open) return
    await nextTick()
    cancel.value?.focus()
  },
)
</script>

<template>
  <ModalDialog :open="pendingConfirm.open" labelledby="confirm-title" describedby="confirm-text" @close="(value) => settleConfirm(value === 'ok')">
    <form method="dialog" class="modal-content">
      <div :class="['modal-status', pendingConfirm.danger ? 'bg-danger' : 'bg-primary']"></div>
      <div class="modal-body">
        <h2 id="confirm-title" class="h3 text-break">{{ pendingConfirm.title }}</h2>
        <p id="confirm-text" class="text-secondary mb-0 text-break">{{ pendingConfirm.text }}</p>
      </div>
      <div class="modal-footer">
        <button ref="cancel" value="cancel" type="submit" class="btn">取消</button>
        <button value="ok" type="submit" :class="['btn', pendingConfirm.danger ? 'btn-danger' : 'btn-primary']">{{ pendingConfirm.ok }}</button>
      </div>
    </form>
  </ModalDialog>
</template>
