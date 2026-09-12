import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { TimelinePlugin } from '../../dist/index.js'

const db = new Database(path.join(process.env.OHMYC_HOME!, 'timeline.db'))
if (process.argv[2] === 'init') {
  db.exec(readFileSync(new URL('./schema-v3.sql', import.meta.url), 'utf8'))
  db.close()
  process.exit(0)
}
const hooks = await TimelinePlugin({ directory: '/tmp/upgrade', client: {} } as never)
console.log(JSON.stringify({
  hooks: Object.keys(hooks).filter(key => key === 'event'),
  version: db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value,
  legacy: db.query('SELECT * FROM sessions').get()?.token_status,
  tools: db.query('SELECT count(*) AS n FROM session_tools').get()?.n,
  skills: db.query('SELECT count(*) AS n FROM session_skills').get()?.n,
}))
db.close()
