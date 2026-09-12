# Plugin Task 4 Report

## Implemented

- Added a durable per-session collector journal with SHA-256 directories,
  identity files, exclusive event linking, atomic state replacement, selective
  acknowledgement, pending-key enumeration, and corrupt-state quarantine.
- Added PID/token session locks. Live and EPERM locks remain owned, only ESRCH
  locks are reclaimed under an exclusive reclamation guard after a token
  recheck, malformed locks are preserved, and acquisition waits at most 300 ms.
- Added enqueue-first ingestion and replay with previous-state plus pending
  hydration context, session grouping, durable child-to-root forwarding outside
  nested locks, SQLite busy retries at 25/75/150 ms, and a 1000 ms soft budget.
- Failed hydration, writer, state-save, and acknowledgement paths retain durable
  pending events. Corrupt state cannot overwrite a previously complete snapshot.
- Hydration requests require a matching `needsHydration: false` fact before ack;
  useful partial facts remain queued. Matching same-session resolved facts can
  retire unresolved events without acknowledging unrelated child activity.
- Added a real-process worker using the installed `@ohmyc/timeline` artifact.

## TDD Evidence

RED:

```text
bun run test -- tests/runtime/collectors/ingest-event.test.ts
FAIL tests/runtime/collectors/ingest-event.test.ts
Error: Cannot find module '../../../src/shared/collectors/ingest-event'
Test Files 1 failed (1); Tests no tests
```

The failure was expected because Task 4's ingestion module did not exist.

GREEN focused:

```text
bun run test -- tests/runtime/collectors/journal.test.ts tests/runtime/collectors/ingest-event.test.ts
Test Files 2 passed (2)
Tests 16 passed (16)
```

GREEN full plugin suite after final self-review changes:

```text
bun run test
Test Files 11 passed (11)
Tests 132 passed (132)
```

Additional type check:

```text
bunx tsc --noEmit -p tsconfig.json
```

This reports only the three pre-existing tracked Claude fixture errors at
`tests/runtime/claude/ingest-hook.test.ts:246` and `:279` where captured fields
are typed `unknown`. No Task 4 file error was reported.

## Process Verification

The focused suite bundles `collector-worker.ts` for Node and executes the real
installed Timeline SQLite writer. It proves replay in a new process after exit
immediately after writer success, replay after state save but before ack, two
concurrent workers enqueueing distinct tool IDs for one session, and convergence
after two replay passes to one database session with two tool calls.

## Files Changed

- `plugins/timeline/src/shared/collectors/journal.ts`
- `plugins/timeline/src/shared/collectors/lock.ts`
- `plugins/timeline/src/shared/collectors/ingest-event.ts`
- `plugins/timeline/tests/runtime/collectors/journal.test.ts`
- `plugins/timeline/tests/runtime/collectors/ingest-event.test.ts`
- `plugins/timeline/tests/fixtures/collector-worker.ts`

## Self-review

- Tightened corrupt-state handling so a quarantined marker prevents a later
  incomplete rebuild from silently replacing complete database data.
- Tightened unresolved-parent acknowledgement to require a corresponding
  forwarded source, turn, and tool ID rather than acknowledging all child facts.
- Serialized stale-lock reclamation to close the concurrent reaper TOCTOU window;
  the process-level lock tests prove owners never overlap.
- Verified no manifest, lockfile, legacy runtime, UI, or controller-owned file is
  included in the Task 4 change.

## Concerns

- Corrupt state with previously acknowledged history deliberately remains queued
  for host hydration/manual repair. This is conservative and prevents incomplete
  overwrite, as required.

## Review Fix Round 1

Implemented the three Important review findings:

- Added `CollectorEvent.resolvesEventId` and replaced optional turn/tool matching
  with exact original event identity plus host and local/source relationship.
- Kept dual `unresolvedParent` and `needsHydration` requests pending until both
  obligations are explicitly satisfied. The empty-state branch now applies the
  same retained set as the normal state/write branch.
- Reworked `exit-after-save` to execute the real installed Timeline writer through
  `ingestEvents`, observe the newly saved event in atomic state, and exit before
  acknowledgement. The parent test proves both the SQLite write and pending file
  exist at that crash point before replay.

Adapter convention: every completion fact sets `resolvesEventId` to the exact
request event ID. A hydration completion also explicitly sets
`needsHydration: false`. Cross-session completion keeps `sourceSessionId` equal to
the original native session. Partial facts may carry `resolvesEventId`, but leave
`needsHydration: true`; they cannot retire the hydration request.

Review RED:

```text
bun run test -- tests/runtime/collectors/ingest-event.test.ts
Test Files 1 failed (1)
Tests 3 failed | 8 passed (11)
```

The three expected failures proved exact hydration completion was not recognized,
one completion incorrectly acknowledged both lifecycle requests, and partial
cross-session forwarding incorrectly deleted a dual-obligation request.

Review GREEN focused:

```text
bun run test -- tests/runtime/collectors/journal.test.ts tests/runtime/collectors/ingest-event.test.ts
Test Files 2 passed (2)
Tests 18 passed (18)
```

Review GREEN full plugin suite:

```text
bun run test
Test Files 11 passed (11)
Tests 134 passed (134)
```
