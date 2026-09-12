import { readFileSync } from 'node:fs'
import { closeDatabase, openDatabase } from '@ohmyc/timeline'
import { createWriter } from '@ohmyc/timeline/writer'
import type { ParsedSessionData } from '@ohmyc/timeline/schema'
import { ingestEvents, replayPending } from '../../src/shared/collectors/ingest-event'
import { createJournal } from '../../src/shared/collectors/journal'
import { reduceEvents } from '../../src/shared/collectors/reduce'
import type { CollectorEvent } from '../../src/shared/collectors/types'

const [home, eventPath, databasePath, mode = 'ingest'] = process.argv.slice(2)
if (!home || !databasePath) throw new Error('expected home, event path, and database path')
const write = (data: ParsedSessionData) => {
  const database = openDatabase({ dbPath: databasePath })
  try {
    createWriter(database).writeSession(data)
    if (mode === 'exit-after-write') process.exit(73)
  } finally {
    closeDatabase(database)
  }
}
if (mode === 'replay') await replayPending({ home, hydrate: async () => [], write })
else {
  const events = JSON.parse(readFileSync(eventPath, 'utf8')) as CollectorEvent[]
  if (mode === 'exit-after-save') {
    const journal = createJournal(home)
    for (const event of events) await journal.enqueue(event)
    const key = `${events[0].agent}:${events[0].nativeSessionId}`
    const pending = await journal.pending(key)
    await journal.save(key, reduceEvents(await journal.load(key), pending))
    process.exit(74)
  } else {
    await ingestEvents(events, { home, hydrate: async () => [], write })
  }
}
