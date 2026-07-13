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
  messagePartUpdatedEvent,
  nestedAssistantMessageUpdatedEvent,
  ignoredMessagePartEvent,
  sessionCreatedEvent,
  sessionDeletedEvent,
  sessionErrorEvent,
  sessionIdleEvent,
  sessionTitleUpdatedEvent,
  syntheticMessagePartEvent,
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

  const createHandler = () =>
    createEventHandler({
      project: 'test-project',
      writer: mockWriter as any,
      log: mockLog,
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
