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
  messagePartUpdatedEvent,
  nestedAssistantMessageUpdatedEvent,
  sessionCreatedEvent,
  sessionDeletedEvent,
  sessionErrorEvent,
  sessionIdleEvent,
  sessionTitleUpdatedEvent,
  userMessageUpdatedEvent,
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

    await handler({ event: sessionCreatedEvent })
    await handler({ event: userMessageUpdatedEvent })
    await handler({ event: userMessageUpdatedEvent })
    await handler({ event: assistantMessageUpdatedEvent })
    await handler({ event: assistantMessageUpdatedEvent })
    await handler({ event: sessionIdleEvent })

    const written = mockWriter.writeSession.mock.calls.at(-1)![0]
    expect(written.turns).toBe(1)
    expect(written.tokensInput).toBe(17_473)
    expect(written.tokensOutput).toBe(11)
    expect(written.tokensCached).toBe(1536)
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

  it('writes an untitled empty session and removes it from memory on idle', async () => {
    const { handler, sessions } = createHandler()
    await handler({ event: sessionCreatedEvent })
    await handler({ event: sessionIdleEvent })

    expect(mockWriter.writeSession).toHaveBeenCalledTimes(1)
    expect(mockWriter.writeSession.mock.calls.at(-1)![0]).toMatchObject({
      summary: '(untitled session)',
      summarySource: 'auto',
    })
    expect(sessions.has('test-session-001')).toBe(false)
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
