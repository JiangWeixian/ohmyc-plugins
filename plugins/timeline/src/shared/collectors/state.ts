import type { CollectorEvent, CollectorState, Host } from './types'

const HOSTS: readonly string[] = ['cursor', 'grok', 'kimi', 'zcode']
export const HEX_HASH = /^[a-f0-9]{64}$/

export function hostOf(key: string): Host | undefined {
  const separator = key.indexOf(':')
  const host = key.slice(0, separator)
  return separator > 0 && separator < key.length - 1 && HOSTS.includes(host) ? host as Host : undefined
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function number(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function validEvent(value: unknown, key: string, id: string): value is CollectorEvent {
  const data = object(value)
  if (!data || data.version !== 1 || !hostOf(key) || data.agent !== hostOf(key)
    || typeof data.nativeSessionId !== 'string' || `${data.agent}:${data.nativeSessionId}` !== key
    || data.eventId !== id || !HEX_HASH.test(id) || !number(data.observedAt)) return false
  for (const field of ['sourceSessionId', 'resolvesEventId', 'turnId', 'prompt', 'project', 'model', 'title', 'transcriptPath']) {
    if (data[field] !== undefined && typeof data[field] !== 'string') return false
  }
  for (const field of ['sourceAt', 'fileSize']) {
    if (data[field] !== undefined && !number(data[field])) return false
  }
  for (const field of ['rootSession', 'unresolvedParent', 'confirmsTurn', 'needsHydration']) {
    if (data[field] !== undefined && typeof data[field] !== 'boolean') return false
  }
  if (data.tool !== undefined) {
    const tool = object(data.tool)
    if (!tool || typeof tool.id !== 'string' || !tool.id || typeof tool.name !== 'string' || !tool.name
      || (tool.skill !== undefined && typeof tool.skill !== 'string')) return false
  }
  if (data.usage !== undefined) {
    const usage = object(data.usage)
    if (!usage || ![usage.input, usage.output, usage.cached].every(number)
      || !['complete', 'partial', 'unavailable'].includes(String(usage.status))) return false
  }
  return true
}

export class UnsupportedCollectorStateError extends Error {
  constructor() { super('unsupported collector agent or state version; preserving data') }
}

export function parseState(raw: string, key: string): CollectorState {
  const state = object(JSON.parse(raw))
  if (state && ((typeof state.version === 'number' && state.version > 1)
    || (typeof state.agent === 'string' && !HOSTS.includes(state.agent)))) {
    throw new UnsupportedCollectorStateError()
  }
  const events = object(state?.events)
  if (!state || state.version !== 1 || !hostOf(key) || state.agent !== hostOf(key)
    || typeof state.nativeSessionId !== 'string' || `${state.agent}:${state.nativeSessionId}` !== key
    || !events || !Object.entries(events).every(([id, event]) => validEvent(event, key, id))) {
    throw new Error('invalid collector state')
  }
  return state as CollectorState
}
