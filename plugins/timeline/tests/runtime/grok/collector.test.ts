import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseGrokHook } from '../../../src/agents/grok/hooks'

const fixtures = path.resolve(import.meta.dirname, '../../fixtures/grok')

async function fixture(name: string): Promise<Record<string, unknown>[]> {
  return JSON.parse(await readFile(path.join(fixtures, name), 'utf8'))
}

describe('parseGrokHook', () => {
  it('maps native prompt and tool identity without confirming the prompt early', () => {
    const prompt = parseGrokHook({
      hookEventName: 'user_prompt_submit', sessionId: 'g1', promptId: 'p1', prompt: 'hello',
      workspaceRoot: '/tmp/demo/', timestamp: '2026-09-12T01:00:00Z',
    }, 1000)[0]
    const tool = parseGrokHook({
      hookEventName: 'post_tool_use_failure', sessionId: 'g1', promptId: 'p1',
      toolUseId: 'call1', toolName: 'read_file', cwd: '/tmp/demo',
      timestamp: '2026-09-12T01:00:01Z',
    }, 1001)[0]

    expect(prompt).toMatchObject({
      agent: 'grok', nativeSessionId: 'g1', turnId: 'p1', prompt: 'hello',
      project: '/tmp/demo/', sourceAt: Date.parse('2026-09-12T01:00:00Z'),
    })
    expect(prompt.confirmsTurn).not.toBe(true)
    expect(tool).toMatchObject({
      turnId: 'p1', confirmsTurn: true, tool: { id: 'call1', name: 'read_file' },
    })
  })

  it('uses the PascalCase compatibility field only through the fixed event table', () => {
    expect(parseGrokHook({
      hook_event_name: 'StopCancelled', sessionId: 'g1', promptId: 'p1',
    }, 1000)[0]).toMatchObject({ confirmsTurn: true, needsHydration: true })
    expect(parseGrokHook({ hook_event_name: 'MadeUpEvent', sessionId: 'g1' }, 1000)).toEqual([])
  })

  it('does not create a prompt for the extra session-end stop', () => {
    const [event] = parseGrokHook({
      hookEventName: 'stop', hook_event_name: 'Stop', sessionId: 'g1',
      workspaceRoot: '/tmp/demo', timestamp: '2026-09-12T01:00:00Z',
    }, 1000)

    expect(event).toMatchObject({ agent: 'grok', nativeSessionId: 'g1', needsHydration: true })
    expect(event.prompt).toBeUndefined()
    expect(event.turnId).toBeUndefined()
  })

  it('requires native prompt IDs and excludes automatic and subagent prompts', () => {
    expect(parseGrokHook({
      hookEventName: 'user_prompt_submit', sessionId: 'g1', prompt: 'no id',
    }, 1000)).toEqual([])
    expect(parseGrokHook({
      hookEventName: 'user_prompt_submit', sessionId: 'child', promptId: 'p1',
      prompt: 'child instruction', subagentType: 'general-purpose',
    }, 1000)).toEqual([])
  })

  it('keeps SubagentStart on its parent session despite subagentType', () => {
    const [event] = parseGrokHook({
      hookEventName: 'subagent_start', sessionId: 'parent', subagentId: 'child',
      subagentType: 'general-purpose', workspaceRoot: '/tmp/demo',
    }, 1000)

    expect(event).toMatchObject({ nativeSessionId: 'parent', rootSession: true })
    expect(event.unresolvedParent).toBeUndefined()
    expect(event.sourceSessionId).toBeUndefined()
  })

  it('keeps child tool and lifecycle facts pending for validated parent metadata', () => {
    const tool = parseGrokHook({
      hookEventName: 'post_tool_use', sessionId: 'child', promptId: 'cp1',
      toolUseId: 'child-call', toolName: 'read_file', subagentType: 'general-purpose',
    }, 1000)[0]
    const end = parseGrokHook({
      hookEventName: 'session_end', sessionId: 'child', subagentType: 'general-purpose',
    }, 1001)[0]

    expect(tool).toMatchObject({
      nativeSessionId: 'child', unresolvedParent: true, needsHydration: true,
      tool: { id: 'child-call', name: 'read_file' },
    })
    expect(end).toMatchObject({ unresolvedParent: true, needsHydration: true })
    expect(end.rootSession).toBeUndefined()
  })

  it('maps the captured main and cancelled fixtures without duplicate tool identities', async () => {
    const main = (await fixture('hook-sequence.json'))
      .flatMap((input, index) => parseGrokHook(input, 1000 + index))
    const cancelled = (await fixture('cancelled-hook-sequence.json'))
      .flatMap((input, index) => parseGrokHook(input, 2000 + index))

    expect(main.filter(event => event.prompt)).toHaveLength(2)
    expect(main.filter(event => event.tool).map(event => event.tool)).toEqual([
      { id: 'call1', name: 'read_file' },
      { id: 'call2', name: 'read_file' },
    ])
    expect(cancelled.filter(event => event.prompt)).toHaveLength(1)
    expect(cancelled.some(event => event.tool?.id === 'call-cancelled')).toBe(true)
    expect(cancelled.some(event => event.confirmsTurn && event.turnId === 'prompt-cancelled')).toBe(true)
  })

  it('validates envelopes and does not retain response or tool payload bodies', () => {
    expect(parseGrokHook(null, 1)).toEqual([])
    expect(parseGrokHook({ hookEventName: 'stop', sessionId: [] }, 1)).toEqual([])
    const [event] = parseGrokHook({
      hookEventName: 'post_tool_use', sessionId: 'g1', toolUseId: 'c1',
      toolName: 'read_file', toolInput: { secret: 'input' }, toolResult: { secret: 'output' },
    }, 1)
    expect(JSON.stringify(event)).not.toMatch(/input|output/)
  })
})
