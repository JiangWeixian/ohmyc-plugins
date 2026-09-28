import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { sessionKey } from './identity'
import type { CollectorEvent, CollectorState } from './types'

const HEX_HASH = /^[a-f0-9]{64}$/

function collectorDirectory(home: string, key: string): string {
  const hash = createHash('sha256').update(key).digest('hex')
  return path.join(home, 'collectors', hash)
}

async function ensureDirectory(home: string, key: string): Promise<string> {
  const directory = collectorDirectory(home, key)
  await mkdir(path.join(directory, 'outbox'), { recursive: true, mode: 0o700 })
  return directory
}

async function durableWrite(filePath: string, value: unknown): Promise<void> {
  const tempPath = path.join(path.dirname(filePath), `.tmp-${randomUUID()}`)
  const file = await open(tempPath, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(value))
    await file.sync()
  } finally {
    await file.close()
  }
  try {
    await rename(tempPath, filePath)
  } finally {
    await unlink(tempPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
}

async function writeOnce(filePath: string, value: unknown): Promise<void> {
  const tempPath = path.join(path.dirname(filePath), `.tmp-${randomUUID()}`)
  const file = await open(tempPath, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(value))
    await file.sync()
  } finally {
    await file.close()
  }
  try {
    await link(tempPath, filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  } finally {
    await unlink(tempPath)
  }
}

export class CorruptCollectorStateError extends Error {
  constructor(readonly corruptPath: string) {
    super(`corrupt collector state moved to ${corruptPath}; host hydration required`)
  }
}

export function createJournal(home: string) {
  return {
    async enqueue(event: CollectorEvent): Promise<void> {
      if (!HEX_HASH.test(event.eventId)) throw new Error('invalid collector event id')
      const key = sessionKey(event.agent, event.nativeSessionId)
      const directory = await ensureDirectory(home, key)
      await writeOnce(path.join(directory, 'identity.json'), { key })
      await writeOnce(path.join(directory, 'outbox', `${event.eventId}.json`), event)
    },

    async pending(key: string): Promise<CollectorEvent[]> {
      const outbox = path.join(collectorDirectory(home, key), 'outbox')
      let names: string[]
      try {
        names = await readdir(outbox)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
      const events: CollectorEvent[] = []
      for (const name of names.filter(name => HEX_HASH.test(name.slice(0, -5)) && name.endsWith('.json')).sort()) {
        try {
          events.push(JSON.parse(await readFile(path.join(outbox, name), 'utf8')) as CollectorEvent)
        } catch (error) {
          console.warn(`[timeline] unreadable outbox event ${name}: ${String(error)}`)
        }
      }
      return events
    },

    async load(key: string): Promise<CollectorState | null> {
      const statePath = path.join(collectorDirectory(home, key), 'state.json')
      try {
        const state = JSON.parse(await readFile(statePath, 'utf8')) as Partial<CollectorState>
        if (state.version !== 1
          || (state.agent !== 'cursor' && state.agent !== 'grok')
          || typeof state.nativeSessionId !== 'string'
          || !state.events || typeof state.events !== 'object'
          || sessionKey(state.agent, state.nativeSessionId) !== key) {
          throw new Error('invalid collector state')
        }
        return state as CollectorState
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          const names = await readdir(path.dirname(statePath)).catch(() => [])
          const corrupt = names.find(name => name.startsWith('state.json.') && name.endsWith('.corrupt'))
          if (corrupt) throw new CorruptCollectorStateError(path.join(path.dirname(statePath), corrupt))
          return null
        }
        const corruptPath = `${statePath}.${Date.now()}-${randomUUID()}.corrupt`
        await rename(statePath, corruptPath).catch(() => undefined)
        throw new CorruptCollectorStateError(corruptPath)
      }
    },

    async save(key: string, state: CollectorState): Promise<void> {
      const directory = await ensureDirectory(home, key)
      await durableWrite(path.join(directory, 'state.json'), state)
    },

    async ack(key: string, eventIds: string[]): Promise<void> {
      const outbox = path.join(collectorDirectory(home, key), 'outbox')
      await Promise.all(eventIds.filter(id => HEX_HASH.test(id)).map(async id => {
        await unlink(path.join(outbox, `${id}.json`)).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        })
      }))
    },

    async keys(): Promise<string[]> {
      const root = path.join(home, 'collectors')
      let directories: string[]
      try {
        directories = await readdir(root)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
      const keys: string[] = []
      for (const directory of directories) {
        const base = path.join(root, directory)
        try {
          const identity = JSON.parse(await readFile(path.join(base, 'identity.json'), 'utf8')) as { key?: unknown }
          if (typeof identity.key !== 'string') continue
          if ((await this.pending(identity.key)).length > 0) keys.push(identity.key)
        } catch (error) {
          console.warn(`[timeline] unreadable collector identity ${directory}: ${String(error)}`)
        }
      }
      return keys.sort()
    },
  }
}
