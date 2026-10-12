import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { CollectorEvent } from '../../../src/shared/collectors/types'
import type { ParsedSessionData } from '@ohmyc/timeline/schema'
import { afterEach, describe, expect, it } from 'vitest'
import { detectHost } from '../../../src/shared/collectors/identity'
import { ingestEvents, replayPending } from '../../../src/shared/collectors/ingest-event'
import { reduceEvents, toSnapshot } from '../../../src/shared/collectors/reduce'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const envelope = { client_type: 'kimi_code_cli', session_id: 'k1', cwd: '/tmp/demo' }

async function adapter() {
  return {
    ...await import('../../../src/agents/kimi/hooks'),
    ...await import('../../../src/agents/kimi/session'),
  }
}

describe('Kimi collection', () => {
  it('parses native CLI 2.1.1 captures from two consecutive turns', async () => {
    const { parseKimiWire, parseKimiHook } = await adapter()
    const fixtures = path.resolve(import.meta.dirname, '../../fixtures/kimi')
    const wire = await readFile(path.join(fixtures, 'native-2.1.1-wire.jsonl'), 'utf8')
    const hooks: unknown[] = JSON.parse(await readFile(path.join(fixtures, 'native-2.1.1-hooks.json'), 'utf8'))
    const snapshot = toSnapshot(reduceEvents(null, [
      ...parseKimiWire(wire, 'native-session', 2000),
      ...hooks.flatMap((hook, index) => parseKimiHook(hook, 2000 + index)),
    ]))!
    expect(snapshot).toMatchObject({ turns: 2, model: 'test', tokensInput: 240, tokensOutput: 30, tokensCached: 60, tokenStatus: 'complete' })
    expect(snapshot.tools).toEqual([{ toolName: 'Read', callCount: 1 }])
    expect(snapshot.skills).toEqual(['check'])
  })
  it('routes native Kimi through the packaged ingest CLI', () => {
    const cli = path.resolve(import.meta.dirname, '../../../dist/ingest.mjs')
    expect(execFileSync(process.execPath, [cli, '--detect-host'], {
      input: JSON.stringify({ ...envelope, hook_event_name: 'Stop' }), encoding: 'utf8',
    }).trim()).toBe('kimi')
  })
  it('detects native Kimi without treating Claude envelopes or model names as a host', () => {
    expect(detectHost({ ...envelope, hook_event_name: 'SessionStart' }, {})).toBe('kimi')
    expect(detectHost({ session_id: 'c1', hook_event_name: 'Stop', model: 'kimi' }, {})).toBeNull()
    expect(detectHost({ ...envelope, hook_event_name: 'Stop', sessionId: 'g1', hookEventName: 'stop' }, {})).toBeNull()
  })

  it('counts only started user turns and deduplicates native tool calls', async () => {
    const { parseKimiHook } = await adapter()
    const sequence = [
      { hook_event_name: 'UserPromptSubmit', prompt: 'blocked' },
      { hook_event_name: 'UserPromptQueued', prompt_id: 'queued', prompt: 'waiting' },
      { hook_event_name: 'TurnStarted', turn_id: 0, origin_kind: 'user', prompt: 'hello' },
      { hook_event_name: 'TurnStarted', turn_id: 1, origin_kind: 'task', prompt: 'background' },
      { hook_event_name: 'PostToolUse', tool_call_id: 'call1', tool_name: 'Skill', tool_input: { skill: 'review' }, tool_output: 'loaded' },
      { hook_event_name: 'PostToolUseFailure', tool_call_id: 'call2', tool_name: 'Skill', tool_input: { skill: 'missing' }, error: { message: 'missing' } },
      { hook_event_name: 'Interrupt', turn_id: 0, reason: 'cancelled' },
    ].flatMap((data, i) => parseKimiHook({ ...envelope, ...data }, 1000 + i))
    const snapshot = toSnapshot(reduceEvents(null, [...sequence, ...sequence]))!
    expect(snapshot).toMatchObject({ sessionId: 'kimi:k1', agentName: 'kimi', turns: 1, summary: 'hello', tokenStatus: 'unavailable' })
    expect(snapshot.tools).toEqual([{ toolName: 'Skill', callCount: 2 }])
    expect(snapshot.skills).toEqual(['review'])
    expect(parseKimiHook({ ...envelope, hook_event_name: 'TurnStarted', origin_kind: 'user', prompt: 'no id' }, 1)).toEqual([])
    expect(parseKimiHook({ ...envelope, client_type: 'claude', hook_event_name: 'Stop' }, 1)).toEqual([])
  })

  it('recognizes successful SKILL.md reads without guessing from prose or failed reads', async () => {
    const { parseKimiHook } = await adapter()
    const read = { ...envelope, hook_event_name: 'PostToolUse', tool_call_id: 'r1', tool_name: 'Read', tool_input: { path: '/tmp/demo/skills/lint/SKILL.md' }, tool_output: '1\t# lint' }
    expect(parseKimiHook(read, 1)[0].tool?.skill).toBe('lint')
    expect(parseKimiHook({ ...read, hook_event_name: 'PostToolUseFailure', error: {} }, 1)[0].tool?.skill).toBeUndefined()
    expect(parseKimiHook({ ...read, tool_input: { path: 'README.md' }, tool_output: 'see skills/lint/SKILL.md' }, 1)[0].tool?.skill).toBeUndefined()
    expect(JSON.stringify(parseKimiHook(read, 1))).not.toContain('1\\t# lint')
  })

  it('hydrates request usage once and survives journal reload and pending replay', async () => {
    const { parseKimiHook, hydrateKimi } = await adapter()
    const root = await mkdtemp(path.join(os.tmpdir(), 'timeline-kimi-'))
    roots.push(root)
    const directory = path.join(root, 'sessions/wd_demo/k1')
    await mkdir(path.join(directory, 'agents/main'), { recursive: true })
    await writeFile(path.join(root, 'session_index.jsonl'), JSON.stringify({ sessionId: 'k1', sessionDir: directory, workDir: '/tmp/demo' }) + '\n')
    await writeFile(path.join(directory, 'state.json'), JSON.stringify({ title: 'Kimi fixture', createdAt: '2026-10-08T01:00:00Z', updatedAt: '2026-10-08T01:00:05Z' }))
    const wire = await readFile(path.resolve(import.meta.dirname, '../../fixtures/kimi/wire.jsonl'), 'utf8')
    await writeFile(path.join(directory, 'agents/main/wire.jsonl'), wire)
    const snapshots: ParsedSessionData[] = []
    const deps = { home: path.join(root, 'ohmyc'), hydrate: (events: readonly CollectorEvent[]) => hydrateKimi(events, root), write: (data: ParsedSessionData) => { snapshots.push(data) } }
    const stop = parseKimiHook({ ...envelope, hook_event_name: 'Stop' }, Date.parse('2026-10-08T01:00:06Z'))
    await ingestEvents(stop, deps)
    await ingestEvents(stop, deps)
    expect(snapshots.at(-1)).toMatchObject({ turns: 2, model: 'kimi-test', tokensInput: 130, tokensCached: 20, tokensOutput: 15, tokenStatus: 'complete', summary: 'Kimi fixture' })
    expect(snapshots.at(-1)!.tools).toEqual([{ toolName: 'Read', callCount: 1 }])
    expect(snapshots.at(-1)!.skills).toEqual(['lint'])
    const delayed = parseKimiHook({ ...envelope, session_id: 'late', hook_event_name: 'Stop' }, Date.parse('2026-10-08T01:00:07Z'))
    await ingestEvents(delayed, deps)
    expect(await replayPending(deps)).toMatchObject({ queued: 1 })
    await writeFile(path.join(root, 'session_index.jsonl'), JSON.stringify({ sessionId: 'late', sessionDir: path.join(root, 'sessions/wd_demo/late'), workDir: '/tmp/demo' }) + '\n')
    await mkdir(path.join(root, 'sessions/wd_demo/late/agents/main'), { recursive: true })
    await writeFile(path.join(root, 'sessions/wd_demo/late/state.json'), '{}')
    await writeFile(path.join(root, 'sessions/wd_demo/late/agents/main/wire.jsonl'), wire)
    expect(await replayPending(deps)).toEqual({ written: 1, queued: 0 })
  })

  it('keeps malformed usage partial and rejects unknown wire versions and escaping session paths', async () => {
    const { parseKimiWire } = await adapter()
    const wire = await readFile(path.resolve(import.meta.dirname, '../../fixtures/kimi/wire.jsonl'), 'utf8')
    const events = parseKimiWire(wire + '{"type":"usage.record","usage":{"inputOther":-1}}\n', 'k1', 2000)
    expect(toSnapshot(reduceEvents(null, events))).toMatchObject({ tokenStatus: 'partial', tokensInput: 130 })
    expect(parseKimiWire(wire.replace('"1.5"', '"99.0"'), 'k1', 2000)).toEqual([])
    const { hydrateKimi, parseKimiHook } = await adapter()
    const root = await mkdtemp(path.join(os.tmpdir(), 'timeline-kimi-path-'))
    roots.push(root)
    await writeFile(path.join(root, 'session_index.jsonl'), JSON.stringify({ sessionId: 'k1', sessionDir: '/tmp/outside/k1' }) + '\n')
    expect(await hydrateKimi(parseKimiHook({ ...envelope, hook_event_name: 'Stop' }, 1000), root)).toEqual([])
  })

  it('does not charge inherited fork history to the new session', async () => {
    const { hydrateKimi, parseKimiHook } = await adapter()
    const root = await mkdtemp(path.join(os.tmpdir(), 'timeline-kimi-fork-'))
    roots.push(root)
    const directory = path.join(root, 'sessions/wd_demo/k1')
    await mkdir(path.join(directory, 'agents/main'), { recursive: true })
    await writeFile(path.join(root, 'session_index.jsonl'), JSON.stringify({ sessionId: 'k1', sessionDir: directory, workDir: '/tmp/demo' }) + '\n')
    await writeFile(path.join(directory, 'state.json'), JSON.stringify({ id: 'k1', forkedFrom: 'parent', createdAt: 1791421206500 }))
    const inherited = await readFile(path.resolve(import.meta.dirname, '../../fixtures/kimi/wire.jsonl'), 'utf8')
    const newRecords = [
      { type: 'turn.prompt', agentId: 'main', turnId: 3, input: [{ type: 'text', text: 'fork turn' }], origin: { kind: 'user' }, time: 1791421207000 },
      { type: 'usage.record', agentId: 'main', model: 'kimi-test', usage: { inputOther: 80, output: 10, inputCacheRead: 20, inputCacheCreation: 0 }, time: 1791421208000 },
    ]
    await writeFile(path.join(directory, 'agents/main/wire.jsonl'), inherited + newRecords.map(record => JSON.stringify(record)).join('\n') + '\n')
    const stop = parseKimiHook({ ...envelope, hook_event_name: 'Stop' }, 1791421209000)
    const snapshot = toSnapshot(reduceEvents(null, await hydrateKimi(stop, root)))!
    expect(snapshot).toMatchObject({ turns: 1, tokensInput: 80, tokensOutput: 10, tokensCached: 20 })
    expect(snapshot.tools).toEqual([])
    await writeFile(path.join(directory, 'state.json'), JSON.stringify({ id: 'different' }))
    expect(await hydrateKimi(stop, root)).toEqual([])
  })

  it('distinguishes missing usage from measured zero usage', async () => {
    const { parseKimiWire } = await adapter()
    const prefix = '{"type":"metadata","protocol_version":"1.5","created_at":1000}\n'
    expect(toSnapshot(reduceEvents(null, parseKimiWire(prefix, 'k1', 2000)))).toBeNull()
    const prompt = '{"type":"turn.prompt","turnId":0,"origin":{"kind":"user"},"input":[{"type":"text","text":"hello"}],"time":1001}\n'
    expect(toSnapshot(reduceEvents(null, parseKimiWire(prefix + prompt, 'k1', 2000)))?.tokenStatus).toBe('unavailable')
    const zero = '{"type":"usage.record","usage":{"inputOther":0,"inputCacheCreation":0,"inputCacheRead":0,"output":0},"time":1002}\n'
    expect(toSnapshot(reduceEvents(null, parseKimiWire(prefix + prompt + zero, 'k1', 2000)))?.tokenStatus).toBe('complete')
  })
})
