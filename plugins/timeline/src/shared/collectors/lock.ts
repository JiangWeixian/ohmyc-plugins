import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

type LockRecord = { pid: number; token: string }
type LockRead =
  | { status: 'record'; record: LockRecord }
  | { status: 'missing' }
  | { status: 'malformed' }

function lockPath(home: string, key: string): string {
  return path.join(home, 'collectors', createHash('sha256').update(key).digest('hex'), 'lock')
}

async function readLock(filePath: string): Promise<LockRead> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'malformed' }
  }
  try {
    const value = JSON.parse(raw) as Partial<LockRecord>
    if (Number.isInteger(value.pid) && value.pid! > 0 && typeof value.token === 'string') {
      return { status: 'record', record: value as LockRecord }
    }
  } catch {
    // Unreadable contents stay on disk for an explicit repair.
  }
  return { status: 'malformed' }
}

function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

async function releaseLock(filePath: string, token: string): Promise<void> {
  const current = await readLock(filePath)
  if (current.status === 'record' && current.record.token === token && current.record.pid === process.pid) {
    await unlink(filePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
}

async function acquireLock(filePath: string, deadline: number, depth = 0): Promise<string | null> {
  if (depth > 16) return null
  const token = randomUUID()
  const temporary = `${filePath}.${token}.tmp`
  while (true) {
    let linked = false
    try {
      await writeFile(temporary, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 })
      await link(temporary, filePath)
      linked = true
    } catch (error) {
      await unlink(temporary).catch(unlinkError => {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError
      })
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (linked) {
      await unlink(temporary).catch(unlinkError => {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError
      })
      const current = await readLock(filePath)
      if (current.status === 'record' && current.record.token === token && current.record.pid === process.pid) {
        return token
      }
      if (Date.now() >= deadline) return null
      continue
    }

    const existing = await readLock(filePath)
    // The owner can unlink between EEXIST and this read. That is not corruption.
    if (existing.status === 'missing') {
      if (Date.now() >= deadline) return null
      continue
    }
    if (existing.status === 'malformed') {
      console.warn(`[timeline] preserving malformed session lock ${filePath}`)
      return null
    }
    if (isDead(existing.record.pid)) {
      const guardPath = `${filePath}.reclaim`
      const guardToken = await acquireLock(guardPath, deadline, depth + 1)
      if (guardToken) {
        try {
          const guard = await readLock(guardPath)
          const current = await readLock(filePath)
          if (guard.status === 'record' && guard.record.token === guardToken && guard.record.pid === process.pid
            && current.status === 'record' && current.record.token === existing.record.token
            && current.record.pid === existing.record.pid
            && isDead(current.record.pid)) {
            await unlink(filePath).catch(error => {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            })
          }
        } finally {
          await releaseLock(guardPath, guardToken)
        }
        continue
      }
    }
    if (Date.now() >= deadline) return null
    await delay(20)
  }
}

export async function withSessionLock<T>(
  home: string,
  key: string,
  action: () => Promise<T>,
  waitMs = 300,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  const filePath = lockPath(home, key)
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const token = await acquireLock(filePath, Date.now() + waitMs)
  if (!token) return { acquired: false }
  try {
    return { acquired: true, value: await action() }
  } finally {
    await releaseLock(filePath, token)
  }
}
