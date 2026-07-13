// plugins/timeline/tests/fixtures/events.ts
// Fixtures for current and legacy OpenCode event shapes.

export const sessionCreatedEvent = {
  type: 'session.created',
  properties: {
    sessionID: 'test-session-001',
    info: {
      id: 'test-session-001',
      title: 'New session - 2026-07-12T03:16:01.973Z',
      directory: '/workspace/test-project',
      time: { created: 1_720_000_000_000, updated: 1_720_000_000_000 },
    },
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
    sessionID: 'test-session-001',
    info: {
      id: 'msg-user-001',
      sessionID: 'test-session-001',
      role: 'user',
      time: { created: 1_720_000_000_100 },
      model: { providerID: 'test', modelID: 'glm-5.1' },
    },
  },
}

export const messagePartUpdatedEvent = {
  type: 'message.part.updated',
  properties: {
    sessionID: 'test-session-001',
    part: {
      id: 'part-text-001',
      sessionID: 'test-session-001',
      messageID: 'msg-user-001',
      type: 'text',
      text: 'Hello, this is a test message',
      synthetic: false,
      ignored: false,
    },
  },
}

export const assistantMessageUpdatedEvent = {
  type: 'message.updated',
  properties: {
    sessionID: 'test-session-001',
    info: {
      id: 'msg-assistant-001',
      sessionID: 'test-session-001',
      role: 'assistant',
      time: { created: 1_720_000_000_200, completed: 1_720_000_000_300 },
      tokens: { input: 17_473, output: 11, reasoning: 0, cache: { read: 1024, write: 512 } },
      modelID: 'glm-5.1',
    },
  },
}

export const userMessageUpdatedEvent2 = {
  ...userMessageUpdatedEvent,
  properties: {
    ...userMessageUpdatedEvent.properties,
    info: {
      ...userMessageUpdatedEvent.properties.info,
      id: 'msg-user-002',
      time: { created: 1_720_000_001_100 },
    },
  },
}

export const assistantMessageUpdatedEvent2 = {
  ...assistantMessageUpdatedEvent,
  properties: {
    ...assistantMessageUpdatedEvent.properties,
    info: {
      ...assistantMessageUpdatedEvent.properties.info,
      id: 'msg-assistant-002',
      time: { created: 1_720_000_001_200, completed: 1_720_000_001_300 },
      tokens: { input: 2527, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  },
}

export const sessionTitleUpdatedEvent = {
  type: 'session.updated',
  properties: {
    sessionID: 'test-session-001',
    info: { ...sessionCreatedEvent.properties.info, title: 'Fix token accounting' },
  },
}

export const nestedAssistantMessageUpdatedEvent = {
  type: 'message.updated',
  properties: { info: { ...assistantMessageUpdatedEvent.properties.info } },
}

export const syntheticMessagePartEvent = {
  type: 'message.part.updated',
  properties: {
    sessionID: 'test-session-001',
    part: {
      ...messagePartUpdatedEvent.properties.part,
      id: 'part-text-synthetic-001',
      text: 'System prompt',
      synthetic: true,
    },
  },
}

export const ignoredMessagePartEvent = {
  type: 'message.part.updated',
  properties: {
    sessionID: 'test-session-001',
    part: {
      ...messagePartUpdatedEvent.properties.part,
      id: 'part-text-ignored-001',
      text: 'Ignored content',
      ignored: true,
    },
  },
}
