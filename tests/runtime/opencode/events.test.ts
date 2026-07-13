// plugins/timeline/tests/opencode.test.ts
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import { createAccumulator, createEventHandler, type EventHandlerDeps } from '../../../opencode'
import {
  assistantMessageUpdatedEvent,
  assistantMessageUpdatedEvent2,
  childSessionCreatedEvent,
  childSessionIdleEvent,
  messagePartUpdatedEvent,
  nestedAssistantMessageUpdatedEvent,
  ignoredMessagePartEvent,
  sessionCreatedEvent,
  sessionDeletedEvent,
  sessionErrorEvent,
  sessionIdleEvent,
  sessionTitleUpdatedEvent,
  syntheticMessagePartEvent,
  toolPartUpdatedEvent,
  userMessageUpdatedEvent,
  userMessageUpdatedEvent2,
} from '../../fixtures/events'

vi.mock('bun:sqlite', () => ({
  Database: vi.fn(),
}))

describe('createAccumulator', () => {
  it('creates the replacement accumulator state with empty ID maps', () => {
    const acc = createAccumulator('test-session-001', 'test-project')

    expect(acc).toMatchObject({
      sessionId: 'test-session-001',
      project: 'test-project',
      title: null,
      sessionModel: null,
      dirty: false,
      persisted: false,
      hydrated: false,
    })
    expect(acc.messages.size).toBe(0)
    expect(acc.textParts.size).toBe(0)
    expect(acc.toolCalls.size).toBe(0)
    expect(acc.toolPartIndex.size).toBe(0)
  })

  it('uses unknown project when not provided', () => {
    const acc = createAccumulator('test-session')
    expect(acc.project).toBe('unknown')
  })
})

