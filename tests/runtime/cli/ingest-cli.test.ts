import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { closeDatabase, openDatabase } from '@ohmyc/timeline'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'

const INGEST_MJS = path.resolve(import.meta.dirname, '../../../dist/ingest.mjs')

const MINIMAL_TRANSCRIPT = [
  '{"type":"user","timestamp":"2026-04-30T10:00:00.000Z","message":{"role":"user","content":"hello"}}',
  '{"type":"assistant","timestamp":"2026-04-30T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":5,"output_tokens":3}}}',
].join('\n')

describe('dist/ingest.mjs (node entry)', () => {
  let tmpDir: string
  let dbDir: string
  let transcriptPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ingest-node-'))
    dbDir = path.join(tmpDir, 'ohmyc')
    mkdirSync(dbDir, { recursive: true })
    transcriptPath = path.join(tmpDir, 'session-aaa.jsonl')
    writeFileSync(transcriptPath, `${MINIMAL_TRANSCRIPT}\n`)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function run(args: string[], stdin?: string) {
    return spawnSync('node', [INGEST_MJS, ...args], {
      env: { ...process.env, OHMYC_HOME: dbDir },
      input: stdin,
      encoding: 'utf8',
    })
  }

  function runFromCacheWithoutNodeModules(args: string[], stdin?: string) {
    const cacheDir = path.join(tmpDir, 'cache-plugin')
    const cacheDist = path.join(cacheDir, 'dist')
    mkdirSync(cacheDist, { recursive: true })
    copyFileSync(INGEST_MJS, path.join(cacheDist, 'ingest.mjs'))

    return spawnSync('node', [path.join(cacheDist, 'ingest.mjs'), ...args], {
      env: { ...process.env, OHMYC_HOME: dbDir },
      input: stdin,
      encoding: 'utf8',
    })
  }

  function readDb<QueryResult>(query: (db: ReturnType<typeof openDatabase>) => QueryResult): QueryResult {
    const db = openDatabase({ dbPath: path.join(dbDir, 'timeline.db') })
    try {
      return query(db)
    } finally {
      closeDatabase(db)
    }
  }

  it('ingests from disk via --session-id + --transcript-path', () => {
    const result = run(['--session-id', 'session-aaa', '--transcript-path', transcriptPath])

    expect(result.status).toBe(0)

    const row = readDb(db =>
      db.prepare('SELECT session_id, turns FROM sessions WHERE session_id = ?').get('session-aaa') as
      | { session_id: string; turns: number }
      | undefined,
    )

    expect(row).toBeDefined()
    expect(row?.session_id).toBe('session-aaa')
    expect(row?.turns).toBe(1)
  })

  it('ingests Codex transcripts from disk via --agent-name codex', () => {
    const codexTranscript = [
      '{"timestamp":"2026-06-12T14:05:24.091Z","type":"session_meta","payload":{"id":"codex-session-001","timestamp":"2026-06-12T14:04:08.529Z","cwd":"/tmp/codex-project","originator":"Codex Desktop"}}',
      '{"timestamp":"2026-06-12T14:05:24.153Z","type":"turn_context","payload":{"turn_id":"turn-001","cwd":"/tmp/codex-project","model":"gpt-5.5"}}',
      '{"timestamp":"2026-06-12T14:05:24.165Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"review this plan"}]}}',
      String.raw`{"timestamp":"2026-06-12T14:05:30.000Z","type":"response_item","payload":{"type":"function_call","name":"functions.exec_command","arguments":"{\"cmd\":\"pwd\"}"}}`,
      '{"timestamp":"2026-06-12T14:05:40.000Z","type":"event_msg","payload":{"type":"token_count","info":{"input_tokens":10,"output_tokens":5,"cached_input_tokens":2}}}',
    ].join('\n')
    writeFileSync(transcriptPath, `${codexTranscript}\n`)

    const result = run([
      '--session-id',
      'codex-session-001',
      '--transcript-path',
      transcriptPath,
      '--agent-name',
      'codex',
    ])

    expect(result.status).toBe(0)

    const row = readDb(db =>
      db
        .prepare('SELECT session_id, agent_name, project, turns FROM sessions WHERE session_id = ?')
        .get('codex-session-001') as {
          session_id: string
          agent_name: string
          project: string
          turns: number
        } | undefined,
    )

    expect(row).toMatchObject({
      session_id: 'codex-session-001',
      agent_name: 'codex',
      project: '/tmp/codex-project',
      turns: 1,
    })
  })

  it('ingests pre-parsed JSON from stdin via --raw', () => {
    const parsed = {
      sessionId: 'session-bbb',
      project: 'demo',
      agentName: 'claude',
      startedAt: 1_714_478_400_000,
      endedAt: 1_714_478_405_000,
      durationMs: 5000,
      turns: 1,
      tokensInput: 5,
      tokensOutput: 3,
      tokensCached: 0,
      summary: 'hello',
      summarySource: 'first_message',
      transcriptPath: '/dev/null',
      fileSize: 0,
      tools: [],
      skills: [],
      model: null,
    }

    const result = run(['--raw'], JSON.stringify(parsed))
    expect(result.status).toBe(0)

    const row = readDb(db =>
      db.prepare('SELECT session_id, project FROM sessions WHERE session_id = ?').get('session-bbb') as
      | { session_id: string; project: string }
      | undefined,
    )

    expect(row?.session_id).toBe('session-bbb')
    expect(row?.project).toBe('demo')
  })

  it('ingests pre-parsed JSON from an installed Codex cache without node_modules', () => {
    const parsed = {
      sessionId: 'session-cache',
      project: 'demo-cache',
      agentName: 'codex',
      startedAt: 1_714_478_400_000,
      endedAt: 1_714_478_405_000,
      durationMs: 5000,
      turns: 1,
      tokensInput: 5,
      tokensOutput: 3,
      tokensCached: 0,
      summary: 'hello from cache',
      summarySource: 'first_message',
      transcriptPath: '/dev/null',
      fileSize: 0,
      tools: [{ toolName: 'exec_command', callCount: 1 }],
      skills: ['test-driven-development'],
      model: 'gpt-5.5',
    }

    const result = runFromCacheWithoutNodeModules(['--raw'], JSON.stringify(parsed))
    expect(result.status).toBe(0)

    const { row, skill } = readDb((db) => {
      const row = db
        .prepare('SELECT session_id, agent_name, project FROM sessions WHERE session_id = ?')
        .get('session-cache') as { session_id: string; agent_name: string; project: string } | undefined
      const skill = db
        .prepare('SELECT skill_name FROM session_skills WHERE session_id = ?')
        .get('session-cache') as { skill_name: string } | undefined

      return { row, skill }
    })

    expect(row).toMatchObject({
      session_id: 'session-cache',
      agent_name: 'codex',
      project: 'demo-cache',
    })
    expect(skill?.skill_name).toBe('test-driven-development')
  })

  it('exits 1 when neither --raw nor required disk args are provided', () => {
    const result = run([])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--session-id and --transcript-path are required')
  })

  it('exits 1 when --raw receives empty stdin', () => {
    const result = run(['--raw'], '')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--raw expects JSON on stdin')
  })

  it('exits 1 when --raw receives invalid JSON', () => {
    const result = run(['--raw'], 'not json')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('invalid JSON on stdin')
  })
})
