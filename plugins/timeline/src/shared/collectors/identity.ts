import { createHash } from 'node:crypto'
import type { CollectorEvent, Host } from './types'

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function fields(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object'
    ? input as Record<string, unknown>
    : {}
}

export function sessionKey(agent: Host, nativeSessionId: string): string {
  if (!nativeSessionId.trim()) throw new Error('empty session id')
  return `${agent}:${nativeSessionId}`
}

export function eventKey(event: Omit<CollectorEvent, 'eventId' | 'observedAt'>): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    )
    return value
  }
  return createHash('sha256').update(JSON.stringify(canonical(event))).digest('hex')
}

export function detectHost(input: unknown, env: NodeJS.ProcessEnv): Host | null {
  const payload = fields(input)
  if (hasText(env.ZCODE_SESSION_ID) && hasText(payload.sessionId) && hasText(payload.hookEventName)) {
    return env.ZCODE_SESSION_ID === payload.sessionId
      && payload.session_id === payload.sessionId
      && payload.hook_event_name === payload.hookEventName
      && !hasText(payload.conversation_id)
      && payload.client_type !== 'kimi_code_cli' ? 'zcode' : null
  }
  const nativeGrok = hasText(payload.sessionId) && hasText(payload.hookEventName)
  const nativeCursor = hasText(payload.conversation_id)
    && (hasText(payload.hook_event_name) || hasText(payload.cursor_version))

  const nativeKimi = payload.client_type === 'kimi_code_cli'
    && hasText(payload.session_id) && hasText(payload.hook_event_name)
  const candidates: Host[] = []
  if (nativeGrok) candidates.push('grok')
  if (nativeCursor) candidates.push('cursor')
  if (nativeKimi) candidates.push('kimi')
  if (candidates.length > 1) {
    console.warn(`[timeline] conflicting native host evidence: ${candidates.join(',')}`)
    return null
  }
  if (candidates.length === 1) return candidates[0]

  if (hasText(env.GROK_SESSION_ID) || hasText(env.GROK_HOOK_EVENT)) return 'grok'
  if (hasText(payload.conversation_id) && hasText(env.CURSOR_VERSION)) return 'cursor'
  return null
}
