import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseGrokHook } from '../../../src/agents/grok/hooks'
import { hydrateGrok, parseGrokUsage } from '../../../src/agents/grok/session'
import { reduceEvents, toSnapshot } from '../../../src/shared/collectors/reduce'
import type { CollectorEvent } from '../../../src/shared/collectors/types'

const fixtures = path.resolve(import.meta.dirname, '../../fixtures/grok')

afterEach(() => vi.restoreAllMocks())

async function copyFixture(source: string, target: string): Promise<void> {
  await writeFile(target, await readFile(path.join(fixtures, source)))
}

async function sessionHome(id = 'g1'): Promise<{ home: string, directory: string }> {
  const home = await mkdtemp(path.join(tmpdir(), 'timeline-grok-'))
  const directory = path.join(home, 'sessions', '%2Ftmp%2Ftimeline-fixture', id)
  await mkdir(directory, { recursive: true })
  return { home, directory }
}

function request(id = 'g1', patch: Record<string, unknown> = {}): CollectorEvent {
  return parseGrokHook({
    hookEventName: 'stop', sessionId: id, promptId: 'p1',
    workspaceRoot: '/tmp/timeline-fixture', timestamp: '2026-09-12T10:30:45Z',
    ...patch,
  }, 1000)[0]
}

describe('parseGrokUsage', () => {
  it('subtracts cached reads from cumulative input and ignores turn breakdown', () => {
    const usage = parseGrokUsage({
      sessionId: 'g1',
      session: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 3, usageIsIncomplete: false },
      turns: [{ turnNumber: 1, inputTokens: 10, outputTokens: 5 }],
    }, 'g1')

    expect(usage).toEqual({ input: 7, output: 5, cached: 3, status: 'complete' })
    expect(parseGrokUsage({ sessionId: 'g1', session: {
      inputTokens: 100, outputTokens: 10, cachedReadTokens: 40, totalTokens: 110,
    } }, 'g1')).toEqual({ input: 60, output: 10, cached: 40, status: 'complete' })
  })

  it('rejects copied, negative, fractional, and cache-heavy usage', () => {
    expect(parseGrokUsage({ sessionId: 'parent', session: {} }, 'child')).toBeNull()
    expect(parseGrokUsage({ sessionId: 'g1', session: {
      inputTokens: -1, outputTokens: 1, cachedReadTokens: 0, usageIsIncomplete: false,
    } }, 'g1')).toBeNull()
    expect(parseGrokUsage({ sessionId: 'g1', session: {
      inputTokens: 1.5, outputTokens: 1, cachedReadTokens: 0, usageIsIncomplete: false,
    } }, 'g1')).toBeNull()
    expect(parseGrokUsage({ sessionId: 'g1', session: {
      inputTokens: 2, outputTokens: 1, cachedReadTokens: 3, usageIsIncomplete: false,
    } }, 'g1')).toBeNull()
  })

  it('serializes explicit false as complete and true as partial', () => {
    expect(parseGrokUsage({ sessionId: 'g1', session: {
      inputTokens: 4, outputTokens: 2, cachedReadTokens: 1,
    } }, 'g1')?.status).toBe('complete')
    expect(parseGrokUsage({ sessionId: 'g1', session: {
      inputTokens: 4, outputTokens: 2, cachedReadTokens: 1, usageIsIncomplete: false,
    } }, 'g1')?.status).toBe('complete')
    expect(parseGrokUsage({ sessionId: 'g1', session: {
      inputTokens: 4, outputTokens: 2, cachedReadTokens: 1, usageIsIncomplete: true,
    } }, 'g1')?.status).toBe('partial')
  })
})