describe('createEventHandler', () => {
  const hydratedTree = {
    info: { id: 'test-session-001', title: 'Hydrated title', directory: '/workspace/test-project', time: { created: 1, updated: 2 } },
    messages: [
      { info: { id: 'hydrated-user-1', sessionID: 'test-session-001', role: 'user', time: { created: 10 } }, parts: [{ id: 'hydrated-text', sessionID: 'test-session-001', messageID: 'hydrated-user-1', type: 'text', text: 'Hydrated prompt' }] },
      { info: { id: 'hydrated-assistant', sessionID: 'test-session-001', role: 'assistant', time: { created: 20 }, modelID: 'model', tokens: { input: 200, output: 20, cache: { read: 0, write: 0 } } }, parts: [{ id: 'hydrated-tool', sessionID: 'test-session-001', messageID: 'hydrated-assistant', type: 'tool', callID: 'hydrated-call', tool: 'Read', state: { status: 'completed', input: {}, time: { start: 20, end: 21 } } }] },
    ],
    children: [{
      info: { id: 'child-session-001', parentID: 'test-session-001', title: 'child', time: { created: 3, updated: 4 } },
      messages: [{ info: { id: 'hydrated-user-2', sessionID: 'child-session-001', role: 'user', time: { created: 30 } }, parts: [] }],
      children: [],
    }],
  }
  const mockWriter = {
    writeSession: vi.fn().mockReturnValue({
      sessionId: 'test-session-001',
      project: 'test-project',
      sessionsInserted: 1,
      sessionsUpdated: 0,
    }),
  }

  const mockLog = vi.fn()

  const createHandler = (overrides: Partial<EventHandlerDeps> = {}) =>
    createEventHandler({
      project: 'test-project',
      writer: mockWriter as any,
      log: mockLog,
      loadSessionTree: vi.fn().mockResolvedValue(hydratedTree),
      ...overrides,
    })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('hydrates a resumed session once before its first checkpoint', async () => {
    const loadSessionTree = vi.fn().mockResolvedValue(hydratedTree)
    const { handler } = createHandler({ loadSessionTree })

    await handler({ event: sessionIdleEvent })
    await handler({ event: sessionIdleEvent })

    expect(loadSessionTree).toHaveBeenCalledTimes(1)
    expect(mockWriter.writeSession.mock.calls.at(-1)![0]).toMatchObject({
      summary: 'Hydrated title',
      turns: 2,
      tokensInput: 200,
      tools: expect.arrayContaining([{ toolName: 'Read', callCount: 1 }]),
    })
  })

  it('retries hydration without clearing event state after a read failure', async () => {
    const loadSessionTree = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(hydratedTree)
    const { handler } = createHandler({ loadSessionTree })

    await handler({ event: userMessageUpdatedEvent })
    await handler({ event: sessionIdleEvent })

    expect(loadSessionTree).toHaveBeenCalledTimes(2)
    expect(mockWriter.writeSession.mock.calls.at(-1)![0].turns).toBeGreaterThanOrEqual(2)
  })

  it('migrates failed child event state into the discovered root accumulator', async () => {
    const loadSessionTree = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue(hydratedTree)
    const { handler, sessions, toolExecuteBefore } = createHandler({ loadSessionTree })
    const liveChildMessage = {
      type: 'message.updated',
      properties: {
        sessionID: 'child-session-001',
        info: {
          id: 'live-child-user',
          sessionID: 'child-session-001',
          role: 'user',
          time: { created: 40 },
        },
      },
    }

    await handler({ event: liveChildMessage })
    await toolExecuteBefore({ sessionID: 'child-session-001', tool: 'Read', callID: 'live-child-call' }, { args: {} })
    await handler({ event: sessionIdleEvent })

    const written = mockWriter.writeSession.mock.calls.at(-1)![0]
    expect(sessions.has('child-session-001')).toBe(false)
    expect(sessions.get('test-session-001')?.messages.has('child-session-001:live-child-user')).toBe(true)
    expect(written).toMatchObject({ sessionId: 'test-session-001', turns: 3 })
    expect(written.tools).toEqual([{ toolName: 'Read', callCount: 2 }])
  })

  it('keeps a live message update over a stale hydrated snapshot', async () => {
    const staleTree = {
      info: { id: 'test-session-001', title: 'Stale title', time: { created: 1, updated: 2 } },
      messages: [{
        info: {
          id: 'same-assistant',
          sessionID: 'test-session-001',
          role: 'assistant',
          time: { created: 10 },
          tokens: { input: 100, output: 1, cache: { read: 0, write: 0 } },
        },
        parts: [],
      }],
      children: [],
    }
    const loadSessionTree = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue(staleTree)
    const { handler } = createHandler({ loadSessionTree })
    const liveMessage = {
      type: 'message.updated',
      properties: {
        sessionID: 'test-session-001',
        info: {
          id: 'same-assistant',
          sessionID: 'test-session-001',
          role: 'assistant',
          time: { created: 10 },
          tokens: { input: 999, output: 9, cache: { read: 0, write: 0 } },
        },
      },
    }

    await handler({ event: liveMessage })
    await handler({ event: sessionIdleEvent })

    expect(mockWriter.writeSession.mock.calls.at(-1)![0]).toMatchObject({
      tokensInput: 999,
      tokensOutput: 9,
    })
  })

  it('keeps live root metadata over a stale hydrated snapshot', async () => {
    const staleTree = {
      info: { id: 'test-session-001', title: 'Old title', model: { id: 'old-model' }, time: { created: 1, updated: 2 } },
      messages: [],
      children: [],
    }
    const loadSessionTree = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue(staleTree)
    const { handler } = createHandler({ loadSessionTree })

    await handler({ event: {
      type: 'session.updated',
      properties: {
        sessionID: 'test-session-001',
        info: {
          id: 'test-session-001',
          title: 'New title',
          model: { id: 'new-model' },
          time: { created: 999, updated: 1_000 },
        },
      },
    } })
    await handler({ event: sessionIdleEvent })

    expect(mockWriter.writeSession.mock.calls.at(-1)![0]).toMatchObject({
      summary: 'New title',
      model: 'new-model',
      startedAt: 999,
    })
  })

  it('keeps live tool arguments while hydrating its persisted linkage', async () => {
    const staleTree = {
      info: { id: 'test-session-001', title: 'Stale title', time: { created: 1, updated: 2 } },
      messages: [{
        info: { id: 'stale-assistant', sessionID: 'test-session-001', role: 'assistant', time: { created: 10 } },
        parts: [{
          id: 'persisted-tool-part',
          sessionID: 'test-session-001',
          messageID: 'stale-assistant',
          type: 'tool',
          callID: 'shared-call',
          tool: 'Read',
          state: { input: { filePath: '/stale' } },
        }],
      }],
      children: [],
    }
    const loadSessionTree = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue(staleTree)
    const { handler, sessions, toolExecuteBefore } = createHandler({ loadSessionTree })

    await toolExecuteBefore(
      { sessionID: 'test-session-001', tool: 'Read', callID: 'shared-call' },
      { args: { filePath: '/live' } },
    )
    await handler({ event: sessionIdleEvent })

    const acc = sessions.get('test-session-001')!
    expect(acc.toolCalls.get('test-session-001:shared-call')).toMatchObject({
      args: { filePath: '/live' },
      messageId: 'stale-assistant',
      partId: 'persisted-tool-part',
    })
    expect(acc.toolPartIndex.get('test-session-001:persisted-tool-part')).toBe('test-session-001:shared-call')

    await handler({ event: {
      type: 'message.part.removed',
      properties: { sessionID: 'test-session-001', messageID: 'stale-assistant', partID: 'persisted-tool-part' },
    } })
    await handler({ event: sessionIdleEvent })

    expect(mockWriter.writeSession.mock.calls.at(-1)![0].tools).toEqual([])
  })

  it('does not resurrect a message or its parts after a failed hydration removal', async () => {
    const staleTree = {
      info: { id: 'test-session-001', title: 'Stale title', time: { created: 1, updated: 2 } },
      messages: [{
        info: { id: 'stale-user', sessionID: 'test-session-001', role: 'user', time: { created: 10 } },
        parts: [
          { id: 'stale-text', sessionID: 'test-session-001', messageID: 'stale-user', type: 'text', text: 'Stale prompt' },
          { id: 'stale-tool', sessionID: 'test-session-001', messageID: 'stale-user', type: 'tool', callID: 'stale-call', tool: 'Read', state: { input: {} } },
        ],
      }],
      children: [],
    }
    const loadSessionTree = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue(staleTree)
    const { handler } = createHandler({ loadSessionTree })

    await handler({ event: {
      type: 'message.removed',
      properties: { sessionID: 'test-session-001', messageID: 'stale-user' },
    } })
    await handler({ event: sessionIdleEvent })

    expect(mockWriter.writeSession.mock.calls.at(-1)![0]).toMatchObject({ turns: 0, tools: [] })
  })

  it('does not resurrect a removed tool part after a failed hydration', async () => {
    const staleTree = {
      info: { id: 'test-session-001', title: 'Stale title', time: { created: 1, updated: 2 } },
      messages: [{
        info: { id: 'stale-assistant', sessionID: 'test-session-001', role: 'assistant', time: { created: 10 } },
        parts: [{ id: 'stale-tool', sessionID: 'test-session-001', messageID: 'stale-assistant', type: 'tool', callID: 'stale-call', tool: 'Read', state: { input: {} } }],
      }],
      children: [],
    }
    const loadSessionTree = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue(staleTree)
    const { handler } = createHandler({ loadSessionTree })

    await handler({ event: {
      type: 'message.part.removed',
      properties: { sessionID: 'test-session-001', messageID: 'stale-assistant', partID: 'stale-tool' },
    } })
    await handler({ event: sessionIdleEvent })

    expect(mockWriter.writeSession.mock.calls.at(-1)![0].tools).toEqual([])
  })

  it('does not hydrate a session created by the current process', async () => {
    const loadSessionTree = vi.fn().mockResolvedValue(hydratedTree)
    const { handler } = createHandler({ loadSessionTree })

    await handler({ event: sessionCreatedEvent })
    await handler({ event: sessionIdleEvent })

    expect(loadSessionTree).not.toHaveBeenCalled()
  })

  it('routes unawaited child and root events through one lane before hydration completes', async () => {
    let release!: (tree: typeof hydratedTree) => void
    const loadSessionTree = vi.fn()
      .mockImplementationOnce(() => new Promise<typeof hydratedTree>((resolve) => { release = resolve }))
      .mockResolvedValue(hydratedTree)
    const { handler, dispose } = createHandler({ loadSessionTree })
    const childMessage = {
      ...userMessageUpdatedEvent,
      properties: {
        sessionID: 'child-session-001',
        info: { ...userMessageUpdatedEvent.properties.info, id: 'early-child', sessionID: 'child-session-001' },
      },
    }

    void handler({ event: childMessage })
    void handler({ event: sessionIdleEvent })
    await vi.waitFor(() => expect(loadSessionTree).toHaveBeenCalledTimes(1))
    release(hydratedTree)
    await dispose()

    expect(loadSessionTree).toHaveBeenCalledTimes(1)
    expect(mockWriter.writeSession.mock.calls.at(-1)![0].sessionId).toBe('test-session-001')
    expect(mockWriter.writeSession.mock.calls.at(-1)![0].turns).toBeGreaterThanOrEqual(2)
  })

  it('replaces repeated message updates instead of double-counting', async () => {
    const { handler } = createHandler()
    const updatedAssistantMessage = {
      ...assistantMessageUpdatedEvent,
      properties: {
        ...assistantMessageUpdatedEvent.properties,
        info: {
          ...assistantMessageUpdatedEvent.properties.info,
          tokens: { input: 20_000, output: 15, reasoning: 0, cache: { read: 2048, write: 256 } },
        },
      },
    }

    await handler({ event: sessionCreatedEvent })
    await handler({ event: userMessageUpdatedEvent })
    await handler({ event: userMessageUpdatedEvent })
    await handler({ event: assistantMessageUpdatedEvent })
    await handler({ event: updatedAssistantMessage })
    await handler({ event: sessionIdleEvent })

    const written = mockWriter.writeSession.mock.calls.at(-1)![0]
    expect(written.turns).toBe(1)
    expect(written.tokensInput).toBe(20_000)
    expect(written.tokensOutput).toBe(15)
    expect(written.tokensCached).toBe(2304)
  })

  it('uses a generated OpenCode title', async () => {
    const { handler } = createHandler()
    await handler({ event: sessionCreatedEvent })
    await handler({ event: messagePartUpdatedEvent })
    await handler({ event: userMessageUpdatedEvent })
    await handler({ event: sessionTitleUpdatedEvent })
    await handler({ event: sessionIdleEvent })

    expect(mockWriter.writeSession.mock.calls.at(-1)![0]).toMatchObject({
      summary: 'Fix token accounting',
      summarySource: 'auto',
    })
  })

  it('falls back to the first message for an exact OpenCode default title', async () => {
    const { handler } = createHandler()
    await handler({ event: sessionCreatedEvent })
    await handler({ event: userMessageUpdatedEvent })
    await handler({ event: messagePartUpdatedEvent })
    await handler({ event: sessionIdleEvent })

    expect(mockWriter.writeSession.mock.calls.at(-1)![0]).toMatchObject({
      summary: 'Hello, this is a test message',
      summarySource: 'first_message',
    })
  })

  it('does not use synthetic text as a session summary', async () => {
    const { handler } = createHandler()
    await handler({ event: sessionCreatedEvent })
    await handler({ event: userMessageUpdatedEvent })
    await handler({ event: syntheticMessagePartEvent })
    await handler({ event: sessionIdleEvent })

    expect(mockWriter.writeSession.mock.calls.at(-1)![0]).toMatchObject({
      summary: '(untitled session)',
      summarySource: 'auto',
    })
  })

  it('does not use ignored text as a session summary', async () => {
    const { handler } = createHandler()
    await handler({ event: sessionCreatedEvent })
    await handler({ event: userMessageUpdatedEvent })
    await handler({ event: ignoredMessagePartEvent })
    await handler({ event: sessionIdleEvent })

    expect(mockWriter.writeSession.mock.calls.at(-1)![0]).toMatchObject({
      summary: '(untitled session)',
      summarySource: 'auto',
    })
  })

  it('writes collected tools and skills to the checkpoint', async () => {
    const { handler, toolExecuteBefore, toolExecuteAfter } = createHandler()
    await handler({ event: sessionCreatedEvent })
    await toolExecuteBefore({ sessionID: 'test-session-001', tool: 'Read' })
    await toolExecuteBefore({ sessionID: 'test-session-001', tool: 'Read' })
    await toolExecuteAfter({ sessionID: 'test-session-001', tool: 'Skill', args: { name: 'github' } })
    await toolExecuteAfter({ sessionID: 'test-session-001', tool: 'skill', args: { name: 'docker' } })
    await handler({ event: sessionIdleEvent })

    expect(mockWriter.writeSession.mock.calls.at(-1)![0]).toMatchObject({
      tools: [{ toolName: 'Read', callCount: 2 }],
      skills: ['github', 'docker'],
    })
  })

  it('counts a legacy tool call separately from a matching real call ID', async () => {
    const { handler, toolExecuteBefore } = createHandler()
    await handler({ event: sessionCreatedEvent })
    await toolExecuteBefore({ sessionID: 'test-session-001', tool: 'Read' })
    await toolExecuteBefore({ sessionID: 'test-session-001', tool: 'Read', callID: 'legacy-1' })
    await handler({ event: sessionIdleEvent })

    expect(mockWriter.writeSession.mock.calls.at(-1)![0].tools).toEqual([{ toolName: 'Read', callCount: 2 }])
  })

  it('counts the same call ID once across hook and persisted part events', async () => {
    const { handler, sessions, toolExecuteBefore, toolExecuteAfter } = createHandler()
    await handler({ event: sessionCreatedEvent })
    await toolExecuteBefore(
      { sessionID: 'test-session-001', tool: 'Read', callID: 'call-001' },
      { args: { filePath: '/tmp/a' } },
    )
    await handler({ event: toolPartUpdatedEvent })
    await toolExecuteAfter(
      { sessionID: 'test-session-001', tool: 'Read', callID: 'call-001', args: { filePath: '/tmp/a' } },
      { title: 'Read /tmp/a', output: '', metadata: {} },
    )
    const acc = sessions.get('test-session-001')!
    expect(acc.toolCalls).toEqual(new Map([['test-session-001:call-001', {
      sessionId: 'test-session-001',
      callId: 'call-001',
      toolName: 'Read',
      args: { filePath: '/tmp/a' },
      messageId: 'msg-assistant-001',
      partId: 'part-tool-001',
    }]]))
    expect(acc.toolPartIndex.get('test-session-001:part-tool-001')).toBe('test-session-001:call-001')
    await handler({ event: sessionIdleEvent })

    expect(mockWriter.writeSession.mock.calls.at(-1)![0].tools).toEqual([{ toolName: 'Read', callCount: 1 }])
  })

  it('keeps child routing after child idle and namespaces matching call IDs', async () => {
    const { childToParent, handler, toolExecuteBefore } = createHandler()
    await handler({ event: sessionCreatedEvent })
    await handler({ event: childSessionCreatedEvent })
    await toolExecuteBefore({ sessionID: 'test-session-001', tool: 'Read', callID: 'same' }, { args: {} })
    await toolExecuteBefore({ sessionID: 'child-session-001', tool: 'Read', callID: 'same' }, { args: {} })
    await handler({ event: childSessionIdleEvent })
    expect(childToParent.get('child-session-001')).toBe('test-session-001')
    await toolExecuteBefore({ sessionID: 'child-session-001', tool: 'Skill', callID: 'skill-001' }, { args: { name: 'github' } })
    await handler({ event: sessionIdleEvent })

    expect(mockWriter.writeSession.mock.calls.at(-1)![0]).toMatchObject({
      tools: expect.arrayContaining([{ toolName: 'Read', callCount: 2 }]),
      skills: ['github'],
    })
    expect(mockWriter.writeSession.mock.calls.every(([data]) => data.sessionId === 'test-session-001')).toBe(true)
  })

  it('removes child routing when its root is deleted', async () => {
    const { childToParent, handler } = createHandler()
    await handler({ event: sessionCreatedEvent })
    await handler({ event: childSessionCreatedEvent })
    await handler({ event: sessionDeletedEvent })

    expect(childToParent.has('child-session-001')).toBe(false)
  })

  it('keeps root deletion state until dispose retries a failed checkpoint', async () => {
    mockWriter.writeSession.mockImplementationOnce(() => { throw new Error('locked') })
    const { childToParent, dispose, handler } = createHandler()
    await handler({ event: sessionCreatedEvent })
    await handler({ event: childSessionCreatedEvent })
    await handler({ event: sessionDeletedEvent })

    expect(childToParent.get('child-session-001')).toBe('test-session-001')
    await dispose()

    expect(mockWriter.writeSession).toHaveBeenCalledTimes(2)
    expect(mockWriter.writeSession.mock.calls.at(-1)![0].sessionId).toBe('test-session-001')
    expect(mockLog.mock.calls.some(([, message]) => message === 'Skipped non-root OpenCode checkpoint')).toBe(false)
  })

  it('never checkpoints a child or unresolved session ID', async () => {
    const loadSessionTree = vi.fn().mockRejectedValue(new Error('temporarily unavailable'))
    const { handler } = createHandler({ loadSessionTree })
    await handler({ event: childSessionCreatedEvent })
    await handler({ event: childSessionIdleEvent })

    expect(loadSessionTree).toHaveBeenCalledWith('child-session-001')
    expect(mockWriter.writeSession).not.toHaveBeenCalled()
  })

  it('skips unresolved event and tool state during dispose after hydration fails', async () => {
    const loadSessionTree = vi.fn().mockRejectedValue(new Error('temporarily unavailable'))
    const { dispose, handler, toolExecuteBefore } = createHandler({ loadSessionTree })
    const unresolvedSessionID = 'unresolved-session-001'
    await handler({
      event: {
        type: 'message.updated',
        properties: {
          sessionID: unresolvedSessionID,
          info: { ...userMessageUpdatedEvent.properties.info, sessionID: unresolvedSessionID },
        },
      },
    })
    await toolExecuteBefore({ sessionID: unresolvedSessionID, tool: 'Read', callID: 'call-001' }, { args: {} })
    await dispose()

    expect(loadSessionTree).toHaveBeenCalledWith(unresolvedSessionID)
    expect(mockWriter.writeSession).not.toHaveBeenCalled()
    expect(mockLog).toHaveBeenCalledWith('warn', 'Skipped non-root OpenCode checkpoint', { sessionID: unresolvedSessionID })
  })

  it('removes a deleted tool part from the next checkpoint', async () => {
    const { handler, sessions } = createHandler()
    await handler({ event: sessionCreatedEvent })
    await handler({ event: toolPartUpdatedEvent })
    expect(sessions.get('test-session-001')!.toolCalls.size).toBe(1)
    expect(sessions.get('test-session-001')!.toolPartIndex.get('test-session-001:part-tool-001')).toBe('test-session-001:call-001')
    await handler({ event: {
      type: 'message.part.removed',
      properties: { sessionID: 'test-session-001', messageID: 'msg-assistant-001', partID: 'part-tool-001' },
    } })
    expect(sessions.get('test-session-001')!.toolPartIndex.has('test-session-001:part-tool-001')).toBe(false)
    await handler({ event: sessionIdleEvent })

    expect(mockWriter.writeSession.mock.calls.at(-1)![0].tools).toEqual([])
  })

  it('accepts session IDs from both outer and legacy nested event shapes', async () => {
    const { handler } = createHandler()
    await handler({ event: sessionCreatedEvent })
    await handler({ event: userMessageUpdatedEvent })
    await handler({ event: nestedAssistantMessageUpdatedEvent })
    await handler({ event: sessionIdleEvent })

    expect(mockWriter.writeSession.mock.calls.at(-1)![0]).toMatchObject({
      sessionId: 'test-session-001',
      turns: 1,
      tokensInput: 17_473,
    })
  })

  it('keeps cumulative state across two idle checkpoints', async () => {
    const { handler } = createHandler()
    await handler({ event: sessionCreatedEvent })
    await handler({ event: userMessageUpdatedEvent })
    await handler({ event: assistantMessageUpdatedEvent })
    await handler({ event: sessionIdleEvent })

    await handler({ event: userMessageUpdatedEvent2 })
    await handler({ event: assistantMessageUpdatedEvent2 })
    await handler({ event: sessionIdleEvent })

    expect(mockWriter.writeSession.mock.calls.at(-1)![0]).toMatchObject({
      turns: 2,
      tokensInput: 20_000,
      tokensOutput: 31,
    })
  })

  it('serializes fire-and-forget events before idle', async () => {
    const { handler, dispose } = createHandler()
    void handler({ event: sessionCreatedEvent })
    void handler({ event: userMessageUpdatedEvent })
    void handler({ event: assistantMessageUpdatedEvent })
    void handler({ event: sessionIdleEvent })

    await dispose()

    expect(mockWriter.writeSession.mock.calls.at(-1)![0]).toMatchObject({
      turns: 1,
      tokensInput: 17_473,
    })
  })

  it('routes fire-and-forget child events through the pending parent queue', async () => {
    const { handler, sessions, toolExecuteBefore } = createHandler()
    const childSessionID = 'child-session-001'
    const pendingParent = handler({ event: sessionCreatedEvent })
    const pendingChild = handler({
      event: {
        type: 'session.created',
        properties: {
          sessionID: childSessionID,
          info: { id: childSessionID, parentID: 'test-session-001' },
        },
      },
    })
    const pendingMessage = handler({
      event: {
        type: 'message.updated',
        properties: {
          sessionID: childSessionID,
          info: {
            ...userMessageUpdatedEvent.properties.info,
            id: 'msg-child-user-001',
            sessionID: childSessionID,
          },
        },
      },
    })
    const pendingTool = toolExecuteBefore({ sessionID: childSessionID, tool: 'Read' })

    await Promise.all([pendingParent, pendingChild, pendingMessage, pendingTool])

    const parent = sessions.get('test-session-001')
    expect(sessions.has(childSessionID)).toBe(false)
    expect(parent?.messages.has(`${childSessionID}:msg-child-user-001`)).toBe(true)
    expect(parent?.toolCalls.size).toBe(1)

    await handler({ event: sessionIdleEvent })

    expect(mockWriter.writeSession).toHaveBeenCalledTimes(1)
    expect(mockWriter.writeSession.mock.calls[0][0].sessionId).toBe('test-session-001')
  })

  it('removes deleted messages from the next checkpoint', async () => {
    const { handler } = createHandler()
    await handler({ event: sessionCreatedEvent })
    await handler({ event: userMessageUpdatedEvent })
    await handler({
      event: {
        type: 'message.removed',
        properties: { sessionID: 'test-session-001', messageID: 'msg-user-001' },
      },
    })
    await handler({ event: sessionIdleEvent })

    expect(mockWriter.writeSession.mock.calls.at(-1)![0].turns).toBe(0)
  })

  it('removes related text, tool calls, and tool-part indexes with a message', async () => {
    const { handler, sessions } = createHandler()
    await handler({ event: sessionCreatedEvent })
    await handler({ event: userMessageUpdatedEvent })
    await handler({ event: messagePartUpdatedEvent })

    const acc = sessions.get('test-session-001')!
    const toolCallKey = 'test-session-001:call-tool-001'
    const toolPartKey = 'test-session-001:part-tool-001'
    acc.toolCalls.set(toolCallKey, {
      sessionId: 'test-session-001',
      callId: 'call-tool-001',
      toolName: 'Read',
      args: {},
      messageId: 'msg-user-001',
      partId: 'part-tool-001',
    })
    acc.toolPartIndex.set(toolPartKey, toolCallKey)

    await handler({
      event: {
        type: 'message.removed',
        properties: { sessionID: 'test-session-001', messageID: 'msg-user-001' },
      },
    })

    expect(acc.messages.has('test-session-001:msg-user-001')).toBe(false)
    expect(acc.textParts.has('test-session-001:part-text-001')).toBe(false)
    expect(acc.toolCalls.has(toolCallKey)).toBe(false)
    expect(acc.toolPartIndex.has(toolPartKey)).toBe(false)
  })

  it('rewrites a persisted checkpoint when a generated title arrives late', async () => {
    const { handler } = createHandler()
    await handler({ event: sessionCreatedEvent })
    await handler({ event: userMessageUpdatedEvent })
    await handler({ event: messagePartUpdatedEvent })
    await handler({ event: sessionIdleEvent })
    await handler({ event: sessionTitleUpdatedEvent })

    expect(mockWriter.writeSession).toHaveBeenCalledTimes(2)
    expect(mockWriter.writeSession.mock.calls.at(-1)![0].summary).toBe('Fix token accounting')
  })

  it('retains dirty state and retries after a writer failure', async () => {
    mockWriter.writeSession.mockImplementationOnce(() => { throw new Error('locked') })
    const { handler } = createHandler()
    await handler({ event: sessionCreatedEvent })
    await handler({ event: userMessageUpdatedEvent })
    await handler({ event: sessionIdleEvent })
    await handler({ event: sessionIdleEvent })

    expect(mockWriter.writeSession).toHaveBeenCalledTimes(2)
    expect(mockWriter.writeSession.mock.calls.at(-1)![0].turns).toBe(1)
  })

  it('writes an untitled empty session and retains it in memory on idle', async () => {
    const { handler, sessions } = createHandler()
    await handler({ event: sessionCreatedEvent })
    await handler({ event: sessionIdleEvent })

    expect(mockWriter.writeSession).toHaveBeenCalledTimes(1)
    expect(mockWriter.writeSession.mock.calls.at(-1)![0]).toMatchObject({
      summary: '(untitled session)',
      summarySource: 'auto',
    })
    expect(sessions.has('test-session-001')).toBe(true)
  })

  it('writes and removes a session when deleted', async () => {
    const { handler, sessions } = createHandler()
    await handler({ event: sessionCreatedEvent })
    await handler({ event: userMessageUpdatedEvent })
    await handler({ event: sessionDeletedEvent })

    expect(mockWriter.writeSession).toHaveBeenCalledTimes(1)
    expect(sessions.has('test-session-001')).toBe(false)
  })

  it('writes a session when an error occurs', async () => {
    const { handler } = createHandler()
    await handler({ event: sessionCreatedEvent })
    await handler({ event: userMessageUpdatedEvent })
    await handler({ event: sessionErrorEvent })

    expect(mockWriter.writeSession).toHaveBeenCalledTimes(1)
  })
})
