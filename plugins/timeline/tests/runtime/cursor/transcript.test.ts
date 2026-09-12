import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCursorHook } from '../../../src/agents/cursor/hooks'
import { hydrateCursor } from '../../../src/agents/cursor/transcript'
import { reduceEvents, toSnapshot } from '../../../src/shared/collectors/reduce'
import type { CollectorEvent } from '../../../src/shared/collectors/types'

const fixtures = path.resolve(import.meta.dirname, '../../fixtures/cursor')

function request(patch: Partial<CollectorEvent> = {}): CollectorEvent {
  const input = {
    conversation_id: 'c1', generation_id: 'c1', hook_event_name: 'sessionEnd',
    is_background_agent: false, transcript_path: path.join(fixtures, 'transcript.jsonl'),
    workspace_roots: ['/tmp/timeline-fixture'], model: 'grok-4.6',
  }
  return { ...parseCursorHook(input, 1000)[0], ...patch }
}

afterEach(() => vi.restoreAllMocks())

describe('hydrateCursor', () => {
  it('reconstructs two native user turns and keeps hook Read attempts authoritative', async () => {
    const hooks = JSON.parse(await readFile(path.join(fixtures, 'hook-sequence.json'), 'utf8'))
      .flatMap((input: unknown, index: number) => parseCursorHook({
        ...(input as Record<string, unknown>),
        transcript_path: input && (input as Record<string, unknown>).transcript_path
          ? path.join(fixtures, 'transcript.jsonl')
          : null,
      }, 1000 + index))
    const hydrated = await hydrateCursor(hooks)
    const snapshot = toSnapshot(reduceEvents(null, [...hooks, ...hydrated]))

    expect(snapshot).toMatchObject({
      sessionId: 'cursor:c1', project: '/tmp/timeline-fixture', turns: 2,
      tools: [{ toolName: 'Read', callCount: 2 }], model: 'cursor-grok-4.6-high-fast',
      tokenStatus: 'unavailable',
    })
    expect(hydrated.filter(event => event.resolvesEventId)).toHaveLength(4)
    expect(hydrated.filter(event => event.resolvesEventId)
      .every(event => event.needsHydration === false)).toBe(true)
  })

  it('counts cancellation and resume as two accepted prompts with one Read', async () => {
    const hooks = JSON.parse(await readFile(path.join(fixtures, 'cancelled-hook-sequence.json'), 'utf8'))
      .flatMap((input: unknown, index: number) => parseCursorHook({
        ...(input as Record<string, unknown>),
        transcript_path: path.join(fixtures, 'cancelled-resumed-transcript.jsonl'),
      }, 1000 + index))
    const hydrated = await hydrateCursor(hooks)

    expect(toSnapshot(reduceEvents(null, [...hooks, ...hydrated]))).toMatchObject({
      turns: 2, tools: [{ toolName: 'Read', callCount: 1 }], tokenStatus: 'unavailable',
    })
  })

  it('uses full prompt hashes plus occurrence indexes for stable duplicate turns', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'timeline-cursor-'))
    const transcriptPath = path.join(directory, 'duplicate.jsonl')
    const prompt = '<user_query>same prompt</user_query>'
    await writeFile(transcriptPath, [
      { role: 'user', message: { content: prompt } },
      { role: 'assistant', message: { content: 'one' } },
      { role: 'user', message: { content: prompt } },
      { role: 'assistant', message: { content: 'two' } },
    ].map(line => JSON.stringify(line)).join('\n') + '\n')
    const event = request({ transcriptPath })

    const first = await hydrateCursor([event])
    const second = await hydrateCursor([event])
    const turns = first.filter(item => item.prompt)

    expect(turns).toHaveLength(2)
    expect(new Set(turns.map(item => item.turnId)).size).toBe(2)
    expect(second.map(item => item.eventId)).toEqual(first.map(item => item.eventId))
  })

  it('does not double-count transcript turns when reliable hook turns exist', async () => {
    const reliable = parseCursorHook({
      conversation_id: 'c1', generation_id: 'turn-1', hook_event_name: 'beforeSubmitPrompt',
      prompt: 'hook prompt', transcript_path: path.join(fixtures, 'transcript.jsonl'),
    }, 900)[0]
    const confirm = parseCursorHook({
      conversation_id: 'c1', generation_id: 'turn-1', hook_event_name: 'afterAgentResponse',
      transcript_path: path.join(fixtures, 'transcript.jsonl'),
    }, 950)[0]
    const event = request()
    const hydrated = await hydrateCursor([reliable, confirm, event])

    expect(hydrated.some(item => item.prompt)).toBe(false)
    expect(toSnapshot(reduceEvents(null, [reliable, confirm, event, ...hydrated]))?.turns).toBe(1)
  })

  it('counts only transcript tools with native IDs and does not repeat hook IDs', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'timeline-cursor-'))
    const transcriptPath = path.join(directory, 'tools.jsonl')
    await writeFile(transcriptPath, [
      { role: 'user', message: { content: '<user_query>inspect</user_query>' } },
      { role: 'assistant', message: { content: [
        { type: 'tool_use', id: 'hook-call', name: 'Read' },
        { type: 'tool_use', id: 'transcript-call', name: 'Write' },
        { type: 'tool_use', name: 'IgnoredWithoutId' },
      ] } },
    ].map(line => JSON.stringify(line)).join('\n') + '\n')
    const lifecycle = request({ transcriptPath })
    const hookTool = parseCursorHook({
      conversation_id: 'c1', generation_id: 'c1', hook_event_name: 'postToolUse',
      tool_use_id: 'hook-call', tool_name: 'Read', transcript_path: transcriptPath,
    }, 900)[0]
    const hydrated = await hydrateCursor([hookTool, lifecycle])

    expect(toSnapshot(reduceEvents(null, [hookTool, lifecycle, ...hydrated]))?.tools).toEqual([
      { toolName: 'Read', callCount: 1 },
      { toolName: 'Write', callCount: 1 },
    ])
  })

  it('completes root lifecycle hydration when transcript capture is disabled', async () => {
    const lifecycle = request({ transcriptPath: undefined })
    const hydrated = await hydrateCursor([lifecycle])

    expect(hydrated).toContainEqual(expect.objectContaining({
      resolvesEventId: lifecycle.eventId,
      needsHydration: false,
      rootSession: true,
    }))
  })

  it('retains the exact request when the last JSONL line is incomplete', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'timeline-cursor-'))
    const transcriptPath = path.join(directory, 'partial.jsonl')
    await writeFile(transcriptPath, [
      JSON.stringify({ role: 'user', message: { content: '<user_query>accepted</user_query>' } }),
      JSON.stringify({ role: 'assistant', message: { content: 'response' } }),
      '{"role":"user"',
    ].join('\n'))
    const event = request({ transcriptPath })
    const hydrated = await hydrateCursor([event])

    expect(hydrated.some(item => item.prompt === 'accepted')).toBe(true)
    expect(hydrated.some(item => item.resolvesEventId === event.eventId)).toBe(false)
  })

  it('logs one private diagnostic for a corrupt middle line and completes the request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const directory = await mkdtemp(path.join(tmpdir(), 'timeline-cursor-'))
    const transcriptPath = path.join(directory, 'corrupt.jsonl')
    await writeFile(transcriptPath, [
      JSON.stringify({ role: 'user', message: { content: '<user_query>private prompt</user_query>' } }),
      '{bad private data}',
      JSON.stringify({ role: 'assistant', message: { content: 'private response' } }),
    ].join('\n') + '\n')
    const event = request({ transcriptPath })
    const hydrated = await hydrateCursor([event])

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/private prompt|private response|bad private data/)
    expect(hydrated.some(item => item.resolvesEventId === event.eventId)).toBe(true)
  })

  it('keeps a tool-only child pending until same-session root evidence appears', async () => {
    const childHooks = JSON.parse(await readFile(path.join(fixtures, 'subagent/hook-sequence.json'), 'utf8'))
    const child = parseCursorHook(childHooks[1], 1000)[0]

    expect(await hydrateCursor([child])).toEqual([])

    const rootEvidence = parseCursorHook({
      conversation_id: 'child', generation_id: 'child', hook_event_name: 'sessionStart',
      is_background_agent: false, transcript_path: null,
    }, 1100)[0]
    const resolved = await hydrateCursor([child, rootEvidence])
    const completion = resolved.find(item => item.resolvesEventId === child.eventId)

    expect(completion).toMatchObject({
      tool: child.tool, unresolvedParent: false, resolvesEventId: child.eventId,
    })
  })

  it('does not promote an unlinked child from valid transcript content alone', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'timeline-cursor-'))
    const transcriptPath = path.join(directory, 'child.jsonl')
    await writeFile(transcriptPath, [
      JSON.stringify({ role: 'user', message: { content: '<user_query>child query</user_query>' } }),
      JSON.stringify({ role: 'assistant', message: { content: 'child response' } }),
    ].join('\n') + '\n')
    const child = parseCursorHook({
      conversation_id: 'child', generation_id: 'child', hook_event_name: 'postToolUse',
      tool_use_id: 'child-call', tool_name: 'Read', transcript_path: transcriptPath,
    }, 1000)[0]

    const pending = await hydrateCursor([child])
    expect(child).toMatchObject({ unresolvedParent: true, needsHydration: true })
    expect(pending.some(item => item.resolvesEventId === child.eventId)).toBe(false)
    expect(pending.every(item => item.unresolvedParent === true)).toBe(true)
    expect(toSnapshot(reduceEvents(null, [child, ...pending]))).toBeNull()

    const rootEvidence = parseCursorHook({
      conversation_id: 'child', generation_id: 'child', hook_event_name: 'sessionStart',
      is_background_agent: false, transcript_path: null,
    }, 1100)[0]
    const resolved = await hydrateCursor([child, rootEvidence])
    expect(resolved).toContainEqual(expect.objectContaining({
      resolvesEventId: child.eventId, unresolvedParent: false, needsHydration: false,
    }))
    expect(toSnapshot(reduceEvents(null, [rootEvidence, ...resolved]))).toMatchObject({
      turns: 1, tools: [{ toolName: 'Read', callCount: 1 }],
    })
  })

  it('does not let an older completion acknowledge a newer lifecycle request', async () => {
    const first = request({ eventId: 'a'.repeat(64), observedAt: 1000 })
    const second = request({ eventId: 'b'.repeat(64), observedAt: 2000 })
    const hydrated = await hydrateCursor([first, second])

    expect(hydrated.filter(item => item.resolvesEventId).map(item => item.resolvesEventId).sort())
      .toEqual([first.eventId, second.eventId])
  })
})
