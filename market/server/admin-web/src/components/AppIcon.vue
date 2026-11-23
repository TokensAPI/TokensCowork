<script setup lang="ts">
/** A Tabler icon (outline, 24 x 24), drawn from its path list; decorative, so hidden from readers. */
defineProps<{ paths: string[] }>()
</script>

<template>
  <svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path v-for="path in paths" :key="path" :d="path" />
  </svg>
</template>
