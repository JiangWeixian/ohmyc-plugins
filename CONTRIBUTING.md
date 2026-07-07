# Contributing

## Prerequisites

- Node.js 22 or later. The hook runtime and CLI tests use `node:sqlite`.
- Bun 1.3.x. CI installs Bun 1.3.12.
- `jq` is optional for hook fast paths; tests cover the Node fallback.

## Setup

Install dependencies from the lockfile:

```bash
bun install --frozen-lockfile
```

Build both runtime outputs before testing packaging or local plugin installs:

```bash
bun run build
```

The build writes `dist/ingest.mjs` for Claude Code and Codex hooks, and `dist/index.js` for OpenCode.

## Local Agent Testing

Test local plugin installs from a checkout before changing manifests, hooks, or
package output.

### Claude Code

Run Claude Code from this repository and add the local marketplace:

```text
/plugin marketplace add .
/plugin install timeline@ohmyc
```

### Codex

Point Codex at this checkout as a local marketplace:

```bash
codex plugin marketplace add "$(pwd)"
```

Then open Codex and install **OhMyC Timeline** from the plugin browser:

```text
codex
/plugins
```

### OpenCode

Build the plugin and copy the OpenCode bundle into the project you want to test:

```bash
bun install --frozen-lockfile
bun run build
mkdir -p .opencode/plugins
cp dist/index.js .opencode/plugins/timeline.js
```

OpenCode loads files from `.opencode/plugins/` at startup.

## Tests and Checks

Run the standard test suite with Vitest:

```bash
bun run test
```

Run the CI coverage command when changing runtime behavior:

```bash
bun run test:coverage
```

Do not use `bun test`. This project is configured for Vitest in Node, and direct Bun test execution can hit incompatible `node:sqlite` paths.

Before release or plugin packaging changes, inspect the package contents:

```bash
npm pack --dry-run --json
```

## Code Style

Use TypeScript ESM, two-space indentation, single quotes, and no semicolons. Keep host-specific code separated: Node hook ingestion belongs in `src/ingest.ts`, and Bun/OpenCode plugin code belongs in `opencode.ts`.

## Packaging Changes

`dist/ingest.mjs` and `dist/index.js` are install-time runtime files. If you change build output, plugin manifests, marketplaces, hooks, or package contents, update or add tests in `tests/config/plugin.test.ts`.

This repository uses Changesets. Add a `.changeset/*.md` file for meaningful user-facing package changes, including docs that affect installation or usage:

```bash
./node_modules/.bin/changeset status
```

## Commits and Pull Requests

Use the fast-commit style:

```text
<gitmoji_code> <type>(<scope>): <subject>
```

Examples:

```text
:wrench: build(plugin): include dist outputs
:memo: docs(readme): add agent setup guide
```

Keep the subject imperative and 50 characters or fewer. Include a body that explains why the change is needed.

Before opening a pull request:

1. Run `bun run test`.
2. Run `./node_modules/.bin/changeset status` when the package changes.
3. Update README or this guide when commands, install paths, or runtime behavior change.
4. Fill the project PR template with a summary and verified test results.
