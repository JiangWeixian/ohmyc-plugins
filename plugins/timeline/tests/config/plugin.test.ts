import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
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

    // `.agents` is deliberately absent: the marketplace manifests and the repo's
    // own skills live at the repo root, not inside the published plugin.
    expect(packageJson.files).toEqual(expect.arrayContaining([
      '.claude-plugin',
      '.codex-plugin',
      '.cursor-plugin',
      '.grok-plugin',
      'dist',
      'hooks',
    ]))
    expect(packageJson.files).not.toContain('.agents')
  })
})

describe('native Cursor and Grok plugin metadata', () => {
  const pluginRoot = path.resolve(import.meta.dirname, '../..')
  const repoRoot = path.resolve(pluginRoot, '../..')
  const packageVersion = (JSON.parse(
    readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'),
  ) as { version: string }).version

  it.each(['cursor', 'grok'])('ships native %s metadata and hook configuration', (host) => {
    const manifest = JSON.parse(readFileSync(
      path.join(pluginRoot, `.${host}-plugin/plugin.json`),
      'utf8',
    )) as { name: string; version: string; hooks: string }

    expect(manifest.name).toBe('timeline')
    expect(manifest.version).toBe(packageVersion)
    expect(manifest.hooks).toBe(`./hooks/${host}/hooks.json`)
    expect(existsSync(path.join(pluginRoot, `hooks/${host}/hooks.json`))).toBe(true)
  })

  it('uses the install root for every Cursor hook command', () => {
    const config = JSON.parse(readFileSync(
      path.join(pluginRoot, 'hooks/cursor/hooks.json'),
      'utf8',
    )) as { version: number; hooks: Record<string, Array<{ command: string; timeout: number }>> }

    expect(config.version).toBe(1)
    expect(Object.keys(config.hooks)).toEqual([
      'sessionStart',
      'beforeSubmitPrompt',
      'postToolUse',
      'postToolUseFailure',
      'afterAgentResponse',
      'stop',
      'sessionEnd',
    ])
    for (const registrations of Object.values(config.hooks)) {
      expect(registrations).toEqual([{
        command: '\"${CURSOR_PLUGIN_ROOT}/hooks/cursor/ingest.sh\"',
        timeout: 3,
      }])
    }
  })

  it('registers every Grok event understood by the collector', () => {
    const config = JSON.parse(readFileSync(
      path.join(pluginRoot, 'hooks/grok/hooks.json'),
      'utf8',
    )) as {
      hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }>>
    }

    expect(Object.keys(config.hooks)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PostToolUse',
      'PostToolUseFailure',
      'Stop',
      'StopFailure',
      'StopCancelled',
      'SubagentStart',
      'SubagentStop',
      'SessionEnd',
    ])
    for (const registrations of Object.values(config.hooks)) {
      expect(registrations).toEqual([{
        hooks: [{
          type: 'command',
          command: './ingest.sh',
          timeout: 3,
        }],
      }])
    }
  })

  it('publishes native marketplace entries from the plugin subdirectory', () => {
    const cursor = JSON.parse(readFileSync(
      path.join(repoRoot, '.cursor-plugin/marketplace.json'),
      'utf8',
    )) as { name: string; plugins: Array<{ name: string; source: string; version: string }> }
    const grok = JSON.parse(readFileSync(
      path.join(repoRoot, '.grok-plugin/marketplace.json'),
      'utf8',
    )) as {
      name: string
      plugins: Array<{ name: string; source: { type: string; path: string }; version: string }>
    }

    expect(cursor.name).toBe('ohmyc')
    expect(cursor.plugins[0]).toMatchObject({
      name: 'timeline',
      source: './plugins/timeline',
      version: packageVersion,
    })
    expect(grok.name).toBe('ohmyc')
    expect(grok.plugins[0]).toMatchObject({
      name: 'timeline',
      source: { type: 'local', path: './plugins/timeline' },
      version: packageVersion,
    })
  })
})

describe('Codex Git install contents', () => {
  it('keeps built runtime files available for Git-backed Codex installs', () => {
    const repoRoot = path.resolve(import.meta.dirname, '../..')
    const runtimeFiles = [
      'dist/ingest.mjs',
      'dist/index.js',
    ]

    for (const runtimeFile of runtimeFiles) {
      expect(existsSync(path.join(repoRoot, runtimeFile))).toBe(true)

      let isIgnored = false
      try {
        execFileSync('git', ['check-ignore', '-q', runtimeFile], {
          cwd: repoRoot,
          stdio: 'ignore',
        })
        isIgnored = true
      } catch {
        isIgnored = false
      }

      expect(isIgnored).toBe(false)
    }
  })
})

