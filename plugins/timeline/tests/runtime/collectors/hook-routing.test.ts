import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../../..')

describe('shared hook routing', () => {
  const temporary: string[] = []

  afterEach(() => {
    for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  function fixture() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'timeline route with spaces-'))
    temporary.push(root)
    mkdirSync(path.join(root, 'hooks/shared'), { recursive: true })
    mkdirSync(path.join(root, 'dist'), { recursive: true })
    copyFileSync(path.join(PLUGIN_ROOT, 'hooks/shared/ingest-stop.sh'), path.join(root, 'hooks/shared/ingest-stop.sh'))
    copyFileSync(path.join(PLUGIN_ROOT, 'dist/ingest.mjs'), path.join(root, 'dist/ingest.mjs'))

    for (const name of ['ingest-codex.sh', 'ingest-claude.sh']) {
      const target = path.join(root, 'hooks', name)
      writeFileSync(target, '#!/bin/sh\nprintf "%s\\n" "$0" > "$ROUTE_LOG"\nprintf "%s\\n" "$@" >> "$ROUTE_LOG"\ncat >> "$ROUTE_LOG"\n')
      chmodSync(target, 0o755)
    }
    const event = path.join(root, 'hooks/shared/ingest-event.sh')
    writeFileSync(event, '#!/bin/sh\nprintf "event\\n" > "$ROUTE_LOG"\nprintf "%s\\n" "$@" >> "$ROUTE_LOG"\ncat >> "$ROUTE_LOG"\n')
    chmodSync(event, 0o755)
    return root
  }

  const routes = [
    { env: { PLUGIN_ROOT: 'self' }, payload: { session_id: 'x' }, expected: 'ingest-codex.sh' },
    { env: { CLAUDE_PLUGIN_ROOT: 'self', CLAUDE_SESSION_ID: 'claude-1' }, payload: {}, expected: 'ingest-claude.sh' },
    { env: { GROK_SESSION_ID: 'g1', CLAUDE_PLUGIN_ROOT: 'self' }, payload: { sessionId: 'g1', hookEventName: 'stop' }, expected: 'event' },
    { env: { CURSOR_VERSION: 'fixture', CLAUDE_PLUGIN_ROOT: 'self' }, payload: { conversation_id: 'c1', generation_id: 't1', hook_event_name: 'stop' }, expected: 'event' },
  ]

  for (const route of routes) {
    it(`routes ${route.expected} with stdin preserved`, () => {
      const root = fixture()
      const log = path.join(root, 'route.log')
      const payload = JSON.stringify(route.payload)
      const env = Object.fromEntries(Object.entries(route.env).map(([key, value]) => [
        key,
        value === 'self' ? root : value,
      ]))

      const stdout = execFileSync('/bin/sh', [path.join(root, 'hooks/shared/ingest-stop.sh')], {
        env: { PATH: process.env.PATH, ROUTE_LOG: log, ...env },
        input: payload,
        encoding: 'utf8',
      })
      const collected = readFileSync(log, 'utf8')

      expect(stdout).toBe('')
      expect(collected).toContain(route.expected)
      expect(collected).toContain(payload)
      if (route.expected === 'ingest-claude.sh') expect(collected).toContain('claude-1')
    })
  }

  it('agent wrappers forward stdin and arguments to the shared entrypoint', () => {
    const root = fixture()
    const log = path.join(root, 'route.log')
    for (const agent of ['cursor', 'grok']) {
      mkdirSync(path.join(root, 'hooks', agent), { recursive: true })
      copyFileSync(path.join(PLUGIN_ROOT, `hooks/${agent}/ingest.sh`), path.join(root, `hooks/${agent}/ingest.sh`))
      chmodSync(path.join(root, `hooks/${agent}/ingest.sh`), 0o755)
      execFileSync('/bin/sh', [path.join(root, `hooks/${agent}/ingest.sh`), agent], {
        env: { PATH: process.env.PATH, ROUTE_LOG: log },
        input: agent,
      })
      expect(readFileSync(log, 'utf8')).toBe(`event\n${agent}\n${agent}`)
    }
  })

  it('the native wrapper absorbs collector failures', () => {
    const result = spawnSync('/bin/sh', [path.join(PLUGIN_ROOT, 'hooks/shared/ingest-event.sh')], {
      input: 'invalid json',
      encoding: 'utf8',
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('collection failed; inspect pending events')
  })
})
