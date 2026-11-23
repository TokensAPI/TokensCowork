<script setup lang="ts">
import { ref, watch } from 'vue'

/**
 * A plugin's icon where it has one (the address the catalog and the docs center use), else its
 * first character; an image that fails to load falls back to the character too.
 */
const props = defineProps<{ name: string; icon?: string | null }>()
const failed = ref(false)
watch(() => props.icon, () => (failed.value = false))
</script>

<template>
  <span class="avatar rounded">
    <img v-if="icon && !failed" :src="icon" alt="" @error="failed = true" />
    <template v-else>{{ name.slice(0, 1) }}</template>
  </span>
</template>
