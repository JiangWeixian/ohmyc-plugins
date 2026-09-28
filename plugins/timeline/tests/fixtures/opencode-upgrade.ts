import { Database } from 'bun:sqlite'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { TimelinePlugin } from '../../dist/index.js'

const db = new Database(path.join(process.env.OHMYC_HOME!, 'timeline.db'))
if (process.argv[2] === 'init') {
  db.exec(readFileSync(new URL('./schema-v3.sql', import.meta.url), 'utf8'))
  db.exec('PRAGMA journal_mode = WAL')
  db.close()
  process.exit(0)
}
if (process.argv[2] === 'hold') {
  db.exec('BEGIN IMMEDIATE')
  console.log('HELD')
  await new Promise(resolve => setTimeout(resolve, 250))
  db.exec('COMMIT')
  db.close()
  process.exit(0)
}
let holder: ReturnType<typeof spawn> | undefined
let holderDone: Promise<unknown> | undefined
if (process.argv[2] === 'contended') {
  holder = spawn(process.execPath, [import.meta.filename, 'hold'], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] })
  holderDone = once(holder, 'exit')
  const [chunk] = await once(holder.stdout!, 'data')
  if (!chunk.toString().includes('HELD')) throw new Error('holder did not acquire transaction')
}
const started = Date.now()
const hooks = await TimelinePlugin({ directory: '/tmp/upgrade', client: {} } as never)
console.log(JSON.stringify({
  elapsed: Date.now() - started,
  hooks: Object.keys(hooks).filter(key => key === 'event'),
  version: db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value,
  legacy: db.query('SELECT * FROM sessions').get()?.token_status,
  tools: db.query('SELECT count(*) AS n FROM session_tools').get()?.n,
  skills: db.query('SELECT count(*) AS n FROM session_skills').get()?.n,
}))
db.close()

if (holderDone) await holderDone
