import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCursorHook } from '../../../src/agents/cursor/hooks'

const fixtures = path.resolve(import.meta.dirname, '../../fixtures/cursor')

async function fixture(name: string): Promise<Record<string, unknown>[]> {
  return JSON.parse(await readFile(path.join(fixtures, name), 'utf8'))
}

describe('parseCursorHook', () => {
  it('records a candidate turn without requiring a transcript', () => {
    const [event] = parseCursorHook({
      hook_event_name: 'beforeSubmitPrompt',
      conversation_id: 'c1',
      generation_id: 't1',
      prompt: 'hello',
      cwd: '/tmp/demo/packages/app',
      workspace_roots: ['/tmp/demo', '/tmp/other'],
      model: 'grok-code',
      transcript_path: null,
    }, 1000)

    expect(event).toMatchObject({
      agent: 'cursor',
      nativeSessionId: 'c1',
      turnId: 't1',
      prompt: 'hello',
      project: '/tmp/demo',
      model: 'grok-code',
    })
    expect(event.confirmsTurn).not.toBe(true)
  })

  it('normalizes duplicate success and failure reports to one tool identity', () => {
    const input = {
      conversation_id: 'c1', generation_id: 't1',
      tool_use_id: 'call1', tool_name: 'Shell',
    }
    const failure = parseCursorHook({ ...input, hook_event_name: 'postToolUseFailure' }, 1000)[0]
    const success = parseCursorHook({ ...input, hook_event_name: 'postToolUse' }, 2000)[0]

    expect(failure.eventId).toBe(success.eventId)
    expect(success).toMatchObject({
      turnId: 't1', confirmsTurn: true, tool: { id: 'call1', name: 'Shell' },
    })
  })

  it('maps native CLI root facts and keeps same-session IDs out of turn identity', async () => {
    const inputs = await fixture('hook-sequence.json')
    const events = inputs.flatMap((input, index) => parseCursorHook(input, 1000 + index))

    expect(events[0]).toMatchObject({
      nativeSessionId: 'c1', rootSession: true, project: '/tmp/timeline-fixture',
    })
    expect(events.every(event => event.turnId === undefined)).toBe(true)
    expect(events.filter(event => event.tool).map(event => event.tool)).toEqual([
      { id: 'call1', name: 'Read' },
      { id: 'call2', name: 'Read' },
    ])
    expect(events.filter(event => event.needsHydration)).toHaveLength(2)
  })

  it('keeps a native tool-only child pending without guessing its parent', async () => {
    const inputs = await fixture('subagent/hook-sequence.json')
    const child = parseCursorHook(inputs[1], 1000)[0]

    expect(child).toMatchObject({
      nativeSessionId: 'child',
      unresolvedParent: true,
      tool: { id: expect.stringContaining('fc_fixture_child_tool'), name: 'Read' },
    })
    expect(child.sourceSessionId).toBeUndefined()
  })

  it('validates unknown payloads and chooses a project conservatively', () => {
    expect(parseCursorHook(null, 1)).toEqual([])
    expect(parseCursorHook({ conversation_id: 'c1', hook_event_name: [] }, 1)).toEqual([])
    expect(parseCursorHook({
      conversation_id: 'c1', generation_id: 't1', hook_event_name: 'afterAgentResponse',
      cwd: '/tmp/shared/nested', workspace_roots: ['/tmp', '/tmp/shared'],
    }, 1)[0].project).toBe('/tmp/shared/nested')
  })

  it('does not retain raw prompt or response bodies beyond the prompt summary', () => {
    const longPrompt = 'p'.repeat(200)
    const prompt = parseCursorHook({
      conversation_id: 'c1', generation_id: 't1', hook_event_name: 'beforeSubmitPrompt',
      prompt: longPrompt,
    }, 1)[0]
    const response = parseCursorHook({
      conversation_id: 'c1', generation_id: 't1', hook_event_name: 'afterAgentResponse',
      response: 'secret response',
    }, 2)[0]

    expect(prompt.prompt).toBe('p'.repeat(140))
    expect(JSON.stringify(response)).not.toContain('secret response')
  })
})
