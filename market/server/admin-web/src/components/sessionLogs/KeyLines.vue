<script setup lang="ts">
/** A Key in full when the server kept it (sealed), else only its fingerprint; its note above it. */
defineProps<{ item: { key?: string | null; fingerprint: string; label?: string | null } }>()
</script>

<template>
  <div v-if="item.label">{{ item.label }}</div>
  <div v-if="item.key" class="font-monospace small text-break user-select-all">{{ item.key }}</div>
  <div v-else class="font-monospace small text-secondary">未保存原文 · 指纹 {{ (item.fingerprint || '').slice(0, 16) }}</div>
</template>
