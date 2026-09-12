import { eventKey, sessionKey } from './identity'
import { CorruptCollectorStateError, createJournal } from './journal'
import { withSessionLock } from './lock'
import { reduceEvents, toSnapshot } from './reduce'
import type { CollectorEvent, Hydrate, WriteSnapshot } from './types'

type Dependencies = { home: string; hydrate: Hydrate; write: WriteSnapshot }
type ProcessResult = { status: 'written' | 'queued' | 'ignored'; forwarded: string[] }
const SOFT_BUDGET_MS = 1000

function keyOf(event: CollectorEvent): string {
  return sessionKey(event.agent, event.nativeSessionId)
}

function sqliteBusy(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown }
  return value.code === 'SQLITE_BUSY' || value.code === 'SQLITE_LOCKED'
    || (typeof value.message === 'string' && /database is (?:busy|locked)/i.test(value.message))
}

async function writeWithRetry(write: WriteSnapshot, snapshot: Parameters<WriteSnapshot>[0]): Promise<void> {
  const waits = [25, 75, 150]
  for (let attempt = 0; ; attempt += 1) {
    try {
      write(snapshot)
      return
    } catch (error) {
      if (!sqliteBusy(error) || attempt === waits.length) throw error
      await new Promise(resolve => setTimeout(resolve, waits[attempt]))
    }
  }
}

async function hydrateWithinBudget(
  hydrate: Hydrate,
  events: readonly CollectorEvent[],
  deadline: number,
): Promise<readonly CollectorEvent[]> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error('collector soft budget exhausted')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      hydrate(events),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('collector hydration exceeded soft budget')), remaining)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function forwardedEvent(event: CollectorEvent): CollectorEvent {
  const { eventId: _eventId, observedAt, ...semantic } = event
  return { ...semantic, observedAt, eventId: eventKey(semantic) }
}

function resolves(original: CollectorEvent, candidate: CollectorEvent): boolean {
  if (candidate.resolvesEventId !== original.eventId || candidate.agent !== original.agent) return false
  return candidate.nativeSessionId === original.nativeSessionId
    || candidate.sourceSessionId === original.nativeSessionId
}

async function processKey(key: string, deps: Dependencies, deadline: number): Promise<ProcessResult> {
  if (Date.now() >= deadline) return { status: 'queued', forwarded: [] }
  const journal = createJournal(deps.home)
  const locked = await withSessionLock(deps.home, key, async (): Promise<ProcessResult> => {
    const pending = await journal.pending(key)
    if (pending.length === 0) return { status: 'ignored', forwarded: [] }

    let previous
    try {
      previous = await journal.load(key)
    } catch (error) {
      if (error instanceof CorruptCollectorStateError) console.warn(`[timeline] ${error.message}`)
      else console.warn(`[timeline] failed to load collector state: ${String(error)}`)
      return { status: 'queued', forwarded: [] }
    }

    let hydrated: readonly CollectorEvent[]
    try {
      hydrated = await hydrateWithinBudget(deps.hydrate, [
        ...Object.values(previous?.events ?? {}),
        ...pending,
      ], deadline)
    } catch (error) {
      console.warn(`[timeline] collector hydration failed: ${String(error)}`)
      return { status: 'queued', forwarded: [] }
    }

    const local = hydrated.filter(event => keyOf(event) === key)
    const crossSession = hydrated.filter(event => keyOf(event) !== key).map(forwardedEvent)
    const forwarded = new Set<string>()
    try {
      for (const event of crossSession) {
        await journal.enqueue(event)
        forwarded.add(keyOf(event))
      }
    } catch (error) {
      console.warn(`[timeline] collector forwarding failed: ${String(error)}`)
      return { status: 'queued', forwarded: [] }
    }

    const unresolved = pending.filter(event => event.unresolvedParent)
    const unresolvedAck = unresolved
      .filter(event => crossSession.some(forwarded => resolves(event, forwarded))
        || local.some(resolved => !resolved.unresolvedParent
          && resolves(event, resolved)))
      .map(event => event.eventId)
    const hydrationAck = pending
      .filter(event => event.needsHydration && !event.resolvesEventId
        && [...local, ...crossSession].some(completed => completed.needsHydration === false
          && resolves(event, completed)))
      .map(event => event.eventId)
    const retained = new Set(pending
      .filter(event => (event.unresolvedParent && !unresolvedAck.includes(event.eventId))
        || (event.needsHydration && !event.resolvesEventId && !hydrationAck.includes(event.eventId)))
      .map(event => event.eventId))
    const reduciblePending = pending.filter(event => !event.unresolvedParent)
    if (!previous && reduciblePending.length === 0 && local.length === 0) {
      await journal.ack(key, pending.filter(event => !retained.has(event.eventId)).map(event => event.eventId))
      return {
        status: retained.size > 0 ? 'queued' : 'ignored',
        forwarded: [...forwarded],
      }
    }
    const state = reduceEvents(previous, [...reduciblePending, ...local])
    const snapshot = toSnapshot(state)
    try {
      if (snapshot) await writeWithRetry(deps.write, snapshot)
      await journal.save(key, state)
      await journal.ack(key, pending.filter(event => !retained.has(event.eventId)).map(event => event.eventId))
    } catch (error) {
      console.warn(`[timeline] collector snapshot queued: ${String(error)}`)
      return { status: 'queued', forwarded: [...forwarded] }
    }
    return {
      status: retained.size > 0 ? 'queued' : snapshot ? 'written' : 'ignored',
      forwarded: [...forwarded],
    }
  })
  return locked.acquired ? locked.value : { status: 'queued', forwarded: [] }
}

export async function ingestEvents(
  events: readonly CollectorEvent[],
  deps: Dependencies,
): Promise<'written' | 'queued' | 'ignored'> {
  if (events.length === 0) return 'ignored'
  const deadline = Date.now() + SOFT_BUDGET_MS
  const journal = createJournal(deps.home)
  const grouped = new Map<string, CollectorEvent[]>()
  for (const event of events) {
    await journal.enqueue(event)
    const key = keyOf(event)
    grouped.set(key, [...(grouped.get(key) ?? []), event])
  }

  let aggregate: 'written' | 'queued' | 'ignored' = 'ignored'
  const followups = new Set<string>()
  for (const key of grouped.keys()) {
    const result = await processKey(key, deps, deadline)
    if (result.status === 'queued') aggregate = 'queued'
    else if (result.status === 'written' && aggregate === 'ignored') aggregate = 'written'
    result.forwarded.forEach(forwarded => followups.add(forwarded))
  }
  for (const key of followups) {
    const result = await processKey(key, deps, deadline)
    if (result.status === 'queued') aggregate = 'queued'
    else if (result.status === 'written' && aggregate === 'ignored') aggregate = 'written'
  }
  return aggregate
}

export async function replayPending(deps: Dependencies): Promise<{ written: number; queued: number }> {
  const journal = createJournal(deps.home)
  const deadline = Date.now() + SOFT_BUDGET_MS
  let written = 0
  let queued = 0
  const queue = await journal.keys()
  const seen = new Set<string>()
  while (queue.length > 0) {
    const key = queue.shift()!
    if (seen.has(key)) continue
    seen.add(key)
    const result = await processKey(key, deps, deadline)
    if (result.status === 'written') written += 1
    if (result.status === 'queued') queued += 1
    queue.push(...result.forwarded)
  }
  return { written, queued }
}
