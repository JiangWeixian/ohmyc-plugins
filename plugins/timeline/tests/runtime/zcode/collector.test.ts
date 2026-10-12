import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ParsedSessionData } from '@ohmyc/timeline/schema'
import { parseZcodeHook } from '../../../src/agents/zcode/hooks'
import { detectHost } from '../../../src/shared/collectors/identity'
import { ingestEvents, replayPending } from '../../../src/shared/collectors/ingest-event'
import { reduceEvents, toSnapshot } from '../../../src/shared/collectors/reduce'

const envelope = { sessionId: 'sess_test', session_id: 'sess_test', cwd: '/tmp/demo', mode: 'yolo', traceId: 'trace_1', turnId: 'turn_1', timestamp: '2026-10-08T01:00:00Z' }
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const hook = (hookEventName: string, extra: Record<string, unknown> = {}) => ({ ...envelope, hookEventName, hook_event_name: hookEventName, ...extra })

describe('ZCode collection', () => {
  it('parses hooks captured from native 0.16.9 startup and resumed turns', async () => {
    const records: { input: Record<string, unknown>; transcript: string }[] = JSON.parse(await readFile(path.resolve(import.meta.dirname, '../../fixtures/zcode/native-0.16.9-hooks.json'), 'utf8'))
    const events = (await Promise.all(records.map(record => parseZcodeHook(record.input, 1)))).flat()
    expect(toSnapshot(reduceEvents(null, [...events, ...events]))).toMatchObject({ sessionId: 'zcode:sess_native', turns: 2, model: 'test/glm-test', tokenStatus: 'unavailable', tools: [{ toolName: 'Read', callCount: 1 }], skills: ['check'] })
    for (const record of records) expect(detectHost(record.input, { ZCODE_SESSION_ID: 'sess_native' })).toBe('zcode')
  })
  it('uses native ZCode evidence before Claude aliases or inherited Grok environment', () => {
    expect(detectHost(hook('Stop'), { ZCODE_SESSION_ID: 'sess_test', GROK_SESSION_ID: 'stale' })).toBe('zcode')
    expect(detectHost({ session_id: 'c', hook_event_name: 'Stop', model: 'glm-5' }, {})).toBeNull()
    expect(detectHost({ sessionId: 'g', hookEventName: 'stop' }, {})).toBe('grok')
    expect(detectHost(hook('Stop'), { ZCODE_SESSION_ID: 'other' })).toBeNull()
    expect(detectHost(hook('Stop', { conversation_id: 'cursor' }), { ZCODE_SESSION_ID: 'sess_test' })).toBeNull()
    expect(detectHost(hook('Stop', { client_type: 'kimi_code_cli' }), { ZCODE_SESSION_ID: 'sess_test' })).toBeNull()
  })

  it('counts completed native turns once across resume and repeated Stop delivery', async () => {
    const events = [
      ...await parseZcodeHook(hook('SessionStart', { model: 'glm-test', source: 'startup' }), 1),
      ...await parseZcodeHook(hook('UserPromptSubmit', { prompt: 'first prompt' }), 2),
      ...await parseZcodeHook(hook('Stop', { responseText: 'done' }), 3),
      ...await parseZcodeHook(hook('Stop', { responseText: 'done' }), 30),
      ...await parseZcodeHook(hook('SessionStart', { model: 'glm-test', source: 'resume' }), 4),
      ...await parseZcodeHook(hook('UserPromptSubmit', { turnId: 'turn_2', prompt: 'second' }), 5),
      ...await parseZcodeHook(hook('Stop', { turnId: 'turn_2' }), 6),
      ...await parseZcodeHook(hook('UserPromptSubmit', { turnId: 'blocked', prompt: 'blocked' }), 7),
    ]
    expect(toSnapshot(reduceEvents(null, events))).toMatchObject({ sessionId: 'zcode:sess_test', agentName: 'zcode', turns: 2, model: 'glm-test', summary: 'first prompt', tokensInput: 0, tokensOutput: 0, tokenStatus: 'unavailable', transcriptPath: 'zcode://sess_test', startedAt: Date.parse(envelope.timestamp) })
    expect(Object.keys(reduceEvents(null, events).events)).length(events.length - 2)
    expect(toSnapshot(reduceEvents(null, await parseZcodeHook(hook('UserPromptSubmit', { prompt: 'blocked' }), 1)))).toBeNull()
  })

  it('deduplicates tools by native ID and counts skills only on successful native calls', async () => {
    const tool = { toolCallId: 'call_1', toolName: 'Read', toolInput: { file_path: '/tmp/demo/skills/lint/SKILL.md' }, toolResponse: { filePath: '/tmp/demo/skills/lint/SKILL.md', content: 'skill' } }
    const events = [
      ...await parseZcodeHook(hook('PostToolUse', tool), 1),
      ...await parseZcodeHook(hook('PostToolUse', tool), 2),
      ...await parseZcodeHook(hook('PostToolUseFailure', { ...tool, toolCallId: 'call_2', error: { message: 'missing' } }), 3),
    ]
    const snapshot = toSnapshot(reduceEvents(null, events))!
    expect(snapshot.tools).toEqual([{ toolName: 'Read', callCount: 2 }])
    expect(snapshot.skills).toEqual(['lint'])
    expect((await parseZcodeHook(hook('PostToolUse', { ...tool, toolResponse: { filePath: '/tmp/other/SKILL.md' } }), 4)).some(event => event.tool?.skill)).toBe(false)
    expect((await parseZcodeHook(hook('PostToolUse', { ...tool, toolResponse: {} }), 4)).some(event => event.tool?.skill)).toBe(false)
    expect(JSON.stringify(events)).not.toContain('"content":"skill"')
    expect((await parseZcodeHook(hook('PreToolUse', tool), 1))[0]?.tool).toBeUndefined()
  })

  it('normalizes temporary transcript before enqueue and replays after the file disappears', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'timeline-zcode-'))
    roots.push(root)
    const transcript = path.join(root, 'transcript.jsonl')
    await writeFile(transcript, JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'temporary prompt' }] } }) + '\n')
    const events = [
      ...await parseZcodeHook(hook('UserPromptSubmit', { transcript_path: transcript }), 1),
      ...await parseZcodeHook(hook('Stop', { transcript_path: transcript }), 2),
    ]
    const deps = { home: path.join(root, 'ohmyc'), hydrate: async () => [], write: () => { throw new Error('database locked') } }
    await ingestEvents(events, deps)
    await rm(transcript)
    const snapshots: ParsedSessionData[] = []
    expect(await replayPending({ ...deps, write: data => { snapshots.push(data) } })).toEqual({ written: 1, queued: 0 })
    expect(snapshots[0]).toMatchObject({ turns: 1, summary: 'temporary prompt', tokenStatus: 'unavailable', transcriptPath: 'zcode://sess_test' })
    expect(JSON.stringify(events)).not.toContain(transcript)
  })

  it('rejects malformed identity and uses hook facts when temporary transcript is missing', async () => {
    expect(await parseZcodeHook(hook('Stop', { session_id: 'other' }), 1)).toEqual([])
    expect(await parseZcodeHook(hook('Stop', { turnId: undefined }), 1)).toEqual([])
    expect(await parseZcodeHook(hook('Stop'), NaN)).toEqual([])
    expect(await parseZcodeHook(hook('Unknown'), 1)).toEqual([])
    expect((await parseZcodeHook(hook('UserPromptSubmit', { prompt: 'native', transcript_path: '/nonexistent' }), 1))[0].prompt).toBe('native')
  })
})
