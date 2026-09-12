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

async function reclaimDeadLock(filePath: string, existing: LockRecord): Promise<boolean> {
  const reclaimPath = `${filePath}.reclaim`
  let claim: Awaited<ReturnType<typeof open>> | undefined
  try {
    claim = await open(reclaimPath, 'wx', 0o600)
    await claim.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() }))
    await claim.sync()
  } catch (error) {
    await claim?.close().catch(() => undefined)
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  await claim.close()
  try {
    const current = await readLock(filePath)
    if (current?.token !== existing.token || !isDead(current.pid)) return false
    await unlink(filePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    return true
  } finally {
    await unlink(reclaimPath).catch(() => undefined)
  }
}

export async function withSessionLock<T>(
  home: string,
  key: string,
  action: () => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  const filePath = lockPath(home, key)
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const token = randomUUID()
  const deadline = Date.now() + 300

  while (true) {
    try {
      const file = await open(filePath, 'wx', 0o600)
      try {
        await file.writeFile(JSON.stringify({ pid: process.pid, token }))
        await file.sync()
      } finally {
        await file.close()
      }
      try {
        return { acquired: true, value: await action() }
      } finally {
        const current = await readLock(filePath)
        if (current?.token === token) await unlink(filePath).catch(() => undefined)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await readLock(filePath)
      if (!existing) {
        console.warn(`[timeline] preserving malformed session lock ${filePath}`)
        return { acquired: false }
      }
      if (isDead(existing.pid)) {
        if (await reclaimDeadLock(filePath, existing)) continue
      }
      if (Date.now() >= deadline) return { acquired: false }
      await delay(20)
    }
  }
}
