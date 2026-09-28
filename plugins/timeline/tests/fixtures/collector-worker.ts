import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { closeDatabase, openDatabase } from '@ohmyc/timeline'
import { createWriter } from '@ohmyc/timeline/writer'
import type { ParsedSessionData } from '@ohmyc/timeline/schema'
import { ingestEvents, replayPending } from '../../src/shared/collectors/ingest-event'
import type { CollectorEvent } from '../../src/shared/collectors/types'

const [home, eventPath, databasePath, mode = 'ingest'] = process.argv.slice(2)
if (!home || !databasePath) throw new Error('expected home, event path, and database path')

let savedEventId: string | undefined

function exitWhenStateIsSaved(sessionId: string, eventId: string): void {
  const hash = createHash('sha256').update(sessionId).digest('hex')
  const statePath = path.join(home, 'collectors', hash, 'state.json')
  const check = () => {
    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, 'utf8')) as { events?: Record<string, unknown> }
        if (state.events?.[eventId]) process.exit(74)
      } catch {}
    }
    setImmediate(check)
  }
  setImmediate(check)
}

const write = (data: ParsedSessionData) => {
  const database = openDatabase({ dbPath: databasePath })
  try {
    createWriter(database).writeSession(data)
    if (mode === 'exit-after-write') process.exit(73)
  } finally {
    closeDatabase(database)
  }
  if (mode === 'exit-after-save' && savedEventId) exitWhenStateIsSaved(data.sessionId, savedEventId)
}
if (mode === 'replay') await replayPending({ home, hydrate: async () => [], write })
else {
  const events = JSON.parse(readFileSync(eventPath, 'utf8')) as CollectorEvent[]
  savedEventId = events[0]?.eventId
  await ingestEvents(events, { home, hydrate: async () => [], write })
}
