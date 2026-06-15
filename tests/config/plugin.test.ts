import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  describe,
  expect,
  it,
} from 'vitest'

describe('Codex plugin manifest', () => {
  it('uses the validation-safe Codex manifest shape', () => {
    const manifestPath = path.resolve(import.meta.dirname, '../../.codex-plugin/plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    const interfaceMeta = manifest.interface as Record<string, unknown>

    expect(manifest.name).toBe('timeline')
    expect(manifest.homepage).toBe('https://github.com/JiangWeixian/ohmyc-plugins')
    expect(manifest.repository).toBe('https://github.com/JiangWeixian/ohmyc-plugins')
    expect(manifest).not.toHaveProperty('hooks')
    expect(interfaceMeta.defaultPrompt).toEqual([
      'Show my recent Claude Code, OpenCode, and Codex session activity.',
    ])
  })
})

describe('npm package contents', () => {
  it('publishes agent plugin manifests with the runtime files', () => {
    const packageJson = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8'),
    ) as { files: string[] }

    expect(packageJson.files).toEqual(expect.arrayContaining([
      '.agents',
      '.claude-plugin',
      '.codex-plugin',
      'dist',
      'hooks',
    ]))
  })
})

describe('Codex marketplace entry', () => {
  it('points the timeline plugin entry at the project root', () => {
    const marketplacePath = path.resolve(import.meta.dirname, '../../.agents/plugins/marketplace.json')
    const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8')) as {
      name: string
      plugins: Array<{
        name: string
        source: { source: string; path: string }
        policy: { installation: string; authentication: string }
        category: string
      }>
    }

    const entry = marketplace.plugins.find(plugin => plugin.name === 'timeline')
    expect(marketplace.name).toBe('ohmyc')
    expect(entry).toEqual({
      name: 'timeline',
      source: {
        source: 'local',
        path: './',
      },
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
      },
      category: 'Productivity',
    })
  })
})

describe('hook configuration compatibility', () => {
  it('routes the default plugin Stop hook to the Codex and Claude entrypoints', () => {
    const hooksJson = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '../../hooks/hooks.json'), 'utf8'),
    ) as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } }

    const command = hooksJson.hooks.Stop[0].hooks[0].command
    expect(command).toContain('$' + '{PLUGIN_ROOT}/hooks/ingest-codex.sh')
    expect(command).toContain('$' + '{CLAUDE_PLUGIN_ROOT}/hooks/ingest-claude.sh')
    expect(command).toContain('$CLAUDE_SESSION_ID')
  })
})

describe('ingest CLI package boundaries', () => {
  it('uses @ohmyc/timeline public APIs and does not import the removed native sqlite driver', () => {
    const source = readFileSync(path.resolve(import.meta.dirname, '../../src/ingest.ts'), 'utf8')
    const removedNativeDriver = 'better' + '-sqlite3'

    expect(source).toContain('from \'@ohmyc/timeline\'')
    expect(source).toContain('from \'@ohmyc/timeline/ingest\'')
    expect(source).toContain('from \'@ohmyc/timeline/writer\'')
    expect(source).not.toContain('@ohmyc/timeline/migrate')
    expect(source).not.toContain('../../../packages/timeline/src')
    expect(source).not.toContain(removedNativeDriver)
    expect(source).not.toContain('node:' + '$' + '{\'sqlite\'}')
  })
})

describe('OpenCode bundle boundaries', () => {
  it('bundles the shared timeline runtime instead of relying on host resolution', () => {
    const packageJson = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8'),
    ) as { scripts: { build: string } }

    expect(packageJson.scripts.build).toContain('--external @opencode-ai/plugin')
    expect(packageJson.scripts.build).not.toContain('--external @ohmyc/timeline')
  })
})