describe('hydrateGrok', () => {
  it('hydrates the native main fixture to two turns, two tool attempts, and cumulative usage', async () => {
    const { home, directory } = await sessionHome()
    await Promise.all([
      copyFixture('summary.json', path.join(directory, 'summary.json')),
      copyFixture('usage.json', path.join(directory, 'usage.json')),
      copyFixture('chat_history.jsonl', path.join(directory, 'chat_history.jsonl')),
    ])
    const inputs: Record<string, unknown>[] = JSON.parse(
      await readFile(path.join(fixtures, 'hook-sequence.json'), 'utf8'),
    )
    const hooks = inputs.flatMap((input, index) => parseGrokHook(input, 1000 + index))
    const hydrated = await hydrateGrok(hooks, home)
    const snapshot = toSnapshot(reduceEvents(null, [...hooks, ...hydrated]))

    expect(snapshot).toMatchObject({
      sessionId: 'grok:g1', project: '/tmp/timeline-fixture', turns: 2,
      tools: [{ toolName: 'read_file', callCount: 2 }],
      model: 'grok-4.6', summary: 'Timeline hook integration test file reads',
      tokensInput: 57122, tokensOutput: 223, tokensCached: 40960,
      tokenStatus: 'complete',
    })
    const requests = hooks.filter(event => event.needsHydration)
    expect(hydrated.filter(event => event.resolvesEventId).map(event => event.resolvesEventId).sort())
      .toEqual(requests.map(event => event.eventId).sort())
    expect(hydrated.filter(event => event.resolvesEventId)
      .every(event => event.needsHydration === false)).toBe(true)
  })

  it('deduplicates repeated stop snapshots and replaces resumed or rewound cumulative usage', async () => {
    const { home, directory } = await sessionHome()
    await copyFixture('summary.json', path.join(directory, 'summary.json'))
    const usagePath = path.join(directory, 'usage.json')
    const event = request()
    const writeUsage = async (input: number, updatedAt: string) => writeFile(usagePath, JSON.stringify({
      sessionId: 'g1', updatedAt,
      session: { inputTokens: input, outputTokens: 2, cachedReadTokens: 0, usageIsIncomplete: false },
    }))

    await writeUsage(10, '2026-09-12T10:30:45Z')
    const first = await hydrateGrok([event, event], home)
    await writeUsage(15, '2026-09-12T10:31:45Z')
    const resumed = await hydrateGrok([event, ...first], home)
    await writeUsage(3, '2026-09-12T10:32:45Z')
    const rewound = await hydrateGrok([event, ...first, ...resumed], home)

    expect(new Set(first.map(item => item.eventId)).size).toBe(first.length)
    expect(toSnapshot(reduceEvents(null, [event, ...first, ...resumed]))?.tokensInput).toBe(15)
    expect(toSnapshot(reduceEvents(null, [event, ...first, ...resumed, ...rewound]))?.tokensInput).toBe(3)
  })

  it('keeps a completed turn pending until cumulative usage reaches its stop timestamp', async () => {
    const { home, directory } = await sessionHome()
    await copyFixture('summary.json', path.join(directory, 'summary.json'))
    const usagePath = path.join(directory, 'usage.json')
    const stop = request('g1', { timestamp: '2026-09-12T10:31:45Z' })
    await writeFile(usagePath, JSON.stringify({
      sessionId: 'g1', updatedAt: '2026-09-12T10:30:45Z',
      session: { inputTokens: 10, outputTokens: 2, cachedReadTokens: 0 },
    }))

    const stale = await hydrateGrok([stop], home)
    expect(stale.some(event => event.resolvesEventId === stop.eventId)).toBe(false)
    expect(toSnapshot(reduceEvents(null, [stop, ...stale]))?.tokensInput).toBe(10)

    await writeFile(usagePath, JSON.stringify({
      sessionId: 'g1', updatedAt: '2026-09-12T10:31:45.200Z',
      session: { inputTokens: 17, outputTokens: 4, cachedReadTokens: 3 },
    }))
    const current = await hydrateGrok([stop, ...stale], home)
    expect(current.some(event => event.resolvesEventId === stop.eventId
      && event.needsHydration === false)).toBe(true)
    expect(toSnapshot(reduceEvents(null, [stop, ...stale, ...current]))).toMatchObject({
      tokensInput: 14, tokensOutput: 4, tokensCached: 3,
    })
  })

  it('keeps known usage and the exact request pending when usage is partial on disk', async () => {
    const { home, directory } = await sessionHome()
    await copyFixture('summary.json', path.join(directory, 'summary.json'))
    await writeFile(path.join(directory, 'usage.json'), '{"sessionId":"g1"')
    const event = request()
    const known: CollectorEvent = {
      ...event, eventId: 'a'.repeat(64), needsHydration: undefined,
      sourceAt: Date.parse('2026-09-12T10:29:00Z'),
      usage: { input: 8, output: 2, cached: 1, status: 'complete' },
    }
    const hydrated = await hydrateGrok([known, event], home)

    expect(hydrated.some(item => item.usage)).toBe(false)
    expect(hydrated.some(item => item.resolvesEventId === event.eventId)).toBe(false)
    expect(toSnapshot(reduceEvents(null, [known, event, ...hydrated]))).toMatchObject({
      tokensInput: 8, tokensCached: 1,
    })
  })

  it('replaces complete usage with a newer valid partial, then completes on recovery', async () => {
    const { home, directory } = await sessionHome()
    await copyFixture('summary.json', path.join(directory, 'summary.json'))
    const usagePath = path.join(directory, 'usage.json')
    const event = request()
    const writeUsage = async (
      inputTokens: number,
      cachedReadTokens: number,
      usageIsIncomplete: boolean,
      updatedAt: string,
    ) => writeFile(usagePath, JSON.stringify({
      sessionId: 'g1', updatedAt,
      session: { inputTokens, outputTokens: 2, cachedReadTokens, usageIsIncomplete },
    }))

    await writeUsage(10, 2, false, '2026-09-12T10:30:45Z')
    const complete = await hydrateGrok([event], home)
    await writeUsage(7, 3, true, '2026-09-12T10:31:45Z')
    const partial = await hydrateGrok([event, ...complete], home)
    const partialSnapshot = toSnapshot(reduceEvents(null, [event, ...complete, ...partial]))

    expect(partialSnapshot).toMatchObject({
      tokensInput: 4, tokensOutput: 2, tokensCached: 3, tokenStatus: 'partial',
    })
    expect(partial.some(item => item.resolvesEventId === event.eventId)).toBe(false)

    await writeUsage(12, 4, false, '2026-09-12T10:32:45Z')
    const recovered = await hydrateGrok([event, ...complete, ...partial], home)
    expect(toSnapshot(reduceEvents(null, [event, ...complete, ...partial, ...recovered])))
      .toMatchObject({
        tokensInput: 8, tokensOutput: 2, tokensCached: 4, tokenStatus: 'complete',
      })
    expect(recovered).toContainEqual(expect.objectContaining({
      resolvesEventId: event.eventId, needsHydration: false,
    }))
  })

  it('does not select another or newest session directory', async () => {
    const { home, directory } = await sessionHome('newest')
    await writeFile(path.join(directory, 'summary.json'), JSON.stringify({
      info: { id: 'newest', cwd: '/wrong' }, chat_format_version: 1, session_kind: 'headless',
    }))
    await writeFile(path.join(directory, 'usage.json'), JSON.stringify({
      sessionId: 'newest', session: {
        inputTokens: 99, outputTokens: 99, cachedReadTokens: 0, usageIsIncomplete: false,
      },
    }))
    const event = request('missing')
    const hydrated = await hydrateGrok([event], home)

    expect(hydrated).toEqual([])
  })

  it('rejects wrong summary identity and diagnoses unknown chat formats privately', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { home, directory } = await sessionHome()
    await writeFile(path.join(directory, 'summary.json'), JSON.stringify({
      info: { id: 'wrong-private-id', cwd: '/private/path' }, chat_format_version: 99,
    }))
    await copyFixture('usage.json', path.join(directory, 'usage.json'))
    const event = request()

    expect(await hydrateGrok([event], home)).toEqual([])
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/wrong-private-id|private\/path/)

    await writeFile(path.join(directory, 'summary.json'), JSON.stringify({
      info: { id: 'g1', cwd: '/private/path' }, chat_format_version: 99,
    }))
    expect(await hydrateGrok([event], home)).toEqual([])
    expect(warn.mock.calls.flat().join(' ')).toContain('unsupported Grok chat format')
  })

  it('rejects mixed native IDs before using root evidence or files', async () => {
    await expect(hydrateGrok([request('one'), request('two')], '/missing'))
      .rejects.toThrow('mixed Grok hydration sessions')
  })

  it('forwards a validated child tool to its parent without adding child usage or turns', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'timeline-grok-'))
    const root = path.join(home, 'sessions', '%2Ftmp%2Ftimeline-fixture')
    const parent = path.join(root, 'parent')
    const child = path.join(root, 'child')
    await mkdir(path.join(parent, 'subagents', 'child'), { recursive: true })
    await mkdir(child, { recursive: true })
    await Promise.all([
      copyFixture('subagent/parent-summary.json', path.join(parent, 'summary.json')),
      copyFixture('subagent/parent-usage.json', path.join(parent, 'usage.json')),
      copyFixture('subagent/child-summary.json', path.join(child, 'summary.json')),
      copyFixture('subagent/child-usage.json', path.join(child, 'usage.json')),
      copyFixture('subagent/meta.json', path.join(parent, 'subagents', 'child', 'meta.json')),
    ])
    const inputs: Record<string, unknown>[] = JSON.parse(
      await readFile(path.join(fixtures, 'subagent/hook-sequence.json'), 'utf8'),
    )
    const childHooks = inputs.flatMap((input, index) => parseGrokHook(input, 1000 + index))
      .filter(event => event.nativeSessionId === 'child')
    const parentHooks = inputs.flatMap((input, index) => parseGrokHook(input, 1000 + index))
      .filter(event => event.nativeSessionId === 'parent')
    const hydrated = await hydrateGrok(childHooks, home)
    const parentHydrated = await hydrateGrok(parentHooks, home)
    const tool = hydrated.find(event => event.tool?.name === 'read_file')

    expect(tool).toMatchObject({
      nativeSessionId: 'parent', sourceSessionId: 'child', unresolvedParent: false,
      tool: { id: 'call-00000000-0000-4000-8000-000000000003-0', name: 'read_file' },
    })
    expect(hydrated.some(event => event.prompt)).toBe(false)
    expect(hydrated.some(event => event.usage)).toBe(false)
    expect(hydrated.filter(event => event.resolvesEventId).map(event => event.resolvesEventId).sort())
      .toEqual(childHooks.filter(event => event.needsHydration)
        .map(event => event.eventId).sort())
    expect(toSnapshot(reduceEvents(null, [...parentHooks, ...parentHydrated, ...hydrated])))
      .toMatchObject({
        turns: 1,
        tools: [
          { toolName: 'get_command_or_subagent_output', callCount: 1 },
          { toolName: 'read_file', callCount: 1 },
          { toolName: 'spawn_subagent', callCount: 1 },
        ],
        tokensInput: 41088,
        tokensOutput: 508,
        tokensCached: 75520,
      })
  })

  it('does not link ordinary forks or mismatched native subagent metadata', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'timeline-grok-'))
    const root = path.join(home, 'sessions', 'project')
    const parent = path.join(root, 'parent')
    const child = path.join(root, 'child')
    await mkdir(path.join(parent, 'subagents', 'child'), { recursive: true })
    await mkdir(child, { recursive: true })
    await writeFile(path.join(parent, 'summary.json'), JSON.stringify({
      info: { id: 'parent', cwd: '/tmp' }, chat_format_version: 1, session_kind: 'headless',
    }))
    await writeFile(path.join(child, 'summary.json'), JSON.stringify({
      info: { id: 'child', cwd: '/tmp' }, chat_format_version: 1, session_kind: 'fork',
    }))
    await writeFile(path.join(parent, 'subagents', 'child', 'meta.json'), JSON.stringify({
      parent_session_id: 'parent', child_session_id: 'child', subagent_id: 'wrong',
    }))
    const childTool = parseGrokHook({
      hookEventName: 'post_tool_use', sessionId: 'child', subagentType: 'general-purpose',
      toolUseId: 'call', toolName: 'read_file',
    }, 1000)[0]

    expect(await hydrateGrok([childTool], home)).toEqual([])
  })

  it('records summary identity while usage.json is still absent', async () => {
    const { home, directory } = await sessionHome()
    await copyFixture('summary.json', path.join(directory, 'summary.json'))
    const event = request()
    const hydrated = await hydrateGrok([event], home)

    expect(hydrated.some(item => item.resolvesEventId === event.eventId)).toBe(false)
    expect(toSnapshot(reduceEvents(null, [event, ...hydrated]))).toMatchObject({
      model: 'grok-4.6',
      summary: 'Timeline hook integration test file reads',
      tokenStatus: 'unavailable',
      tokensInput: 0,
    })
  })

  it('links a subagent through an explicit validated summary parent ID', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'timeline-grok-'))
    const root = path.join(home, 'sessions', 'project')
    const parent = path.join(root, 'parent')
    const child = path.join(root, 'child')
    await mkdir(parent, { recursive: true })
    await mkdir(child, { recursive: true })
    await writeFile(path.join(parent, 'summary.json'), JSON.stringify({
      info: { id: 'parent', cwd: '/tmp' }, chat_format_version: 1, session_kind: 'headless',
    }))
    await writeFile(path.join(child, 'summary.json'), JSON.stringify({
      info: { id: 'child', cwd: '/tmp' }, parent_session_id: 'parent',
      chat_format_version: 1, session_kind: 'subagent',
    }))
    const childTool = parseGrokHook({
      hookEventName: 'post_tool_use', sessionId: 'child', subagentType: 'general-purpose',
      toolUseId: 'call', toolName: 'read_file',
    }, 1000)[0]

    expect(await hydrateGrok([childTool], home)).toContainEqual(expect.objectContaining({
      nativeSessionId: 'parent', sourceSessionId: 'child', resolvesEventId: childTool.eventId,
    }))
  })

  it('links a child whose summary omits session_kind', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'timeline-grok-'))
    const root = path.join(home, 'sessions', 'project')
    const parent = path.join(root, 'parent')
    const child = path.join(root, 'child')
    await mkdir(path.join(parent, 'subagents', 'child'), { recursive: true })
    await mkdir(child, { recursive: true })
    await writeFile(path.join(parent, 'summary.json'), JSON.stringify({
      info: { id: 'parent', cwd: '/tmp' }, chat_format_version: 1,
    }))
    await writeFile(path.join(child, 'summary.json'), JSON.stringify({
      info: { id: 'child', cwd: '/tmp' }, chat_format_version: 1,
    }))
    await writeFile(path.join(parent, 'subagents', 'child', 'meta.json'), JSON.stringify({
      parent_session_id: 'parent', child_session_id: 'child', subagent_id: 'child',
    }))
    const childTool = parseGrokHook({
      hookEventName: 'post_tool_use', sessionId: 'child', subagentType: 'general-purpose',
      toolUseId: 'call', toolName: 'read_file',
    }, 1000)[0]

    expect(await hydrateGrok([childTool], home)).toContainEqual(expect.objectContaining({
      nativeSessionId: 'parent', sourceSessionId: 'child', resolvesEventId: childTool.eventId,
    }))
  })

  it('does not link an explicit fork even when subagent metadata matches', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'timeline-grok-'))
    const root = path.join(home, 'sessions', 'project')
    const parent = path.join(root, 'parent')
    const child = path.join(root, 'child')
    await mkdir(path.join(parent, 'subagents', 'child'), { recursive: true })
    await mkdir(child, { recursive: true })
    await writeFile(path.join(parent, 'summary.json'), JSON.stringify({
      info: { id: 'parent', cwd: '/tmp' }, chat_format_version: 1,
    }))
    await writeFile(path.join(child, 'summary.json'), JSON.stringify({
      info: { id: 'child', cwd: '/tmp' }, parent_session_id: 'parent',
      chat_format_version: 1, session_kind: 'fork',
    }))
    await writeFile(path.join(parent, 'subagents', 'child', 'meta.json'), JSON.stringify({
      parent_session_id: 'parent', child_session_id: 'child', subagent_id: 'child',
    }))
    const childTool = parseGrokHook({
      hookEventName: 'post_tool_use', sessionId: 'child', subagentType: 'general-purpose',
      toolUseId: 'call', toolName: 'read_file',
    }, 1000)[0]

    expect(await hydrateGrok([childTool], home)).toEqual([])
  })

  it('does not turn compressed or synthetic chat records into root prompts', async () => {
    const { home, directory } = await sessionHome()
    await Promise.all([
      copyFixture('summary.json', path.join(directory, 'summary.json')),
      copyFixture('usage.json', path.join(directory, 'usage.json')),
      writeFile(path.join(directory, 'chat_history.jsonl'), [
        JSON.stringify({ type: 'user', synthetic_reason: 'system_reminder', content: 'wake' }),
        JSON.stringify({ type: 'user', content: '<user_query>compressed old prompt</user_query>' }),
      ].join('\n') + '\n'),
    ])
    const event = request()
    const hydrated = await hydrateGrok([event], home)

    expect(hydrated.some(item => item.prompt)).toBe(false)
  })

  it('completes each no-turn lifecycle request by exact event ID only after full success', async () => {
    const { home, directory } = await sessionHome()
    await Promise.all([
      copyFixture('summary.json', path.join(directory, 'summary.json')),
      copyFixture('usage.json', path.join(directory, 'usage.json')),
    ])
    const first = request('g1', { promptId: undefined, timestamp: '2026-09-12T10:30:45Z' })
    const second = request('g1', { promptId: undefined, timestamp: '2026-09-12T10:30:46Z' })
    const hydrated = await hydrateGrok([first, second], home)

    expect(first.eventId).not.toBe(second.eventId)
    expect(hydrated.filter(item => item.resolvesEventId).map(item => item.resolvesEventId).sort())
      .toEqual([first.eventId, second.eventId].sort())
  })
})
