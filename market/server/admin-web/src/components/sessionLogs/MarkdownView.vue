<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { renderMarkdown } from '../../../../admin/assets/market-markdown.js'

/**
 * A final answer as Markdown, through the same renderer as the docs center (market-markdown.js):
 * it builds elements and text nodes only, never HTML from the text, so user content stays text.
 */
const props = defineProps<{ text: string }>()
const box = ref<HTMLDivElement>()
function draw() {
  box.value?.replaceChildren(renderMarkdown(props.text))
}
onMounted(draw)
watch(() => props.text, draw)
</script>

<template>
  <div ref="box" class="log-md"></div>
</template>
