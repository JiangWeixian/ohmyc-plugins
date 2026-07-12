# OpenCode Session Checkpoint Design

## Goal

Make future OpenCode Timeline records accurate when events are duplicated, arrive
in different SDK shapes, arrive after `session.idle`, or continue an existing
session after the plugin process restarts.

This change does not modify or backfill existing Timeline rows.

## Source Validation

This design was checked against OpenCode `34e5809059` (SDK and plugin version
1.17.18) and the official plugin and SDK documentation on 2026-07-12.

The relevant upstream behavior is:

- Plugin context includes a generated local SDK client.
- Event hooks are invoked without awaiting their promises, while tool hooks are
  awaited.
- `session.messages()` without a limit returns the full history after internal
  pagination.
- Automatic title generation runs in a background fiber and can finish after
  the session first becomes idle.
- Session aggregate usage is projected from `step-finish` part updates.
- Tool hooks and persisted tool parts share the same `callID`.

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
session from OpenCode using the injected SDK client. Root session metadata,
messages, and children are requested concurrently when all three are needed.
Child messages and descendants are then loaded concurrently by tree level.

After initialization, events update maps keyed by stable OpenCode IDs. An idle
event writes a complete snapshot derived from those maps and retains the state
for later turns. A resumed session therefore continues from the previous
checkpoint instead of replacing it with only the latest turn.

The scope covers sessions created or resumed after this version is installed.
It deliberately does not rewrite sessions that are never opened again.

## State Model

Replace counter-only accumulation with an idempotent session state:

- Session metadata: ID, project, directory, title, timestamps, and model.
- Messages: `Map<sessionID:messageID, MessageSnapshot>` containing role,
  timestamps, model, and the latest token values for each message.
- Text parts: `Map<sessionID:partID, TextPartSnapshot>` containing message ID,
  text, and synthetic/ignored flags.
- Tool calls: `Map<sessionID:callID, ToolCallSnapshot>` containing the tool name
  and arguments needed to identify skills, plus source message and part IDs when
  a persisted tool part is available.
- Skills: derived from unique tool calls rather than incremented independently.
- Lifecycle flags: hydration state, in-flight hydration promise, dirty state,
  and whether at least one checkpoint has been persisted.

Receiving a duplicate event replaces the existing map entry. It never increments
a persisted total directly.

## Hydration And Concurrency

`createEventHandler` receives a snapshot loader dependency. The OpenCode plugin
entry point implements it with the injected client:

1. `client.session.get()` loads title, directory, timestamps, and model when the
   triggering event does not already contain complete session metadata.
2. `client.session.messages()` loads existing message metadata and parts.
3. `client.session.children()` discovers child sessions whose messages and tool
   calls must continue to merge into the root session.

The injected client uses the generated SDK's `fields` response style, so the
adapter validates and unwraps `.data` rather than treating the whole response as
the session or message array. Calling `session.messages()` without a limit is one
local HTTP request; OpenCode performs its own internal database pagination and
returns the complete ordered history.

A new session performs no hydration requests. A resumed root normally performs
two or three concurrent local requests, depending on whether metadata is already
available. Existing descendants add one messages request and one children request
per child; child metadata comes from the parent's children response. Descendant
hydration is necessary only after a plugin restart and avoids dropping previously
merged subagent usage from a later replacement checkpoint.

OpenCode invokes plugin event hooks without awaiting the returned promise. The
handler therefore maintains a serialized task queue per root session. Each hook
synchronously appends its work to that queue before returning; queued work awaits
hydration and then applies the event. Tool hooks join and await the same queue.
This preserves publish order and prevents `session.idle`, a late title update, or
a stale hydration response from racing newer state.

Only one hydration promise may exist per session tree. A `session.created` event
marks a genuinely new session as initialized without performing the requests.

Hydration failures are logged and leave the state retryable. The current event is
still applied, and the next idle or event retries hydration. OpenCode execution is
never failed because Timeline hydration failed. A successful retry merges
snapshots into existing ID-keyed maps instead of clearing event state collected
after the earlier failure.

Session state remains in memory after idle. It is removed on `session.deleted`.
Plugin disposal waits for queued work, checkpoints dirty root sessions, and then
releases state. This trades a compact map per observed session for avoiding a
full-history request after every turn. No timers or background polling are added.

## Checkpoint Derivation

Every checkpoint rebuilds `ParsedSessionData` from current state:

- `turns` is the number of unique user message IDs across the root and merged
  child sessions, preserving the current plugin's merge behavior.
- Tokens are the sum of the latest values for unique assistant message IDs.
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
with parent IDs or sibling child sessions. Child idle retains both routing and
merged state because the same child session may resume. Routing is removed only
when the child or root session is deleted or the plugin is disposed.

OpenCode does maintain aggregate session tokens, but those totals are projected
from `step-finish` parts directly into the session row and are not guaranteed to
arrive through `session.updated`. A value read only during first-use hydration
would therefore become stale. Message snapshots are the sole accounting source;
session aggregate tokens may be logged as a diagnostic comparison but never
added to message totals or preferred over them.

## Title Rules

Title selection uses this priority:

1. A non-default OpenCode title from `session.created` or `session.updated`.
2. The first chronological non-synthetic, non-ignored user text part belonging
   to the root session.
3. `(untitled session)` when no usable content exists.

Default-title detection mirrors OpenCode's `isDefaultTitle`: `New session - ` or
`Child session - ` followed by an ISO timestamp. An empty title is also unusable.
Other user-supplied titles are preserved even when they begin with similar words.

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

`message.removed` and `message.part.removed` delete the corresponding map entries
so a later checkpoint reflects OpenCode reverts and deletions instead of retaining
usage or tools that no longer exist. Tool snapshots retain their source part ID
so a part-removal event can locate the corresponding call-ID entry.

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
- Serializing fire-and-forget event hooks before an idle checkpoint.
- Keeping cumulative state across idle, another turn, and a second idle.
- Using an OpenCode title and rejecting temporary default titles.
- Rewriting an existing checkpoint when a meaningful title arrives after idle.
- Falling back to the first chronological user text part.
- Retrying after hydration or writer failure.
- Namespacing child and parent tool call IDs.
- Recursively hydrating child sessions after a plugin restart.
- Removing messages and tool parts from the next derived checkpoint.

The focused OpenCode event suite runs first during development, followed by the
full Vitest suite and production build.

## Non-Goals

- Backfilling or deleting existing Timeline rows.
- Changing the Timeline database schema.
- Polling OpenCode in the background.
- Changing Claude Code or Codex ingestion behavior.
- Guaranteeing recovery of data OpenCode itself no longer returns.
