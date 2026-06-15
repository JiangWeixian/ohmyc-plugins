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
  ignoredMessagePartEvent,
  messagePartUpdatedEvent,
  sessionCreatedEvent,
  sessionDeletedEvent,
  sessionErrorEvent,
  sessionIdleEvent,
  syntheticMessagePartEvent,
  userMessageUpdatedEvent,
} from '../../fixtures/events'

vi.mock('bun:sqlite', () => ({
  Database: vi.fn(),
}))

describe('createAccumulator', () => {
  it('creates accumulator with default values', () => {
    const acc = createAccumulator('test-session', 'test-project')

    expect(acc.sessionId).toBe('test-session')
    expect(acc.project).toBe('test-project')
    expect(acc.turns).toBe(0)
    expect(acc.tokensInput).toBe(0)
    expect(acc.tokensOutput).toBe(0)
    expect(acc.tokensCached).toBe(0)
    expect(acc.tools.size).toBe(0)
    expect(acc.skills.size).toBe(0)
    expect(acc.firstUserMessage).toBeNull()
    expect(acc.summary).toBeNull()
    expect(acc.model).toBeNull()
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

  describe('session.created', () => {
    it('sets startedAt for new session', async () => {
      const { handler, sessions } = createHandler()
      const before = Date.now()

      await handler({ event: sessionCreatedEvent })

      const acc = sessions.get('test-session-001')
      expect(acc).toBeDefined()
      expect(acc!.startedAt).toBeGreaterThanOrEqual(before)
    })
  })

  describe('message.updated', () => {
    it('counts user turns', async () => {
      const { handler, sessions } = createHandler()

      await handler({ event: userMessageUpdatedEvent })

      const acc = sessions.get('test-session-001')
      expect(acc!.turns).toBe(1)
    })

    it('counts multiple user turns', async () => {
      const { handler, sessions } = createHandler()

      await handler({ event: userMessageUpdatedEvent })
      await handler({ event: userMessageUpdatedEvent })
      await handler({ event: userMessageUpdatedEvent })

      const acc = sessions.get('test-session-001')
      expect(acc!.turns).toBe(3)
    })

    it('tracks assistant tokens', async () => {
      const { handler, sessions } = createHandler()

      await handler({ event: assistantMessageUpdatedEvent })

      const acc = sessions.get('test-session-001')
      expect(acc!.tokensInput).toBe(17_473)
      expect(acc!.tokensOutput).toBe(11)
      expect(acc!.tokensCached).toBe(1536) // 1024 + 512
    })

    it('tracks assistant model', async () => {
      const { handler, sessions } = createHandler()

      await handler({ event: assistantMessageUpdatedEvent })

      const acc = sessions.get('test-session-001')
      expect(acc!.model).toBe('glm-5.1')
    })

    it('accumulates tokens across multiple assistant messages', async () => {
      const { handler, sessions } = createHandler()

      await handler({ event: assistantMessageUpdatedEvent })
      await handler({ event: assistantMessageUpdatedEvent })

      const acc = sessions.get('test-session-001')
      expect(acc!.tokensInput).toBe(34_946) // 17473 * 2
      expect(acc!.tokensOutput).toBe(22) // 11 * 2
    })
  })

  describe('message.part.updated', () => {
    it('captures first user message', async () => {
      const { handler, sessions } = createHandler()

      await handler({ event: messagePartUpdatedEvent })

      const acc = sessions.get('test-session-001')
      expect(acc!.firstUserMessage).toBe('Hello, this is a test message')
    })

    it('ignores synthetic parts', async () => {
      const { handler, sessions } = createHandler()

      // Create session first
      await handler({ event: sessionCreatedEvent })
      await handler({ event: syntheticMessagePartEvent })

      const acc = sessions.get('test-session-001')
      expect(acc!.firstUserMessage).toBeNull()
    })

    it('ignores ignored parts', async () => {
      const { handler, sessions } = createHandler()

      // Create session first
      await handler({ event: sessionCreatedEvent })
      await handler({ event: ignoredMessagePartEvent })

      const acc = sessions.get('test-session-001')
      expect(acc!.firstUserMessage).toBeNull()
    })

    it('keeps first message when second arrives', async () => {
      const { handler, sessions } = createHandler()

      await handler({ event: messagePartUpdatedEvent })
      await handler({
        event: {
          ...messagePartUpdatedEvent,
          properties: {
            part: {
              ...messagePartUpdatedEvent.properties.part,
              text: 'Second message',
            },
          },
        },
      })

      const acc = sessions.get('test-session-001')
      expect(acc!.firstUserMessage).toBe('Hello, this is a test message')
    })
  })

  describe('tool.execute.before', () => {
    it('counts tool executions', async () => {
      const { toolExecuteBefore, sessions } = createHandler()

      await toolExecuteBefore({ sessionID: 'test-session-001', tool: 'Read' })
      await toolExecuteBefore({ sessionID: 'test-session-001', tool: 'Read' })

      const acc = sessions.get('test-session-001')
      expect(acc!.tools.get('Read')).toBe(2)
    })

    it('tracks multiple different tools', async () => {
      const { toolExecuteBefore, sessions } = createHandler()

      await toolExecuteBefore({ sessionID: 'test-session-001', tool: 'Read' })
      await toolExecuteBefore({ sessionID: 'test-session-001', tool: 'Skill' })

      const acc = sessions.get('test-session-001')
      expect(acc!.tools.get('Read')).toBe(1)
      expect(acc!.tools.get('Skill')).toBe(1)
    })
  })

  describe('tool.execute.after', () => {
    it('tracks skill usage for Skill tool', async () => {
      const { toolExecuteAfter, sessions } = createHandler()

      await toolExecuteAfter({ sessionID: 'test-session-001', tool: 'Skill', args: { name: 'github' } })

      const acc = sessions.get('test-session-001')
      expect(acc!.skills.has('github')).toBe(true)
    })

    it('tracks skill usage for lowercase skill tool', async () => {
      const { toolExecuteAfter, sessions } = createHandler()

      await toolExecuteAfter({ sessionID: 'test-session-001', tool: 'skill', args: { name: 'docker' } })

      const acc = sessions.get('test-session-001')
      expect(acc!.skills.has('docker')).toBe(true)
    })

    it('ignores non-skill tools', async () => {
      const { handler, toolExecuteAfter, sessions } = createHandler()

      await handler({ event: sessionCreatedEvent })
      await toolExecuteAfter({ sessionID: 'test-session-001', tool: 'Read', args: {} })

      const acc = sessions.get('test-session-001')
      expect(acc!.skills.size).toBe(0)
    })

    it('tracks multiple skills', async () => {
      const { toolExecuteAfter, sessions } = createHandler()

      await toolExecuteAfter({ sessionID: 'test-session-001', tool: 'Skill', args: { name: 'github' } })
      await toolExecuteAfter({ sessionID: 'test-session-001', tool: 'skill', args: { name: 'docker' } })

      const acc = sessions.get('test-session-001')
      expect(acc!.skills.has('github')).toBe(true)
      expect(acc!.skills.has('docker')).toBe(true)
    })
  })

  describe('session.idle', () => {
    it('writes session to database', async () => {
      const { handler } = createHandler()

      await handler({ event: sessionCreatedEvent })
      await handler({ event: userMessageUpdatedEvent })
      await handler({ event: assistantMessageUpdatedEvent })
      await handler({ event: sessionIdleEvent })

      expect(mockWriter.writeSession).toHaveBeenCalledTimes(1)
      const written = mockWriter.writeSession.mock.calls[0][0]
      expect(written.sessionId).toBe('test-session-001')
      expect(written.turns).toBe(1)
      expect(written.tokensInput).toBe(17_473)
      expect(written.tokensOutput).toBe(11)
      expect(written.agentName).toBe('opencode')
    })

    it('writes session and removes from memory', async () => {
      const { handler } = createHandler()

      await handler({ event: sessionCreatedEvent })
      await handler({ event: userMessageUpdatedEvent })
      await handler({ event: sessionIdleEvent })

      expect(mockWriter.writeSession).toHaveBeenCalledTimes(1)
    })

    it('removes session from map after idle', async () => {
      const { handler, sessions } = createHandler()

      await handler({ event: sessionCreatedEvent })
      await handler({ event: sessionIdleEvent })

      expect(sessions.has('test-session-001')).toBe(false)
    })
  })

  describe('session.deleted', () => {
    it('writes session and removes from memory', async () => {
      const { handler, sessions } = createHandler()

      await handler({ event: sessionCreatedEvent })
      await handler({ event: userMessageUpdatedEvent })
      await handler({ event: sessionDeletedEvent })

      expect(mockWriter.writeSession).toHaveBeenCalledTimes(1)
      expect(sessions.has('test-session-001')).toBe(false)
    })
  })

  describe('session.error', () => {
    it('writes session on error', async () => {
      const { handler } = createHandler()

      await handler({ event: sessionCreatedEvent })
      await handler({ event: userMessageUpdatedEvent })
      await handler({ event: sessionErrorEvent })

      expect(mockWriter.writeSession).toHaveBeenCalledTimes(1)
    })
  })

  describe('end-to-end session', () => {
    it('handles complete conversation flow', async () => {
      const { handler, toolExecuteBefore, toolExecuteAfter } = createHandler()

      // Session created
      await handler({ event: sessionCreatedEvent })

      // User sends first message
      await handler({ event: messagePartUpdatedEvent })
      await handler({ event: userMessageUpdatedEvent })

      // Tool is called
      await toolExecuteBefore({ sessionID: 'test-session-001', tool: 'Read' })
      await toolExecuteAfter({ sessionID: 'test-session-001', tool: 'Skill', args: { name: 'github' } })

      // Assistant responds
      await handler({ event: assistantMessageUpdatedEvent })

      // Session ends
      await handler({ event: sessionIdleEvent })

      // Verify final state
      expect(mockWriter.writeSession).toHaveBeenCalledTimes(1)
      const written = mockWriter.writeSession.mock.calls[0][0]
      expect(written.sessionId).toBe('test-session-001')
      expect(written.project).toBe('test-project')
      expect(written.turns).toBe(1)
      expect(written.tokensInput).toBe(17_473)
      expect(written.tokensOutput).toBe(11)
      expect(written.tokensCached).toBe(1536)
      expect(written.summary).toBe('Hello, this is a test message')
      expect(written.summarySource).toBe('first_message')
      expect(written.model).toBe('glm-5.1')
      expect(written.tools).toEqual([{ toolName: 'Read', callCount: 1 }])
      expect(written.skills).toEqual(['github'])
      expect(written.transcriptPath).toBe('opencode://test-session-001')
    })

    it('handles session with no messages', async () => {
      const { handler } = createHandler()

      await handler({ event: sessionCreatedEvent })
      await handler({ event: sessionIdleEvent })

      expect(mockWriter.writeSession).toHaveBeenCalledTimes(1)
      const written = mockWriter.writeSession.mock.calls[0][0]
      expect(written.turns).toBe(0)
      expect(written.summary).toBe('(untitled session)')
      expect(written.summarySource).toBe('auto')
    })
  })
})