describe('manifest versions', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../../../..')

  /** Drop semver build metadata: `1.0.6+codex.x` is the same release as `1.0.6`. */
  const core = (version: string) => version.split('+')[0]

  // changesets only bumps package.json. These three copies are hand-maintained,
  // and they silently fell a version behind — users installing through either
  // marketplace saw the stale number. `bun run sync:versions` fixes drift;
  // this fails the build if someone edits one by hand instead.
  it('keeps every agent manifest on the package version', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(repoRoot, 'plugins/timeline/package.json'), 'utf8'),
    ) as { version: string }

    const marketplace = JSON.parse(
      readFileSync(path.join(repoRoot, '.claude-plugin/marketplace.json'), 'utf8'),
    ) as { plugins: Array<{ name: string, version: string }> }
    const claudePlugin = JSON.parse(
      readFileSync(path.join(repoRoot, 'plugins/timeline/.claude-plugin/plugin.json'), 'utf8'),
    ) as { version: string }
    const codexPlugin = JSON.parse(
      readFileSync(path.join(repoRoot, 'plugins/timeline/.codex-plugin/plugin.json'), 'utf8'),
    ) as { version: string }

    const nativeVersions = [
      '.cursor-plugin/marketplace.json',
      '.grok-plugin/marketplace.json',
    ].map(file => {
      const doc = JSON.parse(readFileSync(path.join(repoRoot, file), 'utf8')) as {
        plugins: Array<{ name: string; version: string }>
      }
      return doc.plugins.find(plugin => plugin.name === 'timeline')!.version
    })
    nativeVersions.push(...[
      'plugins/timeline/.cursor-plugin/plugin.json',
      'plugins/timeline/.grok-plugin/plugin.json',
    ].map(file => {
      const doc = JSON.parse(readFileSync(path.join(repoRoot, file), 'utf8')) as { version: string }
      return doc.version
    }))

    const entry = marketplace.plugins.find(plugin => plugin.name === 'timeline')
    expect(core(entry!.version)).toBe(pkg.version)
    expect(core(claudePlugin.version)).toBe(pkg.version)
    expect(core(codexPlugin.version)).toBe(pkg.version)
    for (const version of nativeVersions) {
      expect(core(version)).toBe(pkg.version)
    }
  })
})

describe('Codex marketplace entry', () => {
  // Both marketplace manifests live at the repo root; the plugin is two levels
  // down in plugins/timeline.
  const repoRoot = path.resolve(import.meta.dirname, '../../../..')

  it('points the timeline plugin entry at the plugin subdirectory', () => {
    const marketplacePath = path.join(repoRoot, '.agents/plugins/marketplace.json')
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
        path: './plugins/timeline',
      },
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
      },
      category: 'Productivity',
    })
  })

  // Regression guard. `path: "./"` used to be the committed value: Codex accepts
  // the marketplace, then enumerates zero plugins from it, so
  // `codex plugin add timeline@ohmyc` fails with "not found in marketplace" and
  // nothing upstream reports a problem. Verified against codex by installing the
  // same tree from a subdirectory (works) and from the root (does not).
  it('never points either marketplace at the repository root', () => {
    const codex = JSON.parse(
      readFileSync(path.join(repoRoot, '.agents/plugins/marketplace.json'), 'utf8'),
    ) as { plugins: Array<{ name: string, source: { path: string } }> }
    const claude = JSON.parse(
      readFileSync(path.join(repoRoot, '.claude-plugin/marketplace.json'), 'utf8'),
    ) as { plugins: Array<{ name: string, source: string }> }

    const rootish = new Set(['./', '.', ''])
    for (const plugin of codex.plugins) {
      expect(rootish.has(plugin.source.path)).toBe(false)
    }
    for (const plugin of claude.plugins) {
      expect(rootish.has(plugin.source)).toBe(false)
    }
  })
})

describe('hook configuration compatibility', () => {
  it('routes the default plugin Stop hook through the shared dispatcher', () => {
    const hooksJson = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '../../hooks/hooks.json'), 'utf8'),
    ) as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } }

    const command = hooksJson.hooks.Stop[0].hooks[0].command
    expect(command).toContain('/hooks/shared/ingest-stop.sh')
    expect(command).toContain('PLUGIN_ROOT')
    expect(command).toContain('CLAUDE_PLUGIN_ROOT')
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

describe('OpenCode lifecycle compatibility', () => {
  it('requires a plugin host with disposal finalization support', () => {
    const packageJson = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8'),
    ) as { peerDependencies: Record<string, string>; devDependencies: Record<string, string> }

    expect(packageJson.peerDependencies['@opencode-ai/plugin']).toBe('^1.16.0')
    expect(packageJson.devDependencies['@opencode-ai/plugin']).toBe('^1.16.0')
  })
})
