/**
 * The conversation view's model, read from the shared replay module (market-session-log-replay.js,
 * DOM-free and tested on its own): the shapes it produces, typed for the components.
 */
import * as replay from '../../../../admin/assets/market-session-log-replay.js'
import type { SessionEvent } from '../../sessionLogs'

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}
export interface LogItem {
  kind: 'user' | 'context' | 'model' | 'tool' | 'note' | 'internal' | 'other'
  events: SessionEvent[]
  text?: string
  kinds?: (string | null)[]
  step?: number | null
  model?: string
  reasoning?: string
  usage?: Usage
  interrupted?: boolean
  name?: string
  arguments?: unknown
  result?: { text: string; error: boolean; meta: unknown } | null
  detail?: string
  tone?: string
  childId?: string | null
  missing?: boolean
}
export interface TurnGroup {
  turn: number | null
  startedAt?: number | null
  endedAt?: number | null
  reason?: { kind?: string } | null
  items: LogItem[]
}
export interface Overview {
  settings: Record<string, string | null>
  systemPrompts: string[]
  descriptor: { label?: string; mode?: string; agentProvider?: string; agentModel?: string } | null
}

export const groupConversation = replay.groupConversation as unknown as (events: SessionEvent[]) => { overview: Overview; opening: TurnGroup; turns: TurnGroup[] }
export const splitTurn = replay.splitTurn as unknown as (group: TurnGroup) => { users: LogItem[]; answer: LogItem | null; process: LogItem[]; ending: string | null }
export const processSummary = replay.processSummary as unknown as (group: TurnGroup, process: LogItem[]) => string
export const turnEnding = replay.turnEnding as unknown as (reason: TurnGroup['reason']) => string
export const durationText = replay.durationText as (ms: number) => string
export const contextLabel = replay.contextLabel as (kind: string | null | undefined) => string
export const argumentSummary = replay.argumentSummary as (value: unknown, length?: number) => string
export const rawDocument = replay.rawDocument as (header: unknown, events: SessionEvent[], formatVersion: number, id: string) => string

/** JSON as people read it: a string that holds JSON is parsed and indented, anything else stays. */
export function pretty(value: unknown): string {
  if (typeof value !== 'string') return JSON.stringify(value, null, 2) ?? ''
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}
