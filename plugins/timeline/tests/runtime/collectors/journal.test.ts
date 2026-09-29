import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { eventKey, sessionKey } from '../../../src/shared/collectors/identity'
import { CorruptCollectorStateError, createJournal } from '../../../src/shared/collectors/journal'
import { withSessionLock } from '../../../src/shared/collectors/lock'
import type { CollectorEvent } from '../../../src/shared/collectors/types'

const homes: string[] = []
const home = () => {
  const value = mkdtempSync(path.join(os.tmpdir(), 'timeline-journal-'))
  homes.push(value)
  return value
}
const event = (id: string, nativeSessionId = 'c1'): CollectorEvent => {
  const semantic = {
    version: 1 as const,
    agent: 'cursor' as const,
    nativeSessionId,
    tool: { id, name: 'Read' },
  }
  return { ...semantic, eventId: eventKey(semantic), observedAt: 1000 }
}
const directory = (root: string, key: string) => path.join(
  root,
  'collectors',
  createHash('sha256').update(key).digest('hex'),
)

afterEach(() => {
  homes.splice(0).forEach(value => rmSync(value, { recursive: true, force: true }))
  vi.restoreAllMocks()
})

describe('collector journal', () => {
  it('keeps the first event capture and ignores temporary files', async () => {
    const root = home()
    const journal = createJournal(root)
    const first = event('same')
    const later = { ...first, observedAt: 9000 }
    await journal.enqueue(first)
    await journal.enqueue(later)
    writeFileSync(path.join(directory(root, 'cursor:c1'), 'outbox', '.tmp-half-write'), '{')

    expect(await journal.pending('cursor:c1')).toEqual([first])
    expect(JSON.parse(readFileSync(path.join(directory(root, 'cursor:c1'), 'identity.json'), 'utf8')))
      .toEqual({ key: 'cursor:c1' })
  })

  it('persists state atomically and acknowledges selected events', async () => {
    const root = home()
    const journal = createJournal(root)
    const first = event('one')
    const second = event('two')
    await journal.enqueue(first)
    await journal.enqueue(second)
    const state = { version: 1 as const, agent: 'cursor' as const, nativeSessionId: 'c1', events: { [first.eventId]: first } }
    await journal.save('cursor:c1', state)
    await journal.ack('cursor:c1', [first.eventId])

    expect(await journal.load('cursor:c1')).toEqual(state)
    expect(await journal.pending('cursor:c1')).toEqual([second])
    expect(await journal.keys()).toEqual(['cursor:c1'])
  })

  it('quarantines corrupt state and never silently rebuilds over it', async () => {
    const root = home()
    const journal = createJournal(root)
    await journal.enqueue(event('one'))
    writeFileSync(path.join(directory(root, 'cursor:c1'), 'state.json'), '{')

    await expect(journal.load('cursor:c1')).rejects.toBeInstanceOf(CorruptCollectorStateError)
    expect(existsSync(path.join(directory(root, 'cursor:c1'), 'state.json'))).toBe(false)
    await expect(journal.load('cursor:c1')).rejects.toBeInstanceOf(CorruptCollectorStateError)
  })

  it('does not steal a live lock after the wait budget', async () => {
    const root = home()
    const key = sessionKey('cursor', 'c1')
    let release!: () => void
    const held = withSessionLock(root, key, async () => new Promise<void>(resolve => { release = resolve }))
    while (!release) await new Promise(resolve => setTimeout(resolve, 1))
    const started = Date.now()
    const contender = await withSessionLock(root, key, async () => 'stolen')
    expect(contender).toEqual({ acquired: false })
    expect(Date.now() - started).toBeGreaterThanOrEqual(280)
    release()
    await held
  })

  it('reclaims only a lock whose PID is dead', async () => {
    const root = home()
    const key = sessionKey('cursor', 'c1')
    const lock = path.join(directory(root, key), 'lock')
    await withSessionLock(root, key, async () => undefined)
    writeFileSync(lock, JSON.stringify({ pid: 2_147_483_647, token: 'dead-token' }))
    expect(await withSessionLock(root, key, async () => 42)).toEqual({ acquired: true, value: 42 })
  })

  it('serializes concurrent dead-lock reapers without overlapping owners', async () => {
    const root = home()
    const key = sessionKey('cursor', 'c1')
    const lock = path.join(directory(root, key), 'lock')
    await withSessionLock(root, key, async () => undefined)
    writeFileSync(lock, JSON.stringify({ pid: 2_147_483_647, token: 'dead-token' }))
    let active = 0
    let maximum = 0
    const action = async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 40))
      active -= 1
    }
    const results = await Promise.all([
      withSessionLock(root, key, action),
      withSessionLock(root, key, action),
    ])
    expect(results.every(result => result.acquired)).toBe(true)
    expect(maximum).toBe(1)
  })

  it('preserves malformed locks for explicit repair', async () => {
    const root = home()
    const key = sessionKey('cursor', 'c1')
    const lock = path.join(directory(root, key), 'lock')
    await withSessionLock(root, key, async () => undefined)
    writeFileSync(lock, '')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await withSessionLock(root, key, async () => 42)).toEqual({ acquired: false })
    expect(existsSync(lock)).toBe(true)
  })
})

const run = promisify(execFile)
const lockWorker = path.resolve(import.meta.dirname, '../../fixtures/lock-worker.ts')

it('recovers a dead reclamation guard with competing process reapers', async () => {
  const root = home()
  const key = 'cursor:dead-reaper'
  await run('bun', [lockWorker, root, key, 'crash-reaper'])
  const results = await Promise.all(Array.from({ length: 3 }, async () => {
    const { stdout } = await run('bun', [lockWorker, root, key, 'acquire'], {
      env: { ...process.env, TIMELINE_LOCK_WAIT_MS: '2000' },
    })
    return JSON.parse(stdout)
  }))
  expect(results).toEqual(Array.from({ length: 3 }, () => ({ acquired: true, value: 'exclusive' })))
  expect(existsSync(path.join(directory(root, key), 'lock.reclaim'))).toBe(false)
  expect(await withSessionLock(root, key, async () => 42)).toEqual({ acquired: true, value: 42 })
})

it.each(['live', 'malformed', 'eperm'])('preserves a %s reclamation guard', async kind => {
  const root = home()
  const key = 'cursor:guard'
  await withSessionLock(root, key, async () => undefined)
  const lock = path.join(directory(root, key), 'lock')
  writeFileSync(lock, JSON.stringify({ pid: 2_147_483_647, token: 'dead' }))
  const guard = kind === 'malformed' ? '{' : JSON.stringify({ pid: process.pid, token: 'preserved' })
  writeFileSync(`${lock}.reclaim`, guard)
  if (kind === 'eperm') {
    const kill = process.kill.bind(process)
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === process.pid) throw Object.assign(new Error('denied'), { code: 'EPERM' })
      return kill(pid, signal)
    })
  }
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  expect(await withSessionLock(root, key, async () => 'stolen')).toEqual({ acquired: false })
  expect(readFileSync(`${lock}.reclaim`, 'utf8')).toBe(guard)
})

it('propagates an action EEXIST without retrying the action', async () => {
  const root = home()
  let calls = 0
  await expect(withSessionLock(root, 'cursor:action', async () => {
    calls++
    throw Object.assign(new Error('action exists'), { code: 'EEXIST' })
  })).rejects.toThrow('action exists')
  expect(calls).toBe(1)
})
