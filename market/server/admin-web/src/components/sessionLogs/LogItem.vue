<script setup lang="ts">
import { computed, ref } from 'vue'
import FoldText from './FoldText.vue'
import { argumentSummary, contextLabel, pretty, type LogItem } from './replay'
import { formatTime } from '../../shell'

/**
 * One entry of a turn: what the user typed,
 * injected context, a model step, a tool call with its result, a note, or an internal / unknown
 * event. Long content is built only when unfolded. 「JSON」 shows the raw events behind it.
 */
const props = defineProps<{ item: LogItem; answer?: LogItem | null; delegated?: boolean; childBusy?: boolean }>()
const emit = defineEmits<{ json: [value: unknown]; child: [id: string] }>()

const time = (value?: number | null) => (value ? formatTime(value) : '—')
const number = (value?: number) => Number(value || 0).toLocaleString('zh-CN')
const at = computed(() => time(props.item.events[0]?.time))
const showJson = () => emit('json', props.item.events.length === 1 ? props.item.events[0] : props.item.events)

const contextOpen = ref(false)
const contextLabels = computed(() => [...new Set((props.item.kinds ?? []).map(contextLabel))].join('、'))
const contextText = (index: number) => {
  const data = props.item.events[index]?.data as { content?: unknown } | undefined
  return ([data?.content].flat() as ({ text?: string } | undefined)[]).map((part) => part?.text ?? '').join('\n') || pretty(data)
}
const usageFacts = computed(() => {
  const usage = props.item.usage
  if (!usage) return ''
  return [
    usage.input ? `输入 ${number(usage.input)}` : '', usage.output ? `输出 ${number(usage.output)}` : '',
    usage.cacheRead ? `缓存读 ${number(usage.cacheRead)}` : '', usage.cacheWrite ? `缓存写 ${number(usage.cacheWrite)}` : '',
    usage.total ? `共 ${number(usage.total)} token` : '', props.item.interrupted ? '已中断' : '',
  ].filter(Boolean).join(' · ')
})
const event = computed(() => props.item.events[0])
</script>

<template>
  <div v-if="item.kind === 'user'" class="log-block log-user">
    <div class="log-block-head">
      <span class="log-role user">{{ delegated ? '委派任务' : '用户' }}</span>
      <time class="text-secondary log-time">{{ at }}</time><button type="button" class="btn btn-sm log-json" @click="showJson">JSON</button>
    </div>
    <FoldText v-if="(item.text ?? '').length > 4000" :text="item.text ?? ''" :lines="20" />
    <pre v-else class="log-text">{{ item.text }}</pre>
  </div>

  <div v-else-if="item.kind === 'context'" class="log-block log-context">
    <div class="log-block-head">
      <span class="log-role context">上下文</span><span class="text-secondary">{{ contextLabels }} · {{ item.events.length }} 条 · 系统注入</span>
      <time class="text-secondary log-time">{{ at }}</time><button type="button" class="btn btn-sm log-json" @click="showJson">JSON</button>
    </div>
    <button type="button" class="btn btn-sm log-toggle" @click="contextOpen = !contextOpen">{{ contextOpen ? '收起' : '展开' }}</button>
    <div v-if="contextOpen" class="log-context-list">
      <template v-for="(_, index) in item.events" :key="index">
        <div class="text-secondary">{{ contextLabel(item.kinds?.[index]) }}</div>
        <FoldText :text="contextText(index)" :lines="4" code />
      </template>
    </div>
  </div>

  <div v-else-if="item.kind === 'model'" class="log-block log-model">
    <div class="log-block-head">
      <span class="log-role model">模型</span>
      <span v-if="item.model" class="text-secondary">{{ item.model }}</span><span v-if="item.step !== null && item.step !== undefined" class="text-secondary">第 {{ item.step }} 步</span>
      <time class="text-secondary log-time">{{ at }}</time><button type="button" class="btn btn-sm log-json" @click="showJson">JSON</button>
    </div>
    <FoldText v-if="item.reasoning" :text="item.reasoning" :lines="2" label="思考" class-name="log-reasoning" />
    <p v-if="item === answer" class="text-secondary">（这一步的回答显示在下方）</p>
    <template v-else-if="item.text">
      <FoldText v-if="item.text.length > 6000" :text="item.text" :lines="30" />
      <pre v-else class="log-text">{{ item.text }}</pre>
    </template>
    <p v-if="!item.reasoning && !item.text" class="text-secondary">（这一步只调用了工具）</p>
    <p v-if="usageFacts" class="text-secondary log-usage">{{ usageFacts }}</p>
  </div>

  <div v-else-if="item.kind === 'tool'" class="log-block log-tool">
    <div class="log-block-head">
      <span class="log-role tool">工具</span><strong>{{ item.name }}</strong><span v-if="item.result?.error" class="badge bg-red-lt">出错</span>
      <time class="text-secondary log-time">{{ at }}</time><button type="button" class="btn btn-sm log-json" @click="showJson">JSON</button>
    </div>
    <template v-if="item.arguments !== null">
      <div class="log-args log-code">{{ argumentSummary(item.arguments) || '（无参数）' }}</div>
      <FoldText v-if="item.arguments !== '' && item.arguments !== '{}'" :text="pretty(item.arguments)" :lines="0" code label="完整参数" />
    </template>
    <p v-if="!item.result" class="text-secondary">没有收到结果</p>
    <template v-else>
      <div class="text-secondary log-result-label">结果</div>
      <FoldText :text="item.result.text || pretty(item.result.meta ?? {})" :lines="3" code label="展开结果" />
    </template>
  </div>

  <div v-else-if="item.kind === 'note' && item.detail" class="log-note-box">
    <div :class="['log-note', item.tone]">
      <span class="log-note-text">{{ item.text }}</span><time class="text-secondary log-time">{{ at }}</time>
      <button v-if="item.childId" type="button" :class="['btn', 'btn-sm', 'log-toggle', childBusy && 'btn-loading']" :disabled="childBusy" @click="emit('child', item.childId)">打开子会话</button>
      <button type="button" class="btn btn-sm log-json" @click="showJson">JSON</button>
    </div>
    <FoldText :text="item.detail" :lines="0" />
  </div>
  <div v-else-if="item.kind === 'note'" :class="['log-note', item.tone]">
    <span class="log-note-text">{{ item.text }}</span><time class="text-secondary log-time">{{ at }}</time>
    <button v-if="item.childId" type="button" :class="['btn', 'btn-sm', 'log-toggle', childBusy && 'btn-loading']" :disabled="childBusy" @click="emit('child', item.childId)">打开子会话</button>
    <button type="button" class="btn btn-sm log-json" @click="showJson">JSON</button>
  </div>

  <div v-else-if="item.missing || item.kind === 'internal'" :class="['log-note', item.kind === 'internal' ? 'log-internal' : 'log-other']">
    <span class="log-note-text">{{ item.missing ? `原文缺失 · ${event?.type} #${event?.seq}` : `内部 · ${event?.type} #${event?.seq}` }}</span>
    <time class="text-secondary log-time">{{ time(event?.time) }}</time><button type="button" class="btn btn-sm log-json" @click="showJson">JSON</button>
  </div>
  <div v-else class="log-note-box">
    <div class="log-note log-other">
      <span class="log-note-text">其他 · {{ event?.type }} #{{ event?.seq }}</span>
      <time class="text-secondary log-time">{{ time(event?.time) }}</time><button type="button" class="btn btn-sm log-json" @click="showJson">JSON</button>
    </div>
    <FoldText :text="pretty(event?.data ?? {})" :lines="0" code />
  </div>
</template>
