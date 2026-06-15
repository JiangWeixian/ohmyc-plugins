// plugins/timeline/tests/fixtures/events.ts
// Fixtures for opencode events based on actual event shapes from logs

export const sessionCreatedEvent = {
  type: 'session.created',
  properties: {
    sessionID: 'test-session-001',
    info: { id: 'test-session-001' },
  },
}

export const sessionIdleEvent = {
  type: 'session.idle',
  properties: {
    sessionID: 'test-session-001',
  },
}

export const sessionDeletedEvent = {
  type: 'session.deleted',
  properties: {
    sessionID: 'test-session-001',
  },
}

export const sessionErrorEvent = {
  type: 'session.error',
  properties: {
    sessionID: 'test-session-001',
  },
}

export const userMessageUpdatedEvent = {
  type: 'message.updated',
  properties: {
    info: {
      sessionID: 'test-session-001',
      role: 'user',
      tokens: null,
      modelID: null,
    },
  },
}

export const assistantMessageUpdatedEvent = {
  type: 'message.updated',
  properties: {
    info: {
      sessionID: 'test-session-001',
      role: 'assistant',
      tokens: {
        input: 17_473,
        output: 11,
        cache: {
          read: 1024,
          write: 512,
        },
      },
      modelID: 'glm-5.1',
    },
  },
}

export const messagePartUpdatedEvent = {
  type: 'message.part.updated',
  properties: {
    part: {
      sessionID: 'test-session-001',
      type: 'text',
      text: 'Hello, this is a test message',
      synthetic: false,
      ignored: false,
    },
  },
}

export const syntheticMessagePartEvent = {
  type: 'message.part.updated',
  properties: {
    part: {
      sessionID: 'test-session-001',
      type: 'text',
      text: 'System prompt',
      synthetic: true,
      ignored: false,
    },
  },
}

export const ignoredMessagePartEvent = {
  type: 'message.part.updated',
  properties: {
    part: {
      sessionID: 'test-session-001',
      type: 'text',
      text: 'Ignored content',
      synthetic: false,
      ignored: true,
    },
  },
}

export const toolExecuteBeforeEvent = {
  type: 'tool.execute.before',
  properties: {
    sessionID: 'test-session-001',
    tool: 'Read',
  },
}

export const skillExecuteBeforeEvent = {
  type: 'tool.execute.before',
  properties: {
    sessionID: 'test-session-001',
    tool: 'Skill',
  },
}

export const skillExecuteAfterEvent = {
  type: 'tool.execute.after',
  properties: {
    sessionID: 'test-session-001',
    tool: 'Skill',
    args: {
      name: 'github',
    },
  },
}

export const lowercaseSkillExecuteAfterEvent = {
  type: 'tool.execute.after',
  properties: {
    sessionID: 'test-session-001',
    tool: 'skill',
    args: {
      name: 'docker',
    },
  },
}

export const nonSkillToolExecuteAfterEvent = {
  type: 'tool.execute.after',
  properties: {
    sessionID: 'test-session-001',
    tool: 'Read',
    args: {},
  },
}
