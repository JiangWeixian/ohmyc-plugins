import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getSession, openDatabase } from '@ohmyc/timeline'
import { afterEach, describe, expect, it } from 'vitest'
import { createJournal } from '../../../src/shared/collectors/journal'

const plugin = path.resolve(import.meta.dirname, '../../..')
const repo = path.resolve(plugin, '../..')
const current = path.join(plugin, 'dist/ingest.mjs')
const homes: string[] = []
afterEach(() => { homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })) })

function setup(agent: 'kimi' | 'zcode') {
  const home = mkdtempSync(path.join(os.tmpdir(), 'timeline-switch-'))
  homes.push(home)
  const old = path.join(home, 'old.mjs')
  const previous = path.join(home, 'previous.mjs')
  for (const [sha, file] of [['1435acc6323e341bdc61033879425d154f284571', old], ['0b4ecaf20d0bd7521a952173130b977e776aa9b3', previous]]) {
    writeFileSync(file, execFileSync('git', ['show', `${sha}:plugins/timeline/dist/ingest.mjs`], { cwd: repo }))
  }
  const key = `${agent}:switch-session`
  const legacy = path.join(home, 'collectors', createHash('sha256').update(key).digest('hex'))
  const env = { ...process.env, OHMYC_HOME: home, KIMI_CODE_HOME: path.join(home, 'kimi') }
  const run = (cli: string, args: string[], payload?: unknown) => execFileSync(process.execPath, ['--no-warnings', cli, ...args], {
    env, input: payload === undefined ? undefined : JSON.stringify(payload), stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8',
  })
  const turn = (cli: string, index: number) => {
    if (agent === 'kimi') {
      run(cli, ['--hook', agent], { client_type: 'kimi_code_cli', session_id: 'switch-session', hook_event_name: 'TurnStarted', turn_id: index, origin_kind: 'user', prompt: `prompt ${index}` })
      if (index === 0) run(cli, ['--hook', agent], { client_type: 'kimi_code_cli', session_id: 'switch-session', hook_event_name: 'PostToolUse', tool_call_id: 'call1', tool_name: 'Read', tool_input: { path: '/tmp/demo/skills/check/SKILL.md' }, tool_output: 'loaded' })
    } else {
      const base = { sessionId: 'switch-session', session_id: 'switch-session', cwd: '/tmp/demo', turnId: `turn${index}`, timestamp: `2026-10-12T01:00:0${index}Z` }
      run(cli, ['--hook', agent], { ...base, hookEventName: 'UserPromptSubmit', prompt: `prompt ${index}` })
      if (index === 0) run(cli, ['--hook', agent], { ...base, hookEventName: 'PostToolUse', toolCallId: 'call1', toolName: 'Read', toolInput: { file_path: '/tmp/demo/skills/check/SKILL.md' }, toolResponse: { filePath: '/tmp/demo/skills/check/SKILL.md' } })
      run(cli, ['--hook', agent], { ...base, hookEventName: 'Stop' })
    }
  }
  const pendingTurn = (cli: string) => {
    renameSync(path.join(home, 'timeline.db'), path.join(home, 'saved.db'))
    mkdirSync(path.join(home, 'timeline.db'))
    turn(cli, 1)
    rmSync(path.join(home, 'timeline.db'), { recursive: true })
    renameSync(path.join(home, 'saved.db'), path.join(home, 'timeline.db'))
  }
  const snapshot = () => {
    const db = openDatabase({ dbPath: path.join(home, 'timeline.db') })
    try { return getSession(db, key) } finally { closeDatabase(db) }
  }
  return { home, old, previous, legacy, key, run, turn, pendingTurn, snapshot }
}

describe.each(['kimi', 'zcode'] as const)('%s plugin switching', agent => {
  it('keeps pending writes safe through repeated downgrade and upgrade', async () => {
    const f = setup(agent)
    f.turn(current, 0)
    f.pendingTurn(current)
    f.run(f.old, ['--replay-pending'])
    expect(f.snapshot()?.turns).toBe(1)
    f.run(current, ['--replay-pending'])
    expect(f.snapshot()?.turns).toBe(2)
    expect(f.snapshot()?.tools).toEqual([{ session_id: f.key, tool_name: 'Read', call_count: 1 }])
    f.run(f.old, ['--replay-pending'])
    f.run(current, ['--replay-pending'])
    expect(f.snapshot()?.turns).toBe(2)
    expect(await createJournal(f.home).pending(f.key)).toEqual([])
  }, 20000)

  it('keeps migrated events discoverable when the database is still unavailable', async () => {
    const f = setup(agent)
    f.turn(f.previous, 0)
    f.pendingTurn(f.previous)
    f.run(f.old, ['--replay-pending'])
    renameSync(path.join(f.home, 'timeline.db'), path.join(f.home, 'saved.db'))
    mkdirSync(path.join(f.home, 'timeline.db'))
    f.run(current, ['--replay-pending'])
    expect(await createJournal(f.home).keys()).toContain(f.key)
    f.run(f.old, ['--replay-pending'])
    rmSync(path.join(f.home, 'timeline.db'), { recursive: true })
    renameSync(path.join(f.home, 'saved.db'), path.join(f.home, 'timeline.db'))
    f.run(current, ['--replay-pending'])
    expect(f.snapshot()?.turns).toBe(2)
  }, 20000)

  it.each(['malformed', 'mismatched', 'multiple'])('preserves %s legacy state instead of rebuilding over it', async kind => {
    const f = setup(agent)
    f.turn(f.previous, 0)
    f.pendingTurn(f.previous)
    f.run(f.old, ['--replay-pending'])
    const file = path.join(f.legacy, readdirSync(f.legacy).find(name => name.endsWith('.corrupt'))!)
    const original = readFileSync(file, 'utf8')
    const raw = kind === 'malformed' ? '{' : kind === 'mismatched' ? JSON.stringify({ ...JSON.parse(original), nativeSessionId: 'other' }) : original
    writeFileSync(file, raw)
    if (kind === 'multiple') writeFileSync(path.join(f.legacy, 'state.json.other.corrupt'), raw)
    f.run(current, ['--replay-pending'])
    expect(f.snapshot()?.turns).toBe(1)
    expect(readFileSync(file, 'utf8')).toBe(raw)
    expect(readdirSync(path.join(f.legacy, 'outbox'))).not.toHaveLength(0)
  }, 20000)

  it.each([false, true])('migrates legacy pending data with an old-version corruption marker=%s', async corrupt => {
    const f = setup(agent)
    f.turn(f.previous, 0)
    f.pendingTurn(f.previous)
    const prior = readFileSync(path.join(f.legacy, 'state.json'), 'utf8')
    if (corrupt) {
      f.run(f.old, ['--replay-pending'])
      expect(existsSync(path.join(f.legacy, 'state.json'))).toBe(false)
    }
    f.run(current, ['--replay-pending'])
    expect(f.snapshot()?.turns).toBe(2)
    expect(f.snapshot()?.tools).toEqual([{ session_id: f.key, tool_name: 'Read', call_count: 1 }])
    expect(existsSync(path.join(f.legacy, 'identity.json'))).toBe(false)
    expect(await createJournal(f.home).pending(f.key)).toEqual([])
    f.run(f.old, ['--replay-pending'])
    f.turn(current, 2)
    expect(f.snapshot()?.turns).toBe(3)
    expect(prior).toContain('call1')
    expect(readdirSync(path.join(f.home, 'collector-backups', agent))).not.toHaveLength(0)
  }, 20000)
})
