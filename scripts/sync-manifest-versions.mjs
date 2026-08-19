// Propagates the package version into the agent manifests.
//
// changesets only bumps plugins/timeline/package.json. The three manifests below
// are hand-maintained, so they drifted: package.json reached 1.0.6 while every
// manifest still said 1.0.5, which is the version users saw when installing.
// `ci:version` runs this straight after the bump, and a test asserts the four
// agree so a manual edit cannot re-open the gap.
//
//   bun run scripts/sync-manifest-versions.mjs            # write
//   bun run scripts/sync-manifest-versions.mjs --check    # verify only
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packagePath = path.join(repoRoot, 'plugins/timeline/package.json')

/**
 * Every manifest carrying a copy of the version, and how to read/write it.
 * `keep build metadata` matters for Codex: its manifest version is
 * `1.0.6+codex.20260620130738`, and only the core is ours to set.
 */
const targets = [
  {
    file: '.claude-plugin/marketplace.json',
    read: doc => doc.plugins.find(p => p.name === 'timeline')?.version,
    write: (doc, version) => {
      doc.plugins.find(p => p.name === 'timeline').version = version
    },
  },
  {
    file: 'plugins/timeline/.claude-plugin/plugin.json',
    read: doc => doc.version,
    write: (doc, version) => {
      doc.version = version
    },
  },
  {
    file: 'plugins/timeline/.codex-plugin/plugin.json',
    read: doc => doc.version,
    write: (doc, version) => {
      const build = doc.version.includes('+') ? doc.version.slice(doc.version.indexOf('+')) : ''
      doc.version = `${version}${build}`
    },
  },
]

/** Strip semver build metadata so `1.0.6+codex.x` compares equal to `1.0.6`. */
function core(version) {
  return String(version ?? '').split('+')[0]
}

function readJson(file) {
  return JSON.parse(readFileSync(path.join(repoRoot, file), 'utf8'))
}

function writeJson(file, doc) {
  writeFileSync(path.join(repoRoot, file), `${JSON.stringify(doc, null, 2)}\n`)
}

const { version } = JSON.parse(readFileSync(packagePath, 'utf8'))
const checkOnly = process.argv.includes('--check')
const drifted = []

for (const target of targets) {
  const doc = readJson(target.file)
  if (core(target.read(doc)) === version) {
    continue
  }
  drifted.push(`${target.file}: ${target.read(doc)} (expected ${version})`)
  if (!checkOnly) {
    target.write(doc, version)
    writeJson(target.file, doc)
  }
}

if (drifted.length === 0) {
  console.log(`All manifests already at ${version}.`)
} else if (checkOnly) {
  console.error(`Manifest versions drifted from package.json (${version}):`)
  for (const line of drifted) {
    console.error(`  - ${line}`)
  }
  console.error('\nRun: bun run sync:versions')
  process.exit(1)
} else {
  console.log(`Synced ${drifted.length} manifest(s) to ${version}:`)
  for (const line of drifted) {
    console.log(`  - ${line}`)
  }
}
