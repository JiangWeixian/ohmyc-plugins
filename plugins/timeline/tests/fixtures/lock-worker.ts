import { createHash } from 'node:crypto'
import { mkdirSync, openSync, closeSync, writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { withSessionLock } from '../../src/shared/collectors/lock'

const [home, key, mode] = process.argv.slice(2)
const directory = path.join(home, 'collectors', createHash('sha256').update(key).digest('hex'))
mkdirSync(directory, { recursive: true })
if (mode === 'crash-reaper') {
  writeFileSync(path.join(directory, 'lock'), JSON.stringify({ pid: process.pid, token: 'dead-owner' }))
  writeFileSync(path.join(directory, 'lock.reclaim'), JSON.stringify({ pid: process.pid, token: 'dead-reaper' }))
  process.exit(0)
}
const waitMs = Number(process.env.TIMELINE_LOCK_WAIT_MS || 300)
const result = await withSessionLock(home, key, async () => {
  const critical = path.join(directory, 'critical')
  closeSync(openSync(critical, 'wx'))
  await delay(40)
  unlinkSync(critical)
  return 'exclusive'
}, waitMs)
console.log(JSON.stringify(result))
