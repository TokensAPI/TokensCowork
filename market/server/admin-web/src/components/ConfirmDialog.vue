<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import ModalDialog from './ModalDialog.vue'
import { pendingConfirm, settleConfirm } from '../confirm'

const cancel = ref<HTMLButtonElement>()
const keep = ref<HTMLButtonElement>()
watch(
  () => pendingConfirm.open,
  async (open) => {
    if (!open) return
    await nextTick()
    ;(pendingConfirm.discard ? keep : cancel).value?.focus()
  },
)
</script>

<template>
  <ModalDialog :open="pendingConfirm.open" labelledby="confirm-title" describedby="confirm-text" :size="pendingConfirm.discard ? 'sm' : ''" @close="(value) => settleConfirm(value === 'ok')">
    <form v-if="pendingConfirm.discard" method="dialog" class="modal-content">
      <div class="modal-status bg-warning"></div>
      <div class="modal-body">
        <h2 id="confirm-title" class="h3">{{ pendingConfirm.title }}</h2>
        <p id="confirm-text" class="text-secondary mb-0">{{ pendingConfirm.text }}</p>
      </div>
      <div class="modal-footer">
        <button value="ok" type="submit" class="btn btn-outline-danger">{{ pendingConfirm.ok }}</button>
        <button ref="keep" value="cancel" type="submit" class="btn btn-primary">继续编辑</button>
      </div>
    </form>
    <form v-else method="dialog" class="modal-content">
      <div :class="['modal-status', pendingConfirm.danger ? 'bg-danger' : 'bg-primary']"></div>
      <div class="modal-body">
        <h2 id="confirm-title" class="h3 text-break">{{ pendingConfirm.title }}</h2>
        <p id="confirm-text" :class="['text-secondary', 'text-break', !pendingConfirm.items.length && !pendingConfirm.note && 'mb-0']">{{ pendingConfirm.text }}</p>
        <ul v-if="pendingConfirm.items.length" class="log-confirm-list">
          <li v-for="(item, index) in pendingConfirm.items" :key="index">{{ item }}</li>
          <li v-if="pendingConfirm.more" class="text-secondary">…以及另外 {{ pendingConfirm.more }} 个</li>
        </ul>
        <p v-if="pendingConfirm.note" class="text-secondary small mb-0">{{ pendingConfirm.note }}</p>
      </div>
      <div class="modal-footer">
        <button ref="cancel" value="cancel" type="submit" class="btn">取消</button>
        <button value="ok" type="submit" :class="['btn', pendingConfirm.danger ? 'btn-danger' : 'btn-primary']">{{ pendingConfirm.ok }}</button>
      </div>
    </form>
  </ModalDialog>
</template>
