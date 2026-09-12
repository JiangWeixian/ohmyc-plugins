import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { closeDatabase, getSession, openDatabase } from '@ohmyc/timeline'
import type { ParsedSessionData } from '@ohmyc/timeline/schema'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { eventKey } from '../../../src/shared/collectors/identity'
import { createJournal } from '../../../src/shared/collectors/journal'
import { ingestEvents, replayPending } from '../../../src/shared/collectors/ingest-event'
import type { CollectorEvent } from '../../../src/shared/collectors/types'

const run = promisify(execFile)
const homes: string[] = []
const makeHome = () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'timeline-outbox-'))
  homes.push(home)
  return home
}
const semanticEvent = (id: string, extra: Partial<CollectorEvent> = {}): CollectorEvent => {
  const semantic = {
    version: 1 as const,
    agent: 'cursor' as const,
    nativeSessionId: 'c1',
    turnId: 't1',
    confirmsTurn: true,
    tool: { id, name: 'Read' },
    ...extra,
  }
  const { observedAt = 1000 } = semantic
  const identity = { ...semantic }
  delete (identity as Partial<CollectorEvent>).observedAt
  return { ...identity, observedAt, eventId: eventKey(identity as Omit<CollectorEvent, 'eventId' | 'observedAt'>) }
}

afterEach(() => {
  homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true }))
  vi.restoreAllMocks()
})

