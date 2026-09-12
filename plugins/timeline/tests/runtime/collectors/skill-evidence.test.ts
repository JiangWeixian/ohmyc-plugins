import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseCursorHook } from '../../../src/agents/cursor/hooks'
import { hydrateCursor } from '../../../src/agents/cursor/transcript'
import { parseGrokHook } from '../../../src/agents/grok/hooks'
import { hydrateGrok } from '../../../src/agents/grok/session'
import { ingestEvents, replayPending } from '../../../src/shared/collectors/ingest-event'
import { reduceEvents, toSnapshot } from '../../../src/shared/collectors/reduce'
import type { ParsedSessionData } from '@ohmyc/timeline/schema'

const skillPath = '/tmp/project/skills/inspect/SKILL.md'
const homes: string[] = []
async function home() {
  const value = await mkdtemp(path.join(os.tmpdir(), 'skill-evidence-'))
  homes.push(value)
  return value
}
afterEach(async () => { await Promise.all(homes.splice(0).map(value => rm(value, { recursive: true, force: true }))) })
const cursor = {
  conversation_id: 'c1', generation_id: 't1', hook_event_name: 'postToolUse',
  tool_use_id: 'read1', tool_name: 'Read', cwd: '/tmp/project',
  tool_input: { file_path: skillPath },
  tool_output: JSON.stringify({ file_path: skillPath, content_length: 123 }),
}
const grok = {
  sessionId: 'g1', promptId: 't1', hookEventName: 'post_tool_use',
  toolUseId: 'read1', toolName: 'read_file', cwd: '/tmp/project',
  toolInput: { target_file: 'skills/inspect/SKILL.md' },
  toolResult: { type: 'ReadFile', FileContent: { absolute_path: skillPath, content: '# Inspect' } },
}

describe('native skill read evidence', () => {
  it.each([
    ['Cursor', parseCursorHook, cursor, 'Read'],
    ['Grok', parseGrokHook, grok, 'read_file'],
  ] as const)('%s records one skill and tool across durable replay', async (_host, parse, input, toolName) => {
    const events = parse(input, 1000)
    expect(events[0].tool?.skill).toBe('inspect')
    const snapshots: ParsedSessionData[] = []
    const deps = { home: await home(), hydrate: async () => [], write: (data: ParsedSessionData) => { snapshots.push(data) } }
    await ingestEvents(events, deps)
    await ingestEvents(parse(input, 2000), deps)
    await replayPending(deps)
    expect(snapshots.at(-1)).toMatchObject({ skills: ['inspect'], tools: [{ toolName, callCount: 1 }] })
    expect(JSON.stringify(events)).not.toContain(skillPath)
  })

  it.each([
    { hook_event_name: 'postToolUseFailure' },
    { is_error: true }, { isError: true },
    { tool_output: JSON.stringify({ file_path: skillPath, content_length: 1, is_error: true }) },
    { tool_output: JSON.stringify({ file_path: '/tmp/other/SKILL.md', content_length: 1 }) },
    { tool_output: JSON.stringify({ file_path: skillPath }) },
    { tool_output: 'I read the inspect skill successfully' },
    { tool_name: 'Write' },
    { tool_input: { file_path: '/tmp/project/skills/inspect/README.md' } },
  ])('Cursor rejects unsuccessful or conflicting evidence: %j', patch => {
    const events = parseCursorHook({ ...cursor, ...patch }, 1)
    expect(events[0].tool?.skill).toBeUndefined()
  })

  it.each([
    { hookEventName: 'post_tool_use_failure' },
    { is_error: true }, { isError: true }, { toolResultTruncated: true },
    { toolResult: { type: 'ReadFile', FileNotFound: 'missing' } },
    { toolResult: { ...grok.toolResult, FileNotFound: 'missing' } },
    { toolResult: { type: 'ReadFile', FileContent: { absolute_path: '/tmp/other/SKILL.md', content: 'other' } } },
    { toolResult: { type: 'ReadFile', FileContent: { absolute_path: skillPath } } },
    { toolResult: 'Read inspect/SKILL.md successfully' },
    { toolName: 'write_file' }, { cwd: undefined },
  ])('Grok rejects unsuccessful or conflicting evidence: %j', patch => {
    const events = parseGrokHook({ ...grok, ...patch }, 1)
    expect(events[0].tool?.skill).toBeUndefined()
  })

  it('forwards validated Grok child skill evidence once to its parent', async () => {
    const root = await home()
    for (const [id, extra] of [['parent', { session_kind: 'headless' }], ['child', { session_kind: 'subagent', parent_session_id: 'parent' }]] as const) {
      const dir = path.join(root, 'sessions', 'project', id)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'summary.json'), JSON.stringify({ info: { id, cwd: '/tmp/project' }, chat_format_version: 1, ...extra }))
    }
    const events = parseGrokHook({ ...grok, sessionId: 'child', subagentType: 'general-purpose' }, 1)
    expect(toSnapshot(reduceEvents(null, events))).toBeNull()
    const forwarded = await hydrateGrok(events, root)
    expect(toSnapshot(reduceEvents(null, [...forwarded, ...forwarded])))
      .toMatchObject({ sessionId: 'grok:parent', skills: ['inspect'], turns: 0, tools: [{ toolName: 'read_file', callCount: 1 }] })
  })

  it('Cursor hydration counts only matched successful read results', async () => {
    const root = await home()
    const transcript = path.join(root, 'transcript.jsonl')
    await writeFile(transcript, [
      { role: 'user', message: { content: '<user_query>inspect</user_query>' } },
      { role: 'assistant', message: { content: [
        { type: 'tool_use', id: 'ok', name: 'Read', input: { file_path: skillPath } },
        { type: 'tool_use', id: 'bad', name: 'Read', input: { file_path: '/tmp/skills/failed/SKILL.md' } },
        { type: 'tool_use', id: 'pending', name: 'Read', input: { file_path: '/tmp/skills/pending/SKILL.md' } },
      ] } },
      { role: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'ok', content: cursor.tool_output },
        { type: 'tool_result', tool_use_id: 'bad', is_error: true, content: JSON.stringify({ file_path: '/tmp/skills/failed/SKILL.md', content_length: 20 }) },
      ] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
    const events = parseCursorHook({ conversation_id: 'c1', hook_event_name: 'sessionEnd', is_background_agent: false, transcript_path: transcript }, 1)
    const hydrated = await hydrateCursor(events)
    expect(toSnapshot(reduceEvents(null, [...events, ...hydrated, ...hydrated])))
      .toMatchObject({ skills: ['inspect'], tools: [{ toolName: 'Read', callCount: 3 }] })
  })
})
