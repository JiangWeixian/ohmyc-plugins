import path from 'node:path'
import { eventKey } from '../../shared/collectors/identity'
import type { CollectorEvent } from '../../shared/collectors/types'

type Payload = Record<string, unknown>
type SemanticEvent = Omit<CollectorEvent, 'eventId' | 'observedAt'>

function object(value: unknown): Payload | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Payload
    : null
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => text(item) !== undefined) : []
}

function project(payload: Payload): string | undefined {
  const cwd = text(payload.cwd)
  const roots = strings(payload.workspace_roots)
  if (!cwd) return roots[0]
  const containing = roots.filter(root => {
    const relative = path.relative(root, cwd)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  })
  if (containing.length === 1) return containing[0]
  return cwd
}

function createEvent(
  semantic: SemanticEvent,
  observedAt: number,
  identity: Record<string, unknown>,
): CollectorEvent {
  return {
    ...semantic,
    eventId: eventKey({ ...semantic, ...identity }),
    observedAt,
  }
}

export function parseCursorHook(input: unknown, observedAt: number): CollectorEvent[] {
  const payload = object(input)
  if (!payload || !Number.isFinite(observedAt)) return []
  const nativeSessionId = text(payload.conversation_id)
  const hook = text(payload.hook_event_name)
  if (!nativeSessionId || !hook) return []

  const generationId = text(payload.generation_id)
  const reliableTurnId = generationId && generationId !== nativeSessionId
    ? generationId
    : undefined
  const transcriptPath = text(payload.transcript_path)
  const rootSession = (hook === 'sessionStart' || hook === 'sessionEnd')
    && payload.is_background_agent === false
    ? true
    : undefined
  const base: SemanticEvent = {
    version: 1,
    agent: 'cursor',
    nativeSessionId,
    turnId: reliableTurnId,
    project: project(payload),
    model: text(payload.model_id) ?? text(payload.model),
    transcriptPath,
    rootSession,
  }
  const identity = {
    cursorHook: hook,
    nativeStatus: text(payload.final_status) ?? text(payload.reason),
    nativeDuration: typeof payload.duration_ms === 'number' ? payload.duration_ms : undefined,
  }

  if (hook === 'beforeSubmitPrompt') {
    const prompt = text(payload.prompt)
    if (!prompt || !reliableTurnId) return []
    return [createEvent({ ...base, prompt: prompt.slice(0, 140) }, observedAt, identity)]
  }

  if (hook === 'postToolUse' || hook === 'postToolUseFailure') {
    const id = text(payload.tool_use_id)
    const name = text(payload.tool_name)
    if (!id || !name) return []
    const unresolvedParent = reliableTurnId === undefined && rootSession !== true && !transcriptPath
      ? true
      : undefined
    return [createEvent({
      ...base,
      confirmsTurn: true,
      tool: { id, name },
      unresolvedParent,
    }, observedAt, { ...identity, cursorHook: 'tool' })]
  }

  if (hook === 'afterAgentResponse') {
    return [createEvent({ ...base, confirmsTurn: true }, observedAt, identity)]
  }

  if (hook === 'stop') {
    return [createEvent({ ...base, confirmsTurn: true, needsHydration: true }, observedAt, identity)]
  }

  if (hook === 'sessionStart') {
    return [createEvent(base, observedAt, identity)]
  }

  if (hook === 'sessionEnd') {
    return [createEvent({ ...base, needsHydration: true }, observedAt, identity)]
  }

  return []
}