describe('collector ingestion', () => {
  it('keeps failed writes durable for replay', async () => {
    const home = makeHome()
    const semantic = {
      version: 1 as const,
      agent: 'cursor' as const,
      nativeSessionId: 'c1',
      turnId: 't1',
      prompt: 'hello',
      confirmsTurn: true,
    }
    const events: CollectorEvent[] = [{
      ...semantic,
      eventId: eventKey(semantic),
      observedAt: 1000,
    }]
    const deps = {
      home,
      hydrate: async () => [],
      write: () => { throw new Error('busy') },
    }
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await ingestEvents(events, deps)).toBe('queued')
    const written: ParsedSessionData[] = []
    expect(await replayPending({
      ...deps,
      write: data => { written.push(data) },
    })).toEqual({ written: 1, queued: 0 })
    expect(written[0]).toMatchObject({ sessionId: 'cursor:c1', turns: 1 })
  })

  it('retries only busy SQLite writes', async () => {
    const home = makeHome()
    let attempts = 0
    const write = () => {
      attempts += 1
      if (attempts < 4) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
    }
    expect(await ingestEvents([semanticEvent('busy')], { home, hydrate: async () => [], write })).toBe('written')
    expect(attempts).toBe(4)

    const secondHome = makeHome()
    attempts = 0
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await ingestEvents([semanticEvent('fatal')], {
      home: secondHome,
      hydrate: async () => [],
      write: () => { attempts += 1; throw new Error('invalid schema') },
    })).toBe('queued')
    expect(attempts).toBe(1)
  })

  it('hydrates with prior state plus pending and retains failed requests', async () => {
    const home = makeHome()
    const first = semanticEvent('first', { needsHydration: true })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await ingestEvents([first], {
      home,
      hydrate: async () => { throw new Error('transcript unavailable') },
      write: () => undefined,
    })).toBe('queued')
    let context: readonly CollectorEvent[] = []
    expect(await replayPending({
      home,
      hydrate: async events => {
        context = events
        return [semanticEvent('first-complete', {
          needsHydration: false,
          resolvesEventId: first.eventId,
        })]
      },
      write: () => undefined,
    })).toEqual({ written: 1, queued: 0 })
    expect(context).toContainEqual(first)
  })

  it('retains hydration requests when a partial transcript yields useful facts', async () => {
    const home = makeHome()
    const request = semanticEvent('request', { needsHydration: true })
    expect(await ingestEvents([request], {
      home,
      hydrate: async () => [semanticEvent('partial', { prompt: 'visible prefix' })],
      write: () => undefined,
    })).toBe('queued')
    expect(await createJournal(home).pending('cursor:c1')).toContainEqual(request)
  })

  it('acknowledges only the exact lifecycle hydration request', async () => {
    const home = makeHome()
    const first = semanticEvent('unused-first', {
      turnId: undefined,
      confirmsTurn: undefined,
      tool: undefined,
      needsHydration: true,
      transcriptPath: '/tmp/first.jsonl',
    })
    const second = semanticEvent('unused-second', {
      turnId: undefined,
      confirmsTurn: undefined,
      tool: undefined,
      needsHydration: true,
      transcriptPath: '/tmp/second.jsonl',
    })
    const completion = semanticEvent('completion', {
      turnId: undefined,
      tool: undefined,
      needsHydration: false,
      resolvesEventId: first.eventId,
    })
    expect(await ingestEvents([first, second], {
      home,
      hydrate: async () => [completion],
      write: () => undefined,
    })).toBe('queued')
    expect(await createJournal(home).pending('cursor:c1')).toEqual([second])
  })

  it('returns queued when hydration exceeds the hook soft budget', async () => {
    const home = makeHome()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const started = Date.now()
    expect(await ingestEvents([semanticEvent('slow')], {
      home,
      hydrate: async () => new Promise(() => undefined),
      write: () => undefined,
    })).toBe('queued')
    expect(Date.now() - started).toBeLessThan(1200)
    expect(await createJournal(home).pending('cursor:c1')).toHaveLength(1)
  }, 2000)

  it('durably forwards resolved child facts before acknowledging the child', async () => {
    const home = makeHome()
    const unresolved = semanticEvent('child', {
      nativeSessionId: 'child',
      unresolvedParent: true,
      confirmsTurn: undefined,
    })
    const rootSemantic = {
      version: 1 as const,
      agent: 'cursor' as const,
      nativeSessionId: 'root',
      sourceSessionId: 'child',
      turnId: 't1',
      tool: { id: 'child', name: 'Read' },
      resolvesEventId: unresolved.eventId,
    }
    const rootEvent: CollectorEvent = {
      ...rootSemantic,
      eventId: eventKey(rootSemantic),
      observedAt: 1100,
    }
    const written: ParsedSessionData[] = []
    expect(await ingestEvents([unresolved], {
      home,
      hydrate: async events => events.some(event => event.unresolvedParent) ? [rootEvent] : [],
      write: data => { written.push(data) },
    })).toBe('written')
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ sessionId: 'cursor:root', tools: [{ toolName: 'Read', callCount: 1 }] })
    expect(await createJournal(home).pending('cursor:child')).toEqual([])
  })

  it('retires an unresolved fact when matching local root evidence resolves it', async () => {
    const home = makeHome()
    const unresolved = semanticEvent('local-child', { unresolvedParent: true })
    const resolved = semanticEvent('local-child', {
      unresolvedParent: false,
      rootSession: true,
      resolvesEventId: unresolved.eventId,
    })
    const written: ParsedSessionData[] = []
    expect(await ingestEvents([unresolved], {
      home,
      hydrate: async () => [resolved],
      write: data => { written.push(data) },
    })).toBe('written')
    expect(written[0]).toMatchObject({ sessionId: 'cursor:c1', tools: [{ toolName: 'Read', callCount: 1 }] })
    expect(await createJournal(home).pending('cursor:c1')).toEqual([])
  })

  it('retains a dual obligation after partial forwarding until exact hydration completion', async () => {
    const home = makeHome()
    const request = semanticEvent('dual', {
      nativeSessionId: 'child',
      unresolvedParent: true,
      needsHydration: true,
    })
    let complete = false
    const hydrate = async (events: readonly CollectorEvent[]) => {
      if (!events.some(event => event.eventId === request.eventId)) return []
      return [semanticEvent('dual', {
        nativeSessionId: 'root',
        sourceSessionId: 'child',
        needsHydration: complete ? false : true,
        resolvesEventId: request.eventId,
      })]
    }
    expect(await ingestEvents([request], { home, hydrate, write: () => undefined })).toBe('queued')
    expect(await createJournal(home).pending('cursor:child')).toEqual([request])
    complete = true
    expect(await replayPending({ home, hydrate, write: () => undefined }))
      .toEqual({ written: 1, queued: 0 })
    expect(await createJournal(home).pending('cursor:child')).toEqual([])
  })

  it('replays a real writer after process exit and converges concurrent workers', async () => {
    const home = makeHome()
    const databasePath = path.join(home, 'timeline.db')
    const worker = path.resolve('tests/fixtures/collector-worker.ts')
    const bundledWorker = path.join(home, 'collector-worker.mjs')
    const firstPath = path.join(home, 'first.json')
    const secondPath = path.join(home, 'second.json')
    writeFileSync(firstPath, JSON.stringify([semanticEvent('one', { prompt: 'hello' })]))
    writeFileSync(secondPath, JSON.stringify([semanticEvent('two', { observedAt: 1100 })]))
    await run('bun', ['build', worker, '--target', 'node', '--outfile', bundledWorker])
    const initialized = openDatabase({ dbPath: databasePath })
    closeDatabase(initialized)

    await expect(run(process.execPath, [bundledWorker, home, firstPath, databasePath, 'exit-after-write']))
      .rejects.toMatchObject({ code: 73 })
    await run(process.execPath, [bundledWorker, home, firstPath, databasePath, 'replay'])
    await expect(run(process.execPath, [bundledWorker, home, secondPath, databasePath, 'exit-after-save']))
      .rejects.toMatchObject({ code: 74 })
    expect(await createJournal(home).pending('cursor:c1')).toContainEqual(semanticEvent('two', { observedAt: 1100 }))
    const afterSaveDatabase = openDatabase({ dbPath: databasePath })
    try {
      expect(getSession(afterSaveDatabase, 'cursor:c1')?.tools)
        .toEqual([{ session_id: 'cursor:c1', tool_name: 'Read', call_count: 2 }])
    } finally {
      closeDatabase(afterSaveDatabase)
    }
    await run(process.execPath, [bundledWorker, home, firstPath, databasePath, 'replay'])
    await Promise.all([
      run(process.execPath, [bundledWorker, home, firstPath, databasePath]),
      run(process.execPath, [bundledWorker, home, secondPath, databasePath]),
    ])
    await run(process.execPath, [bundledWorker, home, firstPath, databasePath, 'replay'])
    await run(process.execPath, [bundledWorker, home, firstPath, databasePath, 'replay'])

    const database = openDatabase({ dbPath: databasePath })
    try {
      const session = getSession(database, 'cursor:c1')
      expect(session).toMatchObject({ session_id: 'cursor:c1', turns: 1 })
      expect(session?.tools).toEqual([{ session_id: 'cursor:c1', tool_name: 'Read', call_count: 2 }])
    } finally {
      closeDatabase(database)
    }
  }, 15_000)

  it('does not overwrite a complete database snapshot after state corruption', async () => {
    const home = makeHome()
    const first = semanticEvent('one', { prompt: 'hello' })
    const written: ParsedSessionData[] = []
    await ingestEvents([first], { home, hydrate: async () => [], write: data => { written.push(data) } })
    const directory = path.join(home, 'collectors', createHash('sha256').update('cursor:c1').digest('hex'))
    writeFileSync(path.join(directory, 'state.json'), '{')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await ingestEvents([semanticEvent('two')], {
      home,
      hydrate: async () => [],
      write: data => { written.push(data) },
    })).toBe('queued')
    expect(written).toHaveLength(1)
  })
})
