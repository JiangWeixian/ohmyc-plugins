# Shared timeline runtime

The hash-named tarball pins the additive v5 usage ledger implementation from
`claudeui/packages/timeline` while that package version is unpublished. Both
Node and Bun plugin bundles must use this same migration and writer.

To regenerate, build that package with `pnpm --filter @ohmyc/timeline build`,
pack it, append the first 12 SHA-256 digits to the filename, update the plugin's
file dependency and run `bun install` followed by `bun run build`. Commit the
tarball, lockfile, package manifest and both bundled runtimes together. Replace
this pin with a published package version during release.
