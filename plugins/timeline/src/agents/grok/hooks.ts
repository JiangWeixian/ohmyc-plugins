import { eventKey } from '../../shared/collectors/identity'
import type { CollectorEvent } from '../../shared/collectors/types'

type Payload = Record<string, unknown>
type SemanticEvent = Omit<CollectorEvent, 'eventId' | 'observedAt'>

const compatibilityEvents: Record<string, string> = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  PostToolUse: 'post_tool_use',
  PostToolUseFailure: 'post_tool_use_failure',
  Stop: 'stop',
  StopFailure: 'stop_failure',
  StopCancelled: 'stop_cancelled',
  SessionEnd: 'session_end',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
}

const lifecycle = new Set(['stop', 'stop_failure', 'stop_cancelled', 'session_end'])
const confirms = new Set([
  'post_tool_use', 'post_tool_use_failure', 'stop', 'stop_failure', 'stop_cancelled',
])

function object(value: unknown): Payload | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Payload
    : null
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function sourceTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function createEvent(
  semantic: SemanticEvent,
  observedAt: number,
  identity: Record<string, unknown> = {},
): CollectorEvent {
  return {
    ...semantic,
    eventId: eventKey({ ...semantic, ...identity }),
    observedAt,
  }
}

export function parseGrokHook(input: unknown, observedAt: number): CollectorEvent[] {
  const payload = object(input)
  if (!payload || !Number.isFinite(observedAt)) return []
  const nativeSessionId = text(payload.sessionId)
  const nativeHook = text(payload.hookEventName)
  const hook = nativeHook ?? compatibilityEvents[text(payload.hook_event_name) ?? '']
  if (!nativeSessionId || !hook) return []

  const promptId = text(payload.promptId)
  const subagentType = text(payload.subagentType)
  const isSubagentStart = hook === 'subagent_start'
  const child = subagentType !== undefined && !isSubagentStart
  const base: SemanticEvent = {
    version: 1,
    agent: 'grok',
    nativeSessionId,
    turnId: promptId,
    sourceAt: sourceTime(payload.timestamp),
    project: text(payload.workspaceRoot) ?? text(payload.cwd),
    transcriptPath: text(payload.transcriptPath),
    rootSession: isSubagentStart || (!child && (hook === 'session_start' || hook === 'session_end'))
      ? true
      : undefined,
    unresolvedParent: child ? true : undefined,
  }
  const identity = {
    grokHook: hook,
    nativeReason: text(payload.reason) ?? text(payload.phase),
    subagentId: text(payload.subagentId),
    subagentType,
  }

  if (hook === 'user_prompt_submit') {
    const prompt = text(payload.prompt)
    if (!prompt || !promptId || child) return []
    return [createEvent(
      { ...base, prompt: prompt.slice(0, 140) },
      observedAt,
      { ...identity, fullPrompt: prompt },
    )]
  }

  if (hook === 'post_tool_use' || hook === 'post_tool_use_failure') {
    const id = text(payload.toolUseId)
    const name = text(payload.toolName)
    if (!id || !name) return []
    return [createEvent({
      ...base,
      confirmsTurn: true,
      tool: { id, name },
      needsHydration: child ? true : undefined,
    }, observedAt, { ...identity, grokHook: 'tool' })]
  }

  if (hook === 'subagent_start') {
    const subagentId = text(payload.subagentId)
    if (!subagentId) return []
    return [createEvent(base, observedAt, identity)]
  }

  if (hook === 'subagent_stop') {
    return [createEvent({
      ...base,
      confirmsTurn: promptId ? true : undefined,
      needsHydration: true,
    }, observedAt, identity)]
  }

  if (hook === 'session_start') return [createEvent(base, observedAt, identity)]

  if (lifecycle.has(hook)) {
    return [createEvent({
      ...base,
      confirmsTurn: confirms.has(hook) && promptId ? true : undefined,
      needsHydration: true,
    }, observedAt, identity)]
  }

  return []
}
