# Cursor / Grok Timeline verification

Status: draft, not ready to merge or release. UI changes are excluded and have been fully reverted. This report summarizes local verification performed on 2026-09-12; preparing the MR on 2026-09-26 did not rerun the full suite or native model sessions.

## Implemented scope

- Cursor CLI and Grok Build native manifests, hooks, session adapters, explicit successful skill-read evidence and package metadata.
- Shared event identity, deduplication, cumulative usage reduction, durable outbox and manual replay.
- New agent code under src/agents/<agent> and hooks/<agent>; shared additions under shared folders. Existing Claude/Codex hook bodies and opencode.ts remain byte-identical to baseline 38adc3b.
- Data-layer token completeness contract comes from a separate local OhMyC branch. No UI components, icons, status labels or UI tests are part of this delivery.

## Automated verification

Verified plugin source: 4d115cff94ccdf8d880758b073abb43331041874. Companion Timeline source: 4948865a944ab9492bd0f76bd30be2edc3362d32.

| Check | Recorded result |
| --- | --- |
| bun run test:coverage | 230/230 tests, 18 files; 87.41% statements/lines, 89.08% branches, 94.61% functions |
| Builds, production TypeScript, manifest version sync, package contents | Passed with the identified local prerequisite artifact |
| Companion writer/database focused tests | 15/15 |
| Actual Bun bundle, existing schema-v3 database | 2/2, including a forced 250ms write-lock overlap; preserves existing sessions/tools/skills |
| Packed package outside checkout | All 19 files match the worktree; no node_modules |
| Database busy, replay twice | Last event retained and restored; second replay does not duplicate counts |

The compatibility initializer temporarily waits up to 1000ms for the migration lock and restores the caller's busy timeout. Persistent contention beyond that bound can still fail initialization. Malformed lock ownership, PID reuse and reclamation chains beyond 16 remain conservative.

## Native CLI evidence

Native model runs used plugin a05273b. The subsequent 4d115cf delta changes only bounded writer migration handling, generated bundles and migration regressions; its changed path was checked by the actual Bun tests and final CI command. Native sessions were not rerun against that final delta.

| Scenario | Result |
| --- | --- |
| Cursor CLI 2026.09.10-fd3934a, external plugin path containing spaces | Two resumed prompts, successful/failed Read, one row with two turns/two tools |
| Cursor model switch, SIGINT after Read, resume | Final four accepted turns/three Read calls; host remains cursor |
| Cursor transcript filesystem unavailable | Two Read attempts retained; exact turns unavailable and not invented. No supported native transcript-off toggle was found |
| Cursor native plus compatibility route, then native only | One/two turns and one/two reads respectively, without double counting |
| Cursor explicit successful SKILL.md read | One turn, one Read, one skill |
| Cursor subagent | Public sources lacked a proven parent relationship; unlinked activity remains pending and excluded from totals |
| Grok Build 1.0.25 / 1.0.30, plugin-only startup | Fails to activate plugin hooks despite enabled/trusted discovery |
| Grok with one-time native registration in isolated GROK_HOME | Ordinary CLI collection succeeds without reload or manual replay |
| Grok success/failure/skill reads, native max-turns cancellation, resume | Five turns/four reads; usage 55441 input / 474 output / 222080 cached exactly matches the native cumulative file |
| Grok real subagent | One root row/one user turn/three tools; usage 52854 / 446 / 68608 equals the parent total without adding child usage again |

Cursor hooks do not expose verified usage, so token status is unavailable. Existing UI remains unchanged and may show unavailable numeric slots as zero; the stored status distinguishes this from measured zero. Hook tests used a task-local Node 24.6.0 shell; the machine's Node 20 shell initially failed the declared Node >=22 runtime requirement.

Dedicated test configuration and the temporary authentication copy were removed after verification. Original user configuration and credentials were left unchanged.

## Merge and release blockers

1. Grok needs a shippable one-time native hook registration flow, or a verified upstream fix for automatic plugin-hook activation. No setup helper has been added; plugin install alone is not sufficient on tested versions.
2. The exact published Timeline dependency and lockfile remain unresolved. The manifest still declares 0.0.0-snapshot-20260614095355, whereas local builds used the companion changes. A frozen clean install is not proven equivalent and must pass before merge.

The local companion tarball SHA-256 is 7e9e22b4106744cefc00d61a5b9957a525b577f799fc56d53d588195e6951f8d. Its npm integrity is sha512-z5YwU7OtxlTREjOhkvM8p+CYL+zG3lrQMncsTAHrIHxKmt6Tb6cfuUYdOMnKkEZWUTAY1T5LGdrB6O3MLzOYww==. This identifies an unpublished test artifact, not a released npm version.

No new UI or UI release is required. No package was published by this task. Current CI and complete clean-install acceptance remain outstanding.
