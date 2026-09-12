import { expect, it } from 'vitest'
import { reduceEvents, toSnapshot } from '../../../src/shared/collectors/reduce'
import type { CollectorEvent } from '../../../src/shared/collectors/types'

const event = (eventId: string, patch: Partial<CollectorEvent> = {}): CollectorEvent => ({
  version: 1,
  agent: 'cursor',
  nativeSessionId: 'c1',
  eventId,
  observedAt: 1000,
  project: '/tmp/demo',
  ...patch,
})

it('does not count a blocked prompt before a turn is confirmed', () => {
  expect(toSnapshot(reduceEvents(null, [
    event('p', { turnId: 't1', prompt: 'hello' }),
  ]))).toBeNull()
})

it('replaces a cumulative usage snapshot and deduplicates tools', () => {
  const p = event('p', { turnId: 't1', prompt: 'hello' })
  const t = event('t', {
    turnId: 't1',
    confirmsTurn: true,
    tool: { id: 'call1', name: 'Shell' },
  })
  const u1 = event('u1', {
    sourceAt: 1100,
    usage: { input: 10, output: 5, cached: 2, status: 'complete' },
  })
  const u2 = event('u2', {
    sourceAt: 1200,
    usage: { input: 12, output: 8, cached: 3, status: 'complete' },
  })
  const state = reduceEvents(null, [p, t, t, u2, u1])

  expect(toSnapshot(state)).toMatchObject({
    sessionId: 'cursor:c1',
    turns: 1,
    tokensInput: 12,
    tokensOutput: 8,
    tokensCached: 3,
    tools: [{ toolName: 'Shell', callCount: 1 }],
  })
  expect(toSnapshot(reduceEvents(state, [t, u2]))).toEqual(toSnapshot(state))
})

it('uses the newest valid cumulative usage even when it decreases', () => {
  const snapshot = toSnapshot(reduceEvents(null, [
    event('activity', { confirmsTurn: true }),
    event('newer-large', {
      sourceAt: 1200,
      usage: { input: 12, output: 8, cached: 3, status: 'complete' },
    }),
    event('newest-small', {
      sourceAt: 1300,
      usage: { input: 3, output: 2, cached: 1, status: 'partial' },
    }),
  ]))

  expect(snapshot).toMatchObject({
    tokensInput: 3,
    tokensOutput: 2,
    tokensCached: 1,
    tokenStatus: 'partial',
  })
})

it('orders metadata by source time and tolerates missing paths and models', () => {
  const snapshot = toSnapshot(reduceEvents(null, [
    event('latest', {
      sourceAt: 1200,
      turnId: 't1',
      prompt: 'hello',
      confirmsTurn: true,
      title: 'Latest',
      model: 'new-model',
    }),
    event('old', { sourceAt: 1050, title: 'Old', model: 'old-model', project: '/tmp/old' }),
  ]))

  expect(snapshot).toMatchObject({
    project: '/tmp/demo',
    model: 'new-model',
    transcriptPath: 'cursor://c1',
    fileSize: 0,
    summary: 'Latest',
    summarySource: 'auto',
  })
})

it('counts distinct turn and tool ids even when their contents match', () => {
  const snapshot = toSnapshot(reduceEvents(null, [
    event('p1', { turnId: 't1', prompt: 'same' }),
    event('c1', { turnId: 't1', confirmsTurn: true }),
    event('p2', { turnId: 't2', prompt: 'same' }),
    event('c2', { turnId: 't2', confirmsTurn: true }),
    event('tool1', { turnId: 't2', tool: { id: 'one', name: 'Shell' } }),
    event('tool2', { turnId: 't2', tool: { id: 'two', name: 'Shell' } }),
  ]))

  expect(snapshot).toMatchObject({
    turns: 2,
    tools: [{ toolName: 'Shell', callCount: 2 }],
  })
})

it('keeps child calls distinct without adding child user turns', () => {
  const state = reduceEvents(null, [
    event('child-a', {
      sourceSessionId: 'a',
      turnId: 't',
      prompt: 'child prompt',
      confirmsTurn: true,
      tool: { id: 'call1', name: 'Read' },
    }),
    event('child-b', {
      sourceSessionId: 'b',
      turnId: 't',
      prompt: 'child prompt',
      confirmsTurn: true,
      tool: { id: 'call1', name: 'Read' },
    }),
  ])

  expect(toSnapshot(state)).toMatchObject({
    turns: 0,
    tools: [{ toolName: 'Read', callCount: 2 }],
  })
})

