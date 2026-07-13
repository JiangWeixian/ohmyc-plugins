// plugins/timeline/tests/opencode.test.ts
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import { createAccumulator, createEventHandler } from '../../../opencode'
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
  const mockWriter = {
    writeSession: vi.fn().mockReturnValue({
      sessionId: 'test-session-001',
      project: 'test-project',
      sessionsInserted: 1,
      sessionsUpdated: 0,
    }),
  }

  const mockLog = vi.fn()

  const createHandler = (overrides: Record<string, unknown> = {}) =>
    createEventHandler({
      project: 'test-project',
      writer: mockWriter as any,
      log: mockLog,
      ...overrides,
    })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
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

  it('never checkpoints a child or unresolved session ID', async () => {
    const loadSessionTree = vi.fn().mockRejectedValue(new Error('temporarily unavailable'))
    const { handler } = createHandler({ loadSessionTree })
    await handler({ event: childSessionCreatedEvent })
    await handler({ event: childSessionIdleEvent })

    expect(loadSessionTree).toHaveBeenCalledWith('child-session-001')
    expect(mockWriter.writeSession).not.toHaveBeenCalled()
  })

  it('removes a deleted tool part from the next checkpoint', async () => {
    const { handler, sessions } = createHandler()
    await handler({ event: sessionCreatedEvent })
    await handler({ event: toolPartUpdatedEvent })
    expect(sessions.get('test-session-001')!.toolCalls.size).toBe(1)
    await handler({ event: {
      type: 'message.part.removed',
      properties: { sessionID: 'test-session-001', messageID: 'msg-assistant-001', partID: 'part-tool-001' },
    } })
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
