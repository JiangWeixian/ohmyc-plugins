import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const result = spawnSync(process.execPath, [
  '--no-warnings',
  fileURLToPath(new URL('../../dist/ingest.mjs', import.meta.url)),
  '--hook', 'zcode',
], { stdio: ['inherit', 'ignore', 'pipe'], timeout: 4000 })
if (result.error || result.status !== 0) {
  process.stderr.write('[timeline] ZCode collection failed; inspect pending events\n')
  if (result.stderr?.length) process.stderr.write(result.stderr)
}
