# OpenCode Session Checkpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all newly observed or resumed OpenCode sessions produce idempotent Timeline checkpoints with correct titles, turns, tokens, tools, and child-session usage.

**Architecture:** Replace counter-only event accumulation with maps keyed by OpenCode message, part, and call IDs. Serialize fire-and-forget event hooks per root session, hydrate a resumed session tree once through the injected local SDK client, and derive a complete `ParsedSessionData` snapshot at every checkpoint.

**Tech Stack:** TypeScript ESM, Bun runtime, `@opencode-ai/plugin` 1.x SDK client, `bun:sqlite`, Vitest 3, Changesets.

## Global Constraints

- Do not backfill, delete, or otherwise mutate existing Timeline rows outside normal future checkpoints.
- Do not change the Timeline database schema.
- Do not add background polling or timers.
- Only confirmed root session IDs may be written to Timeline; child or unresolved session IDs must never become checkpoint rows.
- Keep OpenCode runtime logic in `opencode.ts`; do not change Claude Code or Codex ingestion.
- Preserve TypeScript ESM style: two-space indentation, single quotes, and no semicolons.
- Use `bun run test`, never `bun test`.
- Follow red-green-refactor for every behavioral task and commit after each green task.
- Preserve the generated `dist/index.js` runtime artifact in the published package.

---

## File Structure

- Modify `opencode.ts`: own the snapshot types, derivation helpers, serialized event handler, SDK hydration adapter, and plugin lifecycle integration.
- Modify `tests/fixtures/events.ts`: provide source-accurate event IDs, message IDs, part IDs, outer `sessionID` fields, titles, and removal fixtures.
- Modify `tests/runtime/opencode/events.test.ts`: cover idempotent messages, queue ordering, lifecycle checkpoints, titles, removals, tools, and child routing.
- Create `tests/runtime/opencode/hydration.test.ts`: cover SDK `.data` unwrapping, full-history hydration, ancestor/root resolution, descendants, and failures.
- Create `.changeset/quiet-sessions-checkpoint.md`: publish the behavior correction as a patch release.
- Regenerate `dist/index.js`: ship the tested OpenCode runtime implementation.

### Task 1: ID-Keyed Message State And Snapshot Derivation

**Files:**
- Modify: `tests/fixtures/events.ts:4-101`
- Modify: `tests/runtime/opencode/events.test.ts:28-195`
- Modify: `opencode.ts:60-143`

**Interfaces:**
- Consumes: existing `ParsedSessionData`, `createAccumulator(sessionId, project)`, and `createEventHandler(deps)`.
- Produces: `SessionAccumulator.messages`, `SessionAccumulator.textParts`, `isDefaultSessionTitle(title)`, and `toParsedSessionData(acc)` for later tasks.

- [ ] **Step 1: Make fixtures match current and legacy OpenCode event shapes**

Add stable IDs and metadata while retaining dedicated nested-shape fixtures.
OpenCode 1.17.18 source events include outer `sessionID`; released 1.17.7 and
older generated plugin types place the ID only in `info` or `part`, so both are
supported deliberately:

```ts
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
  properties: { ...userMessageUpdatedEvent.properties, info: { ...userMessageUpdatedEvent.properties.info, id: 'msg-user-002', time: { created: 1_720_000_001_100 } } },
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
```

- [ ] **Step 2: Write failing idempotence and title tests**

Replace tests that inspect mutable counters with observable checkpoint behavior:

```ts
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
  await handler({
    event: {
      type: 'session.updated',
      properties: {
        sessionID: 'test-session-001',
        info: { ...sessionCreatedEvent.properties.info, title: 'Fix token accounting' },
      },
    },
  })
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
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run: `bun run test -- tests/runtime/opencode/events.test.ts`

Expected: FAIL because duplicate events are still accumulated and `session.updated` is ignored.

- [ ] **Step 4: Replace counters with ID-keyed message and text-part snapshots**

Use these exact state shapes and derivation rules in `opencode.ts`:

```ts
interface MessageSnapshot {
  sessionId: string
  messageId: string
  role: 'user' | 'assistant'
  createdAt: number
  model: string | null
  tokens: { input: number; output: number; cached: number }
}

interface TextPartSnapshot {
  sessionId: string
  partId: string
  messageId: string
  text: string
  synthetic: boolean
  ignored: boolean
}

interface ToolCallSnapshot {
  sessionId: string
  callId: string
  toolName: string
  args: Record<string, unknown>
  messageId: string | null
  partId: string | null
}

