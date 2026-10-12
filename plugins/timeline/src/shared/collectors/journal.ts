import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { sessionKey } from './identity'
import type { CollectorEvent, CollectorState } from './types'
import { HEX_HASH, hostOf, parseState, UnsupportedCollectorStateError, validEvent } from './state'
import { reduceEvents } from './reduce'

function legacyDirectory(home: string, key: string): string {
  return path.join(home, 'collectors', createHash('sha256').update(key).digest('hex'))
}

function collectorDirectory(home: string, key: string): string {
  const host = hostOf(key)
  const legacy = legacyDirectory(home, key)
  return host === 'kimi' || host === 'zcode' ? path.join(path.dirname(legacy), host, path.basename(legacy)) : legacy
}

async function names(directory: string): Promise<string[]> {
  try { return await readdir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function eventFiles(files: string[]): string[] {
  return files.filter(name => name.endsWith('.json') && HEX_HASH.test(name.slice(0, -5))).sort()
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

async function writeOnce(filePath: string, raw: string): Promise<void> {
  const tempPath = path.join(path.dirname(filePath), `.tmp-${randomUUID()}`)
  const file = await open(tempPath, 'wx', 0o600)
  try {
    await file.writeFile(raw)
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
    async prepare(key: string): Promise<void> {
      const host = hostOf(key)
      if (host !== 'kimi' && host !== 'zcode') return
      const legacy = legacyDirectory(home, key)
      let identity: { key?: unknown }
      try { identity = JSON.parse(await readFile(path.join(legacy, 'identity.json'), 'utf8')) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (identity.key !== key) throw new Error('legacy collector identity mismatch')
      const files = await names(legacy)
      const quarantined = files.filter(name => name.startsWith('state.json.') && name.endsWith('.corrupt'))
      const stateName = files.includes('state.json') ? 'state.json' : quarantined.length === 1 ? quarantined[0] : undefined
      if (!stateName && quarantined.length > 0) throw new CorruptCollectorStateError(legacy)
      const directory = await ensureDirectory(home, key)
      if (stateName) {
        const original = parseState(await readFile(path.join(legacy, stateName), 'utf8'), key)
        const current = await this.load(key)
        await this.save(key, reduceEvents(current ?? original, current ? Object.values(original.events) : []))
      } else {
        await this.load(key)
      }
      await writeOnce(path.join(directory, 'identity.json'), JSON.stringify({ key }))
      for (const name of eventFiles(await names(path.join(legacy, 'outbox')))) {
        const source = path.join(legacy, 'outbox', name)
        await writeOnce(path.join(directory, 'outbox', name), await readFile(source, 'utf8'))
        await unlink(source)
      }
      const backup = path.join(home, 'collector-backups', host, path.basename(legacy))
      const stateFiles = files.filter(name => name === 'state.json' || quarantined.includes(name))
      if (stateFiles.length > 0) {
        await mkdir(backup, { recursive: true, mode: 0o700 })
        for (const name of stateFiles) await rename(path.join(legacy, name), path.join(backup, `${name}.${randomUUID()}.recovered`))
      }
      if (eventFiles(await names(path.join(legacy, 'outbox'))).length === 0) {
        await unlink(path.join(legacy, 'identity.json'))
      }
    },

    async enqueue(event: CollectorEvent): Promise<void> {
      if (!HEX_HASH.test(event.eventId)) throw new Error('invalid collector event id')
      const key = sessionKey(event.agent, event.nativeSessionId)
      const directory = await ensureDirectory(home, key)
      await writeOnce(path.join(directory, 'identity.json'), JSON.stringify({ key }))
      await writeOnce(path.join(directory, 'outbox', `${event.eventId}.json`), JSON.stringify(event))
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
      for (const name of eventFiles(names)) {
        try {
          const event: unknown = JSON.parse(await readFile(path.join(outbox, name), 'utf8'))
          if (validEvent(event, key, name.slice(0, -5))) events.push(event)
          else console.warn(`[timeline] unsupported or invalid outbox event preserved: ${name}`)
        } catch (error) {
          console.warn(`[timeline] unreadable outbox event ${name}: ${String(error)}`)
        }
      }
      return events
    },

    async load(key: string): Promise<CollectorState | null> {
      const statePath = path.join(collectorDirectory(home, key), 'state.json')
      try {
        return parseState(await readFile(statePath, 'utf8'), key)
      } catch (error) {
        if (error instanceof UnsupportedCollectorStateError) throw error
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
      const directories = (await names(root)).filter(name => HEX_HASH.test(name)).map(name => path.join(root, name))
      for (const host of ['kimi', 'zcode']) {
        directories.push(...(await names(path.join(root, host))).filter(name => HEX_HASH.test(name)).map(name => path.join(root, host, name)))
      }
      const keys = new Set<string>()
      for (const base of directories) {
        try {
          const identity = JSON.parse(await readFile(path.join(base, 'identity.json'), 'utf8')) as { key?: unknown }
          if (typeof identity.key !== 'string' || !hostOf(identity.key)) continue
          if (base !== collectorDirectory(home, identity.key) && base !== legacyDirectory(home, identity.key)) continue
          if (eventFiles(await names(path.join(base, 'outbox'))).length > 0) keys.add(identity.key)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          console.warn(`[timeline] unreadable collector identity ${base}: ${String(error)}`)
        }
      }
      return [...keys].sort()
    },
  }
}
