<script setup lang="ts">
/**
 * A list page's card, in Tabler's markup: a table that scrolls sideways inside the card on a
 * narrow screen, its empty state, and a footer (a note, or a DataPager). While a read is in flight
 * a thin bar runs along the top and the rows dim, but stay; the first read shows 「正在加载…」. A
 * read that failed with nothing to show says so, with 重试.
 */
withDefaults(defineProps<{ loading?: boolean; ready?: boolean; error?: string; count: number; emptyTitle: string; emptySubtitle?: string }>(), {
  loading: false, ready: true, error: '', emptySubtitle: '',
})
const emit = defineEmits<{ retry: [] }>()
</script>

<template>
  <div class="card">
    <slot name="toolbar" />
    <div v-if="loading && ready" class="progress progress-sm rounded-0 list-loading" aria-hidden="true"><div class="progress-bar progress-bar-indeterminate"></div></div>
    <div v-show="count > 0" class="table-responsive" :aria-busy="loading || undefined">
      <table class="table card-table table-vcenter">
        <thead>
          <tr><slot name="head" /></tr>
        </thead>
        <tbody><slot /></tbody>
      </table>
    </div>
    <div v-if="!ready && loading" class="empty" role="status">
      <p class="empty-title text-secondary">正在加载…</p>
    </div>
    <div v-else-if="error && count === 0" class="empty" role="alert">
      <p class="empty-title">加载失败</p>
      <p class="empty-subtitle text-secondary text-break">{{ error }}</p>
      <div class="empty-action"><button type="button" class="btn" @click="emit('retry')">重试</button></div>
    </div>
    <div v-else-if="ready && count === 0" class="empty">
      <p class="empty-title">{{ emptyTitle }}</p>
      <p v-if="emptySubtitle" class="empty-subtitle text-secondary">{{ emptySubtitle }}</p>
    </div>
    <slot name="footer" />
  </div>
</template>