interface SessionAccumulator {
  sessionId: string
  project: string
  startedAt: number
  endedAt: number
  title: string | null
  sessionModel: string | null
  messages: Map<string, MessageSnapshot>
  textParts: Map<string, TextPartSnapshot>
  toolCalls: Map<string, ToolCallSnapshot>
  toolPartIndex: Map<string, string>
  dirty: boolean
  persisted: boolean
  hydrated: boolean
}

// Mirrors OpenCode session/session.ts isDefaultTitle() for generated root/child titles.
const defaultTitlePattern = /^(?:New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function isDefaultSessionTitle(title: string | null | undefined): boolean {
  return !title?.trim() || defaultTitlePattern.test(title)
}

function keyed(sessionId: string, id: string): string {
  return `${sessionId}:${id}`
}

export function createAccumulator(sessionId: string, project = 'unknown'): SessionAccumulator {
  const now = Date.now()
  return {
    sessionId,
    project,
    startedAt: now,
    endedAt: now,
    title: null,
    sessionModel: null,
    messages: new Map(),
    textParts: new Map(),
    toolCalls: new Map(),
    toolPartIndex: new Map(),
    dirty: false,
    persisted: false,
    hydrated: false,
  }
}
```

Delete the old accumulator-default assertions for `turns`, `tokensInput`,
`tokensOutput`, `tokensCached`, `firstUserMessage`, `summary`, `model`, `tools`,
and `skills`; the replacement defaults test above is the complete new contract.

Implement `toParsedSessionData` by reducing unique map values:

```ts
const messages = [...acc.messages.values()]
const userMessages = messages.filter((message) => message.role === 'user')
const assistantMessages = messages.filter((message) => message.role === 'assistant')
const firstRootUser = userMessages
  .filter((message) => message.sessionId === acc.sessionId)
  .sort((a, b) => a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId))[0]
const firstText = [...acc.textParts.values()]
  .filter((part) => part.sessionId === acc.sessionId && part.messageId === firstRootUser?.messageId)
  .filter((part) => !part.synthetic && !part.ignored && part.text.trim())
  .sort((a, b) => a.partId.localeCompare(b.partId))[0]?.text.trim()
const explicitTitle = isDefaultSessionTitle(acc.title) ? null : acc.title!.trim()
const summary = explicitTitle ?? firstText ?? '(untitled session)'
const tokensInput = assistantMessages.reduce((sum, message) => sum + message.tokens.input, 0)
const tokensOutput = assistantMessages.reduce((sum, message) => sum + message.tokens.output, 0)
const tokensCached = assistantMessages.reduce((sum, message) => sum + message.tokens.cached, 0)
```

When converting a raw assistant event into `MessageSnapshot`, map cache usage
exactly as follows:

```ts
const cache = info.tokens?.cache
const snapshot: MessageSnapshot = {
  sessionId,
  messageId: String(info.id),
  role: info.role,
  createdAt: Number(info.time?.created ?? Date.now()),
  model: info.modelID ? String(info.modelID) : null,
  tokens: {
    input: Number(info.tokens?.input ?? 0),
    output: Number(info.tokens?.output ?? 0),
    cached: Number(cache?.read ?? 0) + Number(cache?.write ?? 0),
  },
}
```

Return these totals with `turns: userMessages.length`. Select `model` from the
latest assistant snapshot by `createdAt`, falling back to `acc.sessionModel`.
Use `summarySource: 'auto'` when `explicitTitle` is selected or no text exists;
use `first_message` only when `firstText` supplies the summary.

Counting child user snapshots in the root total intentionally preserves the
existing handler behavior, which routes child `message.updated` events into the
root accumulator before incrementing turns; it is not a new turn-counting rule.

Handle both `session.created` and `session.updated` with the same metadata assignment:

```ts
const info = event.properties?.info
if (info?.title !== undefined) acc.title = String(info.title)
if (info?.time?.created !== undefined) acc.startedAt = Number(info.time.created)
if (info?.time?.updated !== undefined) acc.endedAt = Number(info.time.updated)
if (info?.model?.id) acc.sessionModel = String(info.model.id)
acc.dirty = true
```

When neither title nor first text exists, keep `summarySource: 'auto'`. Resolve session IDs through `properties.sessionID`, then nested `info`, then nested `part`, then lifecycle `info.id`.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run: `bun run test -- tests/runtime/opencode/events.test.ts`

Expected: PASS with one turn and one assistant message worth of tokens after duplicate updates.

- [ ] **Step 6: Commit the message-state change**

```bash
git add opencode.ts tests/fixtures/events.ts tests/runtime/opencode/events.test.ts
git commit -m ':bug: fix(opencode): derive message totals' -m 'Key message and text state by stable OpenCode IDs so repeated updates produce idempotent Timeline snapshots.'
```

### Task 2: Serialized Lifecycle Checkpoints And Removal Events

**Files:**
- Modify: `tests/runtime/opencode/events.test.ts:261-374`
- Modify: `opencode.ts:133-311`

**Interfaces:**
- Consumes: ID-keyed accumulator and `toParsedSessionData(acc)` from Task 1.
- Produces: `enqueue(sessionID, work)`, `checkpoint(acc)`, and `dispose()` returned by `createEventHandler`.

- [ ] **Step 1: Write failing queue, resumed-idle, late-title, and removal tests**

```ts
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
  expect(mockWriter.writeSession.mock.calls.at(-1)![0]).toMatchObject({ turns: 1, tokensInput: 17_473 })
})

