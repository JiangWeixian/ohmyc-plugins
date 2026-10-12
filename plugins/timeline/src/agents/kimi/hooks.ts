import path from 'node:path'
import { eventKey } from '../../shared/collectors/identity'
import { skillFromReadPaths } from '../../shared/collectors/skill'
import type { CollectorEvent } from '../../shared/collectors/types'

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function turnId(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value) : undefined
}

export function kimiEvent(
  id: string,
  observedAt: number,
  facts: Partial<CollectorEvent>,
  identity: Record<string, unknown> = {},
): CollectorEvent {
  const semantic = { version: 1 as const, agent: 'kimi' as const, nativeSessionId: id, ...facts }
  return { ...semantic, eventId: eventKey({ ...semantic, ...identity }), observedAt }
}

export function kimiSkill(name: string, input: unknown, succeeded: boolean, cwd?: string): string | undefined {
  if (!succeeded) return undefined
  const args = object(input)
  if (name === 'Skill') return text(args?.skill)
  const requested = text(args?.path)
  if (name !== 'Read' || !requested || (!path.isAbsolute(requested) && !cwd)) return undefined
  return skillFromReadPaths(requested, path.resolve(cwd ?? '/', requested), cwd)
}

export function parseKimiHook(input: unknown, observedAt: number): CollectorEvent[] {
  const data = object(input)
  const id = text(data?.session_id)
  const hook = text(data?.hook_event_name)
  if (!data || !id || !hook || data.client_type !== 'kimi_code_cli' || !Number.isFinite(observedAt)) return []
  const base = { project: text(data.cwd), title: text(data.session_title) }
  if (hook === 'TurnStarted') {
    const nativeTurn = turnId(data.turn_id)
    const prompt = text(data.prompt)
    if (data.origin_kind !== 'user' || nativeTurn === undefined || !prompt) return []
    return [kimiEvent(id, observedAt, { ...base, turnId: nativeTurn, prompt: prompt.slice(0, 140), confirmsTurn: true }, { hook, fullPrompt: prompt })]
  }
  if (hook === 'PostToolUse' || hook === 'PostToolUseFailure') {
    const toolId = text(data.tool_call_id)
    const name = text(data.tool_name)
    if (!toolId || !name) return []
    const skill = kimiSkill(name, data.tool_input, hook === 'PostToolUse' && data.error === undefined
      && text(data.tool_output) !== undefined, text(data.cwd))
    return [kimiEvent(id, observedAt, { ...base, tool: { id: toolId, name, ...(skill ? { skill } : {}) } }, { hook: 'tool' })]
  }
  if (hook === 'SessionStart') {
    return [kimiEvent(id, observedAt, { ...base, model: text(data.model), rootSession: true, needsHydration: true }, { hook, source: text(data.source) })]
  }
  if (['Stop', 'StopFailure', 'Interrupt', 'SessionEnd', 'SubagentStop', 'PostCompact'].includes(hook)) {
    return [kimiEvent(id, observedAt, { ...base, needsHydration: true }, { hook, nativeTurn: turnId(data.turn_id), reason: text(data.reason) })]
  }
  return []
}
