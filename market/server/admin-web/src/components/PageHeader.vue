<script setup lang="ts">
/** A page's header, as at /admin/: 「插件市场」, the title and what the page is for, its actions right. */
defineProps<{ title: string; description: string }>()
</script>

<template>
  <div class="page-header d-print-none">
    <div class="container-fluid">
      <div class="row g-2 align-items-center">
        <div class="col">
          <div class="page-pretitle">插件市场</div>
          <div class="d-flex flex-wrap align-items-center gap-2">
            <h2 class="page-title">{{ title }}</h2>
            <slot name="badge" />
          </div>
          <div class="text-secondary mt-1">{{ description }}</div>
        </div>
        <div v-if="$slots.actions" class="col-12 col-md-auto ms-auto d-print-none">
          <div class="btn-list"><slot name="actions" /></div>
        </div>
      </div>
    </div>
  </div>
</template>
