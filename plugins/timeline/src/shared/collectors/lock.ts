import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

type LockRecord = { pid: number; token: string }

function lockPath(home: string, key: string): string {
  return path.join(home, 'collectors', createHash('sha256').update(key).digest('hex'), 'lock')
}

async function readLock(filePath: string): Promise<LockRecord | null> {
  try {
    const value = JSON.parse(await readFile(filePath, 'utf8')) as Partial<LockRecord>
    return Number.isInteger(value.pid) && value.pid! > 0 && typeof value.token === 'string'
      ? value as LockRecord
      : null
  } catch {
    return null
  }
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
  if (current?.token === token && current.pid === process.pid) {
    await unlink(filePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
}

async function acquireLock(filePath: string, deadline: number, depth = 0): Promise<string | null> {
  if (depth > 16) return null
  const token = randomUUID()
  while (true) {
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      file = await open(filePath, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (file) {
      try {
        await file.writeFile(JSON.stringify({ pid: process.pid, token }))
        await file.sync()
      } finally {
        await file.close()
      }
      const current = await readLock(filePath)
      return current?.token === token && current.pid === process.pid ? token : null
    }

    const existing = await readLock(filePath)
    if (!existing) {
      console.warn(`[timeline] preserving malformed session lock ${filePath}`)
      return null
    }
    if (isDead(existing.pid)) {
      const guardPath = `${filePath}.reclaim`
      const guardToken = await acquireLock(guardPath, deadline, depth + 1)
      if (guardToken) {
        try {
          const guard = await readLock(guardPath)
          const current = await readLock(filePath)
          if (guard?.token === guardToken && guard.pid === process.pid
            && current?.token === existing.token && current.pid === existing.pid
            && isDead(current.pid)) {
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
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  const filePath = lockPath(home, key)
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const token = await acquireLock(filePath, Date.now() + 300)
  if (!token) return { acquired: false }
  try {
    return { acquired: true, value: await action() }
  } finally {
    await releaseLock(filePath, token)
  }
}
