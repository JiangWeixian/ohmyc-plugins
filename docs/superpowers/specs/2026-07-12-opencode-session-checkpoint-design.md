# OpenCode Session Checkpoint Design

## Goal

Make future OpenCode Timeline records accurate when events are duplicated, arrive
in different SDK shapes, arrive after `session.idle`, or continue an existing
session after the plugin process restarts.

This change does not modify or backfill existing Timeline rows.

## Current Failure Modes

The current handler treats events as one-shot deltas:

- `message.updated` increments turns and tokens every time it is received, even
  when the event updates a message already seen.
- `session.idle` writes the accumulator and deletes it. A later turn in the same
  OpenCode session starts at zero and replaces the earlier Timeline row.
- `session.updated` is ignored, so OpenCode-generated titles never replace the
  fallback summary.
- Event versions disagree about whether `sessionID` is on `properties`, `info`,
  or `part`, which can silently detach messages and parts from their session.
- A plugin restart loses all in-memory state for a session that may later resume.

## Chosen Approach

Use first-use hydration followed by idempotent incremental checkpoints.

When the upgraded plugin sees a newly created session, it initializes an empty
state from `session.created`; no hydration is needed. When it first encounters a
session that was not created in the current plugin process, it hydrates that
session from OpenCode using `session.get` and `session.messages`. The two local
requests run concurrently.

After initialization, events update maps keyed by stable OpenCode IDs. An idle
event writes a complete snapshot derived from those maps and retains the state
for later turns. A resumed session therefore continues from the previous
checkpoint instead of replacing it with only the latest turn.

The scope covers sessions created or resumed after this version is installed.
It deliberately does not rewrite sessions that are never opened again.

## State Model

Replace counter-only accumulation with an idempotent session state:

- Session metadata: ID, project, directory, title, timestamps, model, and the
  latest aggregate token snapshot when OpenCode provides one.
- Messages: `Map<messageID, MessageSnapshot>` containing role, timestamps,
  model, and the latest token values for each message.
- Text parts: `Map<partID, TextPartSnapshot>` containing message ID, text, and
  synthetic/ignored flags.
- Tool calls: `Map<sessionID:callID, ToolCallSnapshot>` containing the tool name
  and arguments needed to identify skills.
- Skills: derived from unique tool calls rather than incremented independently.
- Lifecycle flags: hydration state, in-flight hydration promise, dirty state,
  and whether at least one checkpoint has been persisted.

Receiving a duplicate event replaces the existing map entry. It never increments
a persisted total directly.

## Hydration And Concurrency

`createEventHandler` receives a snapshot loader dependency. The OpenCode plugin
entry point implements it with the injected client:

1. `client.session.get()` loads title, directory, timestamps, model, and any
   aggregate token fields exposed by the running OpenCode version.
2. `client.session.messages()` loads existing message metadata and parts.

Only one hydration promise may exist per session. Event and tool hooks await that
promise before applying their current event, so a stale hydration response cannot
overwrite a newer live event. A `session.created` event marks a genuinely new
session as initialized without performing the requests.

Hydration failures are logged and leave the state retryable. The current event is
still applied, and the next idle or event retries hydration. OpenCode execution is
never failed because Timeline hydration failed.

Session state remains in memory after idle. It is removed on `session.deleted` or
plugin disposal. This trades a compact map per observed session for avoiding a
full-history request after every turn. No timers or background polling are added.

## Checkpoint Derivation

Every checkpoint rebuilds `ParsedSessionData` from current state:

- `turns` is the number of unique user message IDs.
- Tokens use the latest session aggregate when available. Otherwise they are the
  sum of the latest values for unique assistant message IDs.
- Cached tokens are cache reads plus cache writes.
- `model` is the latest assistant model, falling back to session metadata.
- Tools are unique calls keyed by `sessionID:callID`, grouped by tool name only
  when producing `callCount`.
- Skills are unique `Skill` or `skill` calls derived from those tool snapshots.

The writer continues to replace the Timeline row for the session, but each write
contains the complete derived state. Repeated checkpoints therefore produce the
same totals until the underlying session changes.

Child session events continue to resolve to their root parent. Their message and
tool IDs are namespaced by child session ID before merging, preventing collisions
with parent IDs or sibling child sessions. Child idle cleans up only the routing
relationship; merged state remains in the parent checkpoint.

## Title Rules

Title selection uses this priority:

1. A non-default OpenCode title from `session.created` or `session.updated`.
2. The first chronological non-synthetic, non-ignored user text part.
3. `(untitled session)` when no usable content exists.

An empty title, `New session`, or `New session - ...` is considered a temporary
OpenCode default and is not treated as a meaningful summary.

OpenCode may generate a title after the session first becomes idle. If a
meaningful title arrives in `session.updated` after a checkpoint, the handler
writes another checkpoint immediately. This updates the existing Timeline row
without waiting for another user turn. OpenCode titles use `summarySource: auto`;
first-message fallbacks use `summarySource: first_message`.

## Event Compatibility

Session ID extraction accepts the known shapes in this order:

1. `event.properties.sessionID`
2. `event.properties.info.sessionID` or `session_id`
3. `event.properties.part.sessionID` or `session_id`
4. `event.properties.info.id` for session lifecycle events

Message and part IDs are required for idempotent accounting. If an old event
omits one, the handler logs the event as unsupported and does not invent an ID
that could merge unrelated data.

## Error Handling

- Snapshot read failures log the session ID and cause a later retry.
- A failed Timeline write retains dirty state and in-memory session state so the
  next checkpoint can retry.
- A successful write clears dirty state but does not clear the maps.
- Title correction writes use the same checkpoint path as idle writes.
- Exceptions remain isolated from the OpenCode host, matching current behavior.

## Tests

Add behavior tests for:

- Hydrating an existing session once and checkpointing its complete state.
- Skipping hydration for a session observed from `session.created`.
- Resolving outer and nested `sessionID` event shapes.
- Replacing duplicate `message.updated` events without increasing turns or
  tokens.
- Replacing duplicate tool events with the same call ID without increasing tool
  counts or skills.
- Keeping cumulative state across idle, another turn, and a second idle.
- Using an OpenCode title and rejecting temporary default titles.
- Rewriting an existing checkpoint when a meaningful title arrives after idle.
- Falling back to the first chronological user text part.
- Retrying after hydration or writer failure.
- Namespacing child and parent tool call IDs.

The focused OpenCode event suite runs first during development, followed by the
full Vitest suite and production build.

## Non-Goals

- Backfilling or deleting existing Timeline rows.
- Changing the Timeline database schema.
- Polling OpenCode in the background.
- Changing Claude Code or Codex ingestion behavior.
- Guaranteeing recovery of data OpenCode itself no longer returns.