it('does not create activity from child confirmation or usage facts', () => {
  expect(toSnapshot(reduceEvents(null, [
    event('child-confirm', {
      sourceSessionId: 'child',
      turnId: 'child-turn',
      confirmsTurn: true,
    }),
  ]))).toBeNull()

  expect(toSnapshot(reduceEvents(null, [
    event('child-usage', {
      sourceSessionId: 'child',
      usage: { input: 10, output: 5, cached: 2, status: 'complete' },
    }),
  ]))).toBeNull()
})

it('does not let child or unresolved facts project onto root metadata and usage', () => {
  const snapshot = toSnapshot(reduceEvents(null, [
    event('root', {
      sourceAt: 1100,
      turnId: 'root-turn',
      prompt: 'root prompt',
      confirmsTurn: true,
      project: '/root/project',
      model: 'root-model',
      title: 'Root title',
      usage: { input: 10, output: 5, cached: 2, status: 'complete' },
    }),
    event('child', {
      sourceAt: 1200,
      sourceSessionId: 'child',
      turnId: 'child-turn',
      prompt: 'child prompt',
      confirmsTurn: true,
      project: '/child/project',
      model: 'child-model',
      title: 'Child title',
      usage: { input: 99, output: 99, cached: 99, status: 'complete' },
      tool: { id: 'read', name: 'Read', skill: 'inspect' },
    }),
    event('unresolved', {
      sourceAt: 1300,
      unresolvedParent: true,
      tool: { id: 'ignored', name: 'Write', skill: 'ignored' },
      usage: { input: 999, output: 999, cached: 999, status: 'complete' },
    }),
  ]))

  expect(snapshot).toEqual(expect.objectContaining({
    turns: 1,
    summary: 'Root title',
    project: '/root/project',
    model: 'root-model',
    tokensInput: 10,
    tools: [{ toolName: 'Read', callCount: 1 }],
    skills: ['inspect'],
  }))
})

it('uses stable event times and ignores invalid usage defensively', () => {
  const invalidUsage = { input: -1, output: Number.NaN, cached: 0, status: 'complete' } as const
  const first = event('activity', { observedAt: 2000, confirmsTurn: true })
  const state = reduceEvents(null, [
    first,
    event('usage', { observedAt: 2100, usage: { input: 2, output: 1, cached: 0, status: 'complete' } }),
    event('invalid', { observedAt: 2200, usage: invalidUsage }),
  ])
  const duplicateReceivedLater = event('activity', { observedAt: 9000, confirmsTurn: true })
  const snapshot = toSnapshot(reduceEvents(state, [duplicateReceivedLater]))

  expect(snapshot).toMatchObject({
    startedAt: 2000,
    endedAt: 2200,
    durationMs: 200,
    tokensInput: 2,
  })
})

it('truncates first-message summaries and projects explicit unavailable usage', () => {
  const prompt = 'x'.repeat(160)
  const snapshot = toSnapshot(reduceEvents(null, [
    event('prompt', { turnId: 't1', prompt }),
    event('confirm', { turnId: 't1', confirmsTurn: true }),
    event('usage', {
      sourceAt: 1200,
      usage: { input: 0, output: 0, cached: 0, status: 'unavailable' },
    }),
  ]))

  expect(snapshot).toMatchObject({
    summary: 'x'.repeat(140),
    summarySource: 'first_message',
    tokenStatus: 'unavailable',
  })
})

it('rejects empty and mixed collector batches', () => {
  expect(() => reduceEvents(null, [])).toThrow('empty collector batch')
  expect(() => reduceEvents(null, [
    event('cursor'),
    event('grok', { agent: 'grok', nativeSessionId: 'g1' }),
  ])).toThrow('mixed collector sessions')
})

it('returns null when every fact has an unresolved parent', () => {
  expect(toSnapshot(reduceEvents(null, [
    event('unresolved', { unresolvedParent: true, confirmsTurn: true }),
  ]))).toBeNull()
})
