import { promisify } from 'node:util'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, openDatabase } from '@ohmyc/timeline'
import { expect, it } from 'vitest'

it('initializes concurrent actual Bun bundles against an existing v3 database', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'opencode-upgrade-'))
  try {
    const worker = path.resolve(import.meta.dirname, '../fixtures/opencode-upgrade.ts')
    const options = { env: { ...process.env, OHMYC_HOME: home }, encoding: 'utf8' as const }
    execFileSync('bun', [worker, 'init'], options)
    const outputs = await Promise.all(Array.from({ length: 3 }, () => promisify(execFile)('bun', [worker], options)))
    for (const { stdout } of outputs) {
      expect(JSON.parse(stdout)).toMatchObject({ hooks: ['event'], version: '5', legacy: 'legacy', tools: 1, skills: 1 })
    }
    for (let i = 0; i < 2; i++) {
      const db = openDatabase({ dbPath: path.join(home, 'timeline.db') })
      expect(db.prepare('SELECT tokens_input, token_status FROM sessions').get())
        .toEqual({ tokens_input: 10, token_status: 'legacy' })
      closeDatabase(db)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

it('waits through a proven transient writer lock when the actual Bun bundle upgrades v3', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'opencode-contention-'))
  try {
    const worker = path.resolve(import.meta.dirname, '../fixtures/opencode-upgrade.ts')
    const options = { env: { ...process.env, OHMYC_HOME: home }, encoding: 'utf8' as const, timeout: 5000 }
    execFileSync('bun', [worker, 'init'], options)
    const result = JSON.parse(execFileSync('bun', [worker, 'contended'], options))
    expect(result).toMatchObject({ hooks: ['event'], version: '5', legacy: 'legacy', tools: 1, skills: 1 })
    expect(result.elapsed).toBeGreaterThanOrEqual(100)
    expect(result.elapsed).toBeLessThan(3000)
    const db = openDatabase({ dbPath: path.join(home, 'timeline.db') })
    expect(db.prepare('SELECT token_status FROM sessions').get()).toEqual({ token_status: 'legacy' })
    closeDatabase(db)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