it('removes deleted messages from the next checkpoint', async () => {
  const { handler } = createHandler()
  await handler({ event: sessionCreatedEvent })
  await handler({ event: userMessageUpdatedEvent })
  await handler({ event: { type: 'message.removed', properties: { sessionID: 'test-session-001', messageID: 'msg-user-001' } } })
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
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `bun run test -- tests/runtime/opencode/events.test.ts`

Expected: FAIL because idle deletes state, event promises race, and removal events are unhandled.

- [ ] **Step 3: Add a per-root serialized queue and one checkpoint path**

Implement queue insertion synchronously before the handler performs asynchronous work:

```ts
const queues = new Map<string, Promise<void>>()

function enqueue(rootId: string, work: () => Promise<void>): Promise<void> {
  const previous = queues.get(rootId) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(work)
  queues.set(rootId, current)
  return current.finally(() => {
    if (queues.get(rootId) === current) queues.delete(rootId)
  })
}

async function checkpoint(acc: SessionAccumulator): Promise<void> {
  acc.endedAt = Date.now()
  try {
    deps.writer.writeSession(toParsedSessionData(acc))
    acc.persisted = true
    acc.dirty = false
  } catch (error) {
    acc.dirty = true
    deps.log('error', 'Failed to write OpenCode checkpoint', {
      sessionID: acc.sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
```

Do not delete state on `session.idle`. Process `session.updated` through the same
queue and call `checkpoint` only when a meaningful title changed after
`persisted` became true. Handle `message.removed` by deleting the keyed message
and every text/tool snapshot with that message ID; when deleting a tool snapshot,
also remove its `partId` entry from `toolPartIndex`. Task 3 supplies the O(1)
`message.part.removed` reverse lookup.

Return a `dispose` function that snapshots pending work before awaiting it, so
each queue deleting itself in `finally` cannot mutate the collection being
iterated:

```ts
async function dispose(): Promise<void> {
  const pendingQueues = [...new Set(queues.values())]
  await Promise.allSettled(pendingQueues)
  const dirtyRoots = [...sessions.values()].filter((acc) => acc.dirty)
  await Promise.all(dirtyRoots.map((acc) => checkpoint(acc)))
  queues.clear()
  sessions.clear()
  childToParent.clear()
}
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `bun run test -- tests/runtime/opencode/events.test.ts`

Expected: PASS; two idle events retain cumulative state and `dispose()` observes all fire-and-forget work.

- [ ] **Step 5: Commit serialized checkpoint lifecycle**

```bash
git add opencode.ts tests/fixtures/events.ts tests/runtime/opencode/events.test.ts
git commit -m ':bug: fix(opencode): serialize checkpoints' -m 'Queue event work per root session, retain state after idle, and remove deleted message state before replacement checkpoints.'
```

### Task 3: Idempotent Tool Calls, Skills, And Child Routing

**Files:**
- Modify: `tests/fixtures/events.ts:103-139`
- Modify: `tests/runtime/opencode/events.test.ts:197-259`
- Modify: `opencode.ts:60-337`

**Interfaces:**
- Consumes: `ToolCallSnapshot` and `keyed(sessionId, id)` from Task 1, plus the per-root queue and checkpoint derivation.
- Produces: populated `ToolCallSnapshot` entries, synchronous child-to-root registration, and tool hooks compatible with OpenCode's two-argument before-hook signature.

- [ ] **Step 1: Add tool/child fixtures and write failing dedupe tests**

Add these source-shaped fixtures:

```ts
export const toolPartUpdatedEvent = {
  type: 'message.part.updated',
  properties: {
    sessionID: 'test-session-001',
    part: {
      id: 'part-tool-001',
      sessionID: 'test-session-001',
      messageID: 'msg-assistant-001',
      type: 'tool',
      callID: 'call-001',
      tool: 'Read',
      state: { status: 'completed', input: { filePath: '/tmp/a' }, output: '', title: '', metadata: {}, time: { start: 1, end: 2 } },
    },
  },
}

export const childSessionCreatedEvent = {
  type: 'session.created',
  properties: {
    sessionID: 'child-session-001',
    info: {
      id: 'child-session-001',
      parentID: 'test-session-001',
      title: 'Child session - 2026-07-12T03:16:01.973Z',
      time: { created: 1_720_000_000_500, updated: 1_720_000_000_500 },
    },
  },
}

export const childSessionIdleEvent = {
  type: 'session.idle',
  properties: { sessionID: 'child-session-001' },
}
```

```ts
it('counts the same call ID once across hook and persisted part events', async () => {
  const { handler, toolExecuteBefore, toolExecuteAfter } = createHandler()
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
  await handler({ event: sessionIdleEvent })

  expect(mockWriter.writeSession.mock.calls.at(-1)![0].tools).toEqual([{ toolName: 'Read', callCount: 1 }])
})

it('keeps child routing after child idle and namespaces matching call IDs', async () => {
  const { handler, toolExecuteBefore } = createHandler()
  await handler({ event: sessionCreatedEvent })
  await handler({ event: childSessionCreatedEvent })
  await toolExecuteBefore({ sessionID: 'test-session-001', tool: 'Read', callID: 'same' }, { args: {} })
  await toolExecuteBefore({ sessionID: 'child-session-001', tool: 'Read', callID: 'same' }, { args: {} })
  await handler({ event: childSessionIdleEvent })
  await toolExecuteBefore({ sessionID: 'child-session-001', tool: 'Skill', callID: 'skill-001' }, { args: { name: 'github' } })
  await handler({ event: sessionIdleEvent })

  expect(mockWriter.writeSession.mock.calls.at(-1)![0]).toMatchObject({
    tools: expect.arrayContaining([{ toolName: 'Read', callCount: 2 }]),
    skills: ['github'],
  })
  expect(mockWriter.writeSession.mock.calls.every(([data]) => data.sessionId === 'test-session-001')).toBe(true)
})

it('never checkpoints a child or unresolved session ID', async () => {
  const loadSessionTree = vi.fn().mockRejectedValue(new Error('temporarily unavailable'))
  const { handler } = createHandler({ loadSessionTree })
  await handler({ event: childSessionCreatedEvent })
  await handler({ event: childSessionIdleEvent })

  expect(mockWriter.writeSession).not.toHaveBeenCalled()
})

it('removes a deleted tool part from the next checkpoint', async () => {
  const { handler } = createHandler()
  await handler({ event: sessionCreatedEvent })
  await handler({ event: toolPartUpdatedEvent })
  await handler({ event: {
    type: 'message.part.removed',
    properties: { sessionID: 'test-session-001', messageID: 'msg-assistant-001', partID: 'part-tool-001' },
  } })
  await handler({ event: sessionIdleEvent })

  expect(mockWriter.writeSession.mock.calls.at(-1)![0].tools).toEqual([])
})
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `bun run test -- tests/runtime/opencode/events.test.ts`

Expected: FAIL because tools are incremented by name, `callID` is ignored, and child routing is deleted on idle.

- [ ] **Step 3: Store tool calls by namespaced call ID**

```ts
function putToolCall(acc: SessionAccumulator, value: ToolCallSnapshot): void {
  const callKey = keyed(value.sessionId, value.callId)
  acc.toolCalls.set(callKey, { ...acc.toolCalls.get(callKey), ...value })
  if (value.partId) acc.toolPartIndex.set(keyed(value.sessionId, value.partId), callKey)
  acc.dirty = true
}
```

Accept `toolExecuteBefore(input, output)` and read arguments from `output.args`; accept after-hook arguments from `input.args`. For `message.part.updated` tool parts, use `part.callID`, `part.tool`, `part.state.input`, `part.messageID`, and `part.id`. Derive tool counts by grouping unique map values and derive skills from `Skill`/`skill` calls whose `args.name` is a string.

For `message.part.removed`, resolve the call through the reverse index and remove
both entries:

```ts
const partKey = keyed(sessionId, String(event.properties.partID))
const callKey = acc.toolPartIndex.get(partKey)
if (callKey) acc.toolCalls.delete(callKey)
acc.toolPartIndex.delete(partKey)
acc.textParts.delete(partKey)
acc.dirty = true
```

When `handler` receives `session.created`, register `info.parentID` synchronously before enqueueing the event. Resolve every later child operation to the root queue, retain the mapping on child idle, and remove it only on deletion/disposal.

Maintain a `rootSessionIds` set. Add IDs only for parentless `session.created`
events or the root node returned by successful hydration. Route all child state
into the root accumulator, and make checkpointing fail closed:

```ts
function canCheckpoint(acc: SessionAccumulator): boolean {
  if (!rootSessionIds.has(acc.sessionId)) {
    deps.log('warn', 'Skipped non-root OpenCode checkpoint', { sessionID: acc.sessionId })
    return false
  }
  return true
}
```

Call `canCheckpoint(acc)` at the beginning of the Task 2 checkpoint function and
return without invoking the writer when it is false.

If hydration fails for an unknown ID, retain its queued event state for retry but
do not persist it. This prevents a transient routing failure from creating a
child Timeline row.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `bun run test -- tests/runtime/opencode/events.test.ts`

Expected: PASS with one count for a hook/part duplicate and two counts for equal call IDs in different sessions.

- [ ] **Step 5: Commit tool and child identity handling**

```bash
git add opencode.ts tests/fixtures/events.ts tests/runtime/opencode/events.test.ts
git commit -m ':bug: fix(opencode): dedupe tool calls' -m 'Use OpenCode call IDs for tool and skill accounting while preserving child-to-root routing across idle checkpoints.'
```

### Task 4: First-Use SDK Hydration For Resumed Session Trees

**Files:**
- Create: `tests/runtime/opencode/hydration.test.ts`
- Modify: `tests/runtime/opencode/events.test.ts`
- Modify: `opencode.ts:145-365`

**Interfaces:**
- Consumes: snapshot map insertion helpers and child routing from Tasks 1-3.
- Produces: `HydratedSessionNode`, `LoadSessionTree`, `createSessionTreeLoader(client)`, and required `EventHandlerDeps.loadSessionTree`.

- [ ] **Step 1: Write failing SDK adapter tests**

```ts
import { describe, expect, it, vi } from 'vitest'
import { createSessionTreeLoader, type EventHandlerDeps } from '../../../opencode'

vi.mock('bun:sqlite', () => ({ Database: vi.fn() }))

describe('createSessionTreeLoader', () => {
  const rootMessageWithParts = {
    info: {
      id: 'root-user',
      sessionID: 'root',
      role: 'user',
      time: { created: 10 },
      model: { providerID: 'test', modelID: 'model' },
    },
    parts: [{ id: 'root-text', sessionID: 'root', messageID: 'root-user', type: 'text', text: 'Root prompt' }],
  }
  const childMessageWithParts = {
    info: {
      id: 'child-assistant',
      sessionID: 'child',
      role: 'assistant',
      time: { created: 20, completed: 30 },
      modelID: 'model',
      tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 10, write: 5 } },
    },
    parts: [{
      id: 'child-tool',
      sessionID: 'child',
      messageID: 'child-assistant',
      type: 'tool',
      callID: 'child-call',
      tool: 'Read',
      state: { status: 'completed', input: { filePath: '/tmp/a' }, output: '', title: '', metadata: {}, time: { start: 20, end: 21 } },
    }],
  }

  it('unwraps fields responses and recursively loads descendants', async () => {
    const client = {
      session: {
        get: vi.fn().mockResolvedValue({ data: { id: 'root', title: 'Accurate title', time: { created: 1, updated: 2 } } }),
        messages: vi.fn(({ path: { id } }) => Promise.resolve({
          data: id === 'root' ? [rootMessageWithParts] : [childMessageWithParts],
        })),
        children: vi.fn(({ path: { id } }) => Promise.resolve({
          data: id === 'root' ? [{ id: 'child', parentID: 'root', title: 'Child session - 2026-07-12T03:16:01.973Z' }] : [],
        })),
      },
    }

    const tree = await createSessionTreeLoader(client as any)('root')

    expect(tree.info.id).toBe('root')
    expect(tree.children[0].info.id).toBe('child')
    expect(client.session.messages).toHaveBeenCalledTimes(2)
    expect(client.session.children).toHaveBeenCalledTimes(2)
  })

  it('keeps more than one internal server page without client cursor requests', async () => {
    const messages = Array.from({ length: 51 }, (_, index) => ({
      info: { id: `msg-${index}`, sessionID: 'root', role: 'user', time: { created: index } },
      parts: [],
    }))
    const client = { session: {
      get: vi.fn().mockResolvedValue({ data: { id: 'root', title: 'root', time: { created: 1, updated: 2 } } }),
      messages: vi.fn().mockResolvedValue({ data: messages }),
      children: vi.fn().mockResolvedValue({ data: [] }),
    } }

    const tree = await createSessionTreeLoader(client as any)('root')
    expect(tree.messages).toHaveLength(51)
    expect(client.session.messages).toHaveBeenCalledWith({ path: { id: 'root' }, url: '/session/{id}/message' })
    expect(client.session.messages).toHaveBeenCalledTimes(1)
  })

  it('resolves an initially observed child back to its root', async () => {
    const client = {
      session: {
        get: vi.fn(({ path: { id } }) => Promise.resolve({ data: id === 'child'
          ? { id: 'child', parentID: 'root', title: 'child', time: { created: 2, updated: 2 } }
          : { id: 'root', title: 'root', time: { created: 1, updated: 2 } } })),
        messages: vi.fn().mockResolvedValue({ data: [] }),
        children: vi.fn(({ path: { id } }) => Promise.resolve({ data: id === 'root'
          ? [{ id: 'child', parentID: 'root', title: 'child', time: { created: 2, updated: 2 } }]
          : [] })),
      },
    }

    const tree = await createSessionTreeLoader(client as any)('child')
    expect(tree.info.id).toBe('root')
  })

  it('rejects SDK errors instead of accepting missing data', async () => {
    const client = { session: {
      get: vi.fn().mockResolvedValue({ error: { message: 'missing' } }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
      children: vi.fn().mockResolvedValue({ data: [] }),
    } }
    await expect(createSessionTreeLoader(client as any)('missing')).rejects.toThrow('session.get failed')
  })
})
```

- [ ] **Step 2: Write failing event-handler hydration tests**

```ts
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

const createHandler = (overrides: Partial<EventHandlerDeps> = {}) => createEventHandler({
  project: 'test-project',
  writer: mockWriter as any,
  log: mockLog,
  loadSessionTree: vi.fn().mockRejectedValue(new Error('unexpected hydration')),
  ...overrides,
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

it('routes unawaited child and root events through one lane before hydration completes', async () => {
  let release!: (tree: typeof hydratedTree) => void
  const loadSessionTree = vi.fn(() => new Promise<typeof hydratedTree>((resolve) => { release = resolve }))
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
  release(hydratedTree)
  await dispose()

  expect(loadSessionTree).toHaveBeenCalledTimes(1)
  expect(mockWriter.writeSession.mock.calls.at(-1)![0].sessionId).toBe('test-session-001')
  expect(mockWriter.writeSession.mock.calls.at(-1)![0].turns).toBeGreaterThanOrEqual(2)
})
```

- [ ] **Step 3: Run hydration tests and verify RED**

Run: `bun run test -- tests/runtime/opencode/hydration.test.ts tests/runtime/opencode/events.test.ts`

Expected: FAIL because no loader or hydration merge exists.

- [ ] **Step 4: Implement the SDK tree loader**

Extend the existing plugin type import, then add these public structural types
and response validation:

```ts
import type { Plugin, PluginInput } from '@opencode-ai/plugin'

export interface HydratedSessionNode {
  info: Record<string, any>
  messages: Array<{ info: Record<string, any>; parts: Array<Record<string, any>> }>
  children: HydratedSessionNode[]
}

interface SdkResponse<T> {
  data?: T
  error?: unknown
}

export type OpenCodeSnapshotClient = {
  session: Pick<PluginInput['client']['session'], 'get' | 'messages' | 'children'>
}

export type LoadSessionTree = (sessionId: string) => Promise<HydratedSessionNode>

function responseData<T>(label: string, response: { data?: T; error?: unknown }): T {
  if (response.error || response.data === undefined) {
    throw new Error(`${label} failed: ${JSON.stringify(response.error ?? 'missing data')}`)
  }
  return response.data
}
```

OpenCode's no-limit HTTP branch calls `Session.messages`, which internally pages
the database in batches of 50 until exhaustion before returning one response
(`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` and
`packages/opencode/src/session/session.ts`). Therefore do not add client cursor
pagination or a `limit`; the 51-message test above protects this contract.

Implement the loader with the real v1 generated-client options shape:

```ts
export function createSessionTreeLoader(client: OpenCodeSnapshotClient): LoadSessionTree {
  async function loadNode(sessionId: string, knownInfo?: Record<string, any>): Promise<HydratedSessionNode> {
    const [infoResponse, messagesResponse, childrenResponse] = await Promise.all([
      knownInfo
        ? Promise.resolve({ data: knownInfo })
        : client.session.get({ path: { id: sessionId }, url: '/session/{id}' }),
      client.session.messages({ path: { id: sessionId }, url: '/session/{id}/message' }),
      client.session.children({ path: { id: sessionId }, url: '/session/{id}/children' }),
    ])
    const info = responseData<Record<string, any>>('session.get', infoResponse)
    const messages = responseData<HydratedSessionNode['messages']>('session.messages', messagesResponse)
    const childInfos = responseData<Array<Record<string, any>>>('session.children', childrenResponse)
    const children = await Promise.all(childInfos.map((child) => loadNode(String(child.id), child)))
    return { info, messages, children }
  }

  return async (observedSessionId) => {
    const observed = await loadNode(observedSessionId)
    if (!observed.info.parentID) return observed

    let rootInfo = observed.info
    while (rootInfo.parentID) {
      rootInfo = responseData<Record<string, any>>(
        'session.get',
        await client.session.get({ path: { id: String(rootInfo.parentID) }, url: '/session/{id}' }),
      )
    }
    return loadNode(String(rootInfo.id), rootInfo)
  }
}
```

- [ ] **Step 5: Add a routing barrier before per-root queues**

An unknown child cannot choose a queue until hydration reveals its root. Route
every event and tool hook through a short global barrier that only serializes
route discovery and synchronous queue insertion; the root work itself remains on
the per-root queue:

```ts
let routingTail: Promise<void> = Promise.resolve()

function routeAndEnqueue(sessionId: string, work: (rootId: string) => Promise<void>): Promise<void> {
  let queued: Promise<void> = Promise.resolve()
  const routed = routingTail.catch(() => undefined).then(async () => {
    const rootId = await ensureRootRoute(sessionId)
    queued = enqueue(rootId, () => work(rootId))
  })
  routingTail = routed.catch(() => undefined)
  return routed.then(() => queued)
}
```

`ensureRootRoute` performs or joins hydration, then registers every discovered
descendant directly to the final root ID before returning. Never move pending
promises between maps after the fact. Because the next route waits `routingTail`,
an unawaited root event arriving behind an unknown child is inserted into the
same root queue after the child's work.

- [ ] **Step 6: Merge hydration atomically into the root accumulator**

Require `loadSessionTree` in `EventHandlerDeps`. Keep one in-flight promise per requested session/root. Recursively register every child-to-root mapping, apply all message snapshots before all parts, and update root metadata only from the root node. Merge by namespaced IDs without clearing live state.

Mark a session created in the current process as hydrated immediately. For an unknown session, attempt hydration before applying its current event. On failure, log `Hydration failed`, create or retain event-only state, apply the current event, and leave `hydrated` false so the next event retries.

Update `dispose()` to await the routing barrier before snapshotting queue values:

```ts
await routingTail.catch(() => undefined)
const pendingQueues = [...new Set(queues.values())]
await Promise.allSettled(pendingQueues)
```

Audit every retained event test that emits `message.updated`,
`message.part.updated`, or a tool hook without first emitting `session.created`.
Either add `session.created` when the test describes a new session, or inject an
explicit successful `loadSessionTree` fixture when it describes a resumed one;
do not let the default rejecting loader generate incidental error logs.

- [ ] **Step 7: Run hydration and event tests and verify GREEN**

Run: `bun run test -- tests/runtime/opencode/hydration.test.ts tests/runtime/opencode/events.test.ts`

Expected: PASS; an existing root and descendants load once, SDK errors retry, and duplicate IDs remain idempotent.

- [ ] **Step 8: Commit first-use hydration**

```bash
git add opencode.ts tests/runtime/opencode/hydration.test.ts tests/runtime/opencode/events.test.ts
git commit -m ':bug: fix(opencode): hydrate resumed sessions' -m 'Load complete root and child session snapshots through the local OpenCode SDK before applying resumed-session events.'
```

### Task 5: Plugin Lifecycle Integration, Release Note, And Artifacts

**Files:**
- Modify: `opencode.ts:340-367`
- Create: `.changeset/quiet-sessions-checkpoint.md`
- Modify (generated): `dist/index.js`
- Verify: `tests/config/plugin.test.ts`

**Interfaces:**
- Consumes: `createSessionTreeLoader(input.client)` and handler `dispose()` from earlier tasks.
- Produces: final OpenCode hooks object with event, tool, and dispose hooks backed by the same state and queue.

- [ ] **Step 1: Write the failing lifecycle assertion**

First add these tests and import `createTimelineHooks` and
`disposeTimelineRuntime` from `opencode.ts`:

```ts
it('flushes queued events and closes the database on dispose', async () => {
  const close = vi.fn()
  const client = { session: {
    get: vi.fn(),
    messages: vi.fn(),
    children: vi.fn(),
  } }
  const hooks = createTimelineHooks({
    project: 'test-project',
    writer: mockWriter as any,
    client: client as any,
    close,
  })

  void hooks.event({ event: sessionCreatedEvent as any })
  void hooks.event({ event: userMessageUpdatedEvent as any })
  void hooks.event({ event: sessionIdleEvent as any })
  await hooks.dispose()

  expect(mockWriter.writeSession.mock.calls.at(-1)![0].turns).toBe(1)
  expect(close).toHaveBeenCalledTimes(1)
})

it('closes the database once when runtime disposal rejects', async () => {
  const close = vi.fn()
  await expect(disposeTimelineRuntime(
    () => Promise.reject(new Error('queue failed')),
    close,
  )).rejects.toThrow('queue failed')
  expect(close).toHaveBeenCalledTimes(1)
})
```

The production helper under test is:

```ts
export async function disposeTimelineRuntime(
  disposeRuntime: () => Promise<void>,
  close: () => void,
): Promise<void> {
  try {
    await disposeRuntime()
  } finally {
    close()
  }
}

export function createTimelineHooks(input: {
  project: string
  writer: ReturnType<typeof createWriter>
  client: Parameters<typeof createSessionTreeLoader>[0]
  close: () => void
}) {
  const runtime = createEventHandler({
    project: input.project,
    writer: input.writer,
    log,
    loadSessionTree: createSessionTreeLoader(input.client),
  })
  return {
    event: runtime.handler,
    'tool.execute.before': runtime.toolExecuteBefore,
    'tool.execute.after': runtime.toolExecuteAfter,
    dispose: () => disposeTimelineRuntime(runtime.dispose, input.close),
  }
}
```

- [ ] **Step 2: Run the lifecycle test and verify RED**

Run: `bun run test -- tests/runtime/opencode/events.test.ts`

Expected: FAIL because `createTimelineHooks` and the wired dispose hook do not exist.

- [ ] **Step 3: Wire the production plugin through `createTimelineHooks`**

After `ensureDb()` and `createWriter(db)`, return:

```ts
return createTimelineHooks({
  project,
  writer: writer!,
  client: input.client,
  close: () => db?.close(),
})
```

Keep the existing database-initialization failure behavior returning `{}` and logging the error.

- [ ] **Step 4: Run all tests and type/build checks**

Run: `bun run test`

Expected: all Vitest suites PASS.

Run: `bunx tsc --noEmit`

Expected: exit 0 with no TypeScript diagnostics.

Run: `bun run build`

Expected: exit 0 and `dist/index.js` is regenerated.

- [ ] **Step 5: Add the patch changeset**

Create `.changeset/quiet-sessions-checkpoint.md` with exactly:

```md
---
'@ohmyc/timeline-plugin': patch
---

Make OpenCode session checkpoints idempotent across duplicate events, resumed sessions, generated titles, and child tool calls.
```

- [ ] **Step 6: Verify package contents**

Run: `npm pack --dry-run --json`

Expected: exit 0; JSON output includes `dist/index.js`, `dist/ingest.mjs`, plugin manifests, hooks, README, and the package metadata expected by `tests/config/plugin.test.ts`.

Run: `git diff --check`

Expected: exit 0 with no whitespace errors.

- [ ] **Step 7: Commit lifecycle, release note, and generated artifact**

```bash
git add opencode.ts tests/runtime/opencode/events.test.ts .changeset/quiet-sessions-checkpoint.md dist/index.js
git commit -m ':bug: fix(opencode): ship session checkpoints' -m 'Wire hydration and disposal into the plugin entry point, publish the generated runtime, and document the patch release.'
```

- [ ] **Step 8: Record final verification evidence**

Run: `git status --short`

Expected: no output.

Record the exact passing totals from `bun run test`, the successful TypeScript/build commands, and the package file count from `npm pack --dry-run --json` in the implementation handoff.
