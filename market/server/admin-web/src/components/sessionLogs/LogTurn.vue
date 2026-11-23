<script setup lang="ts">
import { computed } from 'vue'
import LogItem from './LogItem.vue'
import MarkdownView from './MarkdownView.vue'
import { durationText, processSummary, splitTurn, turnEnding, type TurnGroup } from './replay'
import { formatTime } from '../../shell'

/**
 * One turn: what the person typed → one fold holding everything in between (closed
 * by default, built only when opened) → the turn's last answer as Markdown, then a grey line for how
 * the turn ended unless it simply completed. The internal-events switch only changes what is inside
 * the fold. `open` is kept by the detail page, so 「全部展开 / 全部收起」 and re-renders keep it.
 */
const props = defineProps<{ group: TurnGroup; showInternal: boolean; open: boolean; delegated: boolean; childBusy: boolean }>()
const emit = defineEmits<{ toggle: [open: boolean]; json: [value: unknown]; child: [id: string] }>()

const time = (value?: number | null) => (value ? formatTime(value) : '—')
const parts = computed(() => splitTurn(props.group))
const visible = computed(() => parts.value.process.filter((item) => props.showInternal || item.kind !== 'internal'))
const shown = computed(() => props.group.turn !== null || parts.value.users.length > 0 || visible.value.length > 0)
const summary = computed(() => processSummary(props.group, parts.value.process))
const spent = computed(() => (props.group.endedAt && props.group.startedAt ? durationText(props.group.endedAt - props.group.startedAt) : ''))
function onToggle(event: Event) {
  const open = (event.target as HTMLDetailsElement).open
  if (open !== props.open) emit('toggle', open)
}
</script>

<template>
  <section v-if="shown" class="log-turn">
    <div class="log-turn-head">
      <h3 v-if="group.turn === null">会话开始</h3>
      <template v-else>
        <h3>第 {{ group.turn }} 轮</h3>
        <span class="text-secondary">{{ time(group.startedAt) }}</span>
        <span v-if="group.endedAt && group.startedAt" class="text-secondary">用时 {{ spent }}</span>
        <span :class="['badge', group.reason?.kind === 'completed' ? 'bg-green-lt' : 'bg-yellow-lt']">{{ turnEnding(group.reason) }}</span>
      </template>
    </div>
    <LogItem v-for="(item, index) in parts.users" :key="`user-${index}`" :item="item" :delegated="delegated" @json="emit('json', $event)" />
    <details v-if="parts.process.length" class="log-process" :data-turn="group.turn ?? 'opening'" :open="open" @toggle="onToggle">
      <summary>{{ summary }}</summary>
      <div class="log-process-body">
        <template v-if="open">
          <template v-if="visible.length">
            <LogItem
              v-for="(item, index) in visible"
              :key="index"
              :item="item"
              :answer="parts.answer"
              :delegated="delegated"
              :child-busy="childBusy"
              @json="emit('json', $event)"
              @child="emit('child', $event)"
            />
          </template>
          <p v-else class="text-secondary">这里只有内部事件，打开「显示内部事件」可以查看。</p>
        </template>
      </div>
    </details>
    <div v-if="parts.answer" class="log-block log-model log-answer">
      <div class="log-block-head">
        <span class="log-role model log-answer">回答</span><span v-if="parts.answer.model" class="text-secondary">{{ parts.answer.model }}</span>
        <time class="text-secondary log-time">{{ time(parts.answer.events[0]?.time) }}</time>
        <button type="button" class="btn btn-sm log-json" @click="emit('json', parts.answer.events.length === 1 ? parts.answer.events[0] : parts.answer.events)">JSON</button>
      </div>
      <MarkdownView :text="parts.answer.text ?? ''" />
    </div>
    <p v-if="parts.ending && group.turn !== null" class="log-no-answer">{{ parts.ending }}</p>
  </section>
</template>
