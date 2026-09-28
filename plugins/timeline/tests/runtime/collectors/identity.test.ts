import { afterEach, expect, it, vi } from 'vitest'
import { detectHost, eventKey, sessionKey } from '../../../src/shared/collectors/identity'
import type { CollectorEvent } from '../../../src/shared/collectors/types'

afterEach(() => {
  vi.restoreAllMocks()
})

it('separates hosts even when the native id is identical', () => {
  expect(sessionKey('cursor', 'same')).toBe('cursor:same')
  expect(sessionKey('grok', 'same')).toBe('grok:same')
})

it('rejects an empty native session id', () => {
  expect(() => sessionKey('cursor', '  ')).toThrow('empty session id')
})

it('recognizes Grok before Claude compatibility aliases', () => {
  expect(detectHost({ sessionId: 'g1', hookEventName: 'stop' }, {
    GROK_SESSION_ID: 'g1',
    CLAUDE_PLUGIN_ROOT: '/cache/plugin',
  })).toBe('grok')
})

it('recognizes a native Cursor envelope', () => {
  expect(detectHost({ conversation_id: 'c1', hook_event_name: 'stop' }, {})).toBe('cursor')
  expect(detectHost({ conversation_id: 'c2', cursor_version: '1.7.0' }, {})).toBe('cursor')
})

it('does not let inherited environment evidence override a native payload', () => {
  expect(detectHost({ conversation_id: 'c1', hook_event_name: 'stop' }, {
    GROK_SESSION_ID: 'g1',
    GROK_HOOK_EVENT: 'stop',
  })).toBe('cursor')
  expect(detectHost({ sessionId: 'g1', hookEventName: 'stop' }, {
    CURSOR_VERSION: '1.7.0',
  })).toBe('grok')
})

it('uses environment evidence when the payload has no complete native identity', () => {
  expect(detectHost({}, { GROK_SESSION_ID: 'g1' })).toBe('grok')
  expect(detectHost({ conversation_id: 'c1' }, { CURSOR_VERSION: '1.7.0' })).toBe('cursor')
})

it('rejects a conflicting native envelope without logging sensitive values', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const sensitive = 'do-not-log-this'

  expect(detectHost({
    sessionId: 'g1',
    hookEventName: 'stop',
    conversation_id: 'c1',
    hook_event_name: 'stop',
    prompt: sensitive,
  }, { GROK_SESSION_ID: sensitive })).toBeNull()

  expect(warn).toHaveBeenCalledOnce()
  const diagnostic = warn.mock.calls.flat().join(' ')
  expect(diagnostic).toContain('grok')
  expect(diagnostic).toContain('cursor')
  expect(diagnostic).not.toContain(sensitive)
  expect(diagnostic).not.toContain('g1')
  expect(diagnostic).not.toContain('c1')
})

it('does not infer a host from the model or plugin roots alone', () => {
  expect(detectHost({ model: 'grok-code' }, { PLUGIN_ROOT: '/cache/p' })).toBeNull()
  expect(detectHost({}, { CLAUDE_PLUGIN_ROOT: '/cache/plugin' })).toBeNull()
})

it('creates the same event key regardless of object key order or undefined fields', () => {
  const first = {
    version: 1,
    agent: 'cursor',
    nativeSessionId: 'c1',
    turnId: 't1',
    tool: { id: 'tool-1', name: 'Read', skill: undefined },
  } satisfies Omit<CollectorEvent, 'eventId' | 'observedAt'>
  const reordered = {
    tool: { name: 'Read', id: 'tool-1' },
    turnId: 't1',
    nativeSessionId: 'c1',
    agent: 'cursor',
    version: 1,
  } satisfies Omit<CollectorEvent, 'eventId' | 'observedAt'>

  expect(eventKey(first)).toBe(eventKey(reordered))
})

it('creates distinct event keys for different tool and turn identities', () => {
  const base = {
    version: 1,
    agent: 'grok',
    nativeSessionId: 'g1',
    turnId: 't1',
    tool: { id: 'tool-1', name: 'Read' },
  } satisfies Omit<CollectorEvent, 'eventId' | 'observedAt'>

  expect(eventKey(base)).not.toBe(eventKey({
    ...base,
    tool: { ...base.tool, id: 'tool-2' },
  }))
  expect(eventKey(base)).not.toBe(eventKey({ ...base, turnId: 't2' }))
})
