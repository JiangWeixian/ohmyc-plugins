# Repository Guidelines

## Project Structure & Module Organization

This repository publishes the OhMyC Timeline plugin for multiple agent hosts.
Core Node hook ingestion lives in `src/ingest.ts` and builds to
`dist/ingest.mjs`. The OpenCode runtime entry is `opencode.ts` and builds to
`dist/index.js`. Codex metadata is in `.codex-plugin/plugin.json`, the repo
marketplace is `.agents/plugins/marketplace.json`, and Claude metadata is under
`.claude-plugin/`. Hook scripts live in `hooks/`, image assets in `assets/`, and
tests in `tests/` with fixtures in `tests/fixtures/`.

## Build, Test, and Development Commands

- `bun install --frozen-lockfile`: install dependencies exactly from `bun.lock`.
- `bun run build`: builds both runtime outputs in `dist/`.
- `bun run test`: runs the Vitest suite in Node.
- `bun run test:coverage`: runs Vitest with V8 coverage; this is what CI uses.
- `npm pack --dry-run --json`: verify package contents before publishing.

Do not use `bun test` as the project test command. The suite is configured for
Vitest/Node, and direct Bun test execution can hit incompatible `node:sqlite`
paths.

## Coding Style & Naming Conventions

Use TypeScript ESM with strict typing. Follow the existing style: two-space
indentation, single quotes, no semicolons, and explicit exports for testable
helpers. Keep runtime-specific code separated: Node hook logic belongs in
`src/ingest.ts`, while Bun/OpenCode logic belongs in `opencode.ts`.

## Testing Guidelines

Tests use Vitest and should live beside the relevant runtime area under
`tests/runtime/` or `tests/config/`. Name tests by behavior, for example
`ingests pre-parsed JSON from stdin via --raw`. When changing plugin packaging,
add or update config tests that assert manifest, marketplace, package, and
`dist/` installability assumptions.

## Commit & Pull Request Guidelines

Use the fast-commit style for commit messages:
`<gitmoji_code> <type>(<scope>): <subject>`. Use gitmoji text codes, not emoji
characters, for example `:memo: docs(agents): add contributor guide` or
`:wrench: ci(release): align publish workflow`. Keep the title imperative and
50 characters or fewer. Add a body wrapped at 72 characters that explains why
the change is needed. PRs should include a short description, linked issue when
available, test results, and screenshots only for visible asset or UI changes.

## Packaging Notes

`dist/ingest.mjs` and `dist/index.js` are install-time runtime files. Keep them
available for Git-backed Codex installs and confirm they appear in package
output before release.
