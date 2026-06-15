import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'

const FIXTURES = {
  minimal: [
    '{"type":"user","timestamp":"2026-04-30T10:00:00.000Z","message":{"role":"user","content":"hello"}}',
    '{"type":"assistant","timestamp":"2026-04-30T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":5,"output_tokens":3}}}',
  ],
  fullSession: [
    '{"type":"user","timestamp":"2026-04-30T10:00:00.000Z","message":{"role":"user","content":"Fix the login bug"}}',
    '{"type":"assistant","timestamp":"2026-04-30T10:00:02.000Z","message":{"role":"assistant","model":"claude-sonnet-4-20250514","content":[{"type":"text","text":"Looking at the code..."},{"type":"tool_use","id":"toolu_01","name":"Read","input":{"file_path":"src/auth.ts"}}],"usage":{"input_tokens":17473,"output_tokens":11,"cache_read_input_tokens":1024,"cache_creation_input_tokens":512}}}',
    '{"type":"user","timestamp":"2026-04-30T10:00:04.000Z","message":{"role":"user","content":[{"tool_use_id":"toolu_01","type":"tool_result","content":"file contents","is_error":false}]}}',
    '{"type":"user","timestamp":"2026-04-30T10:00:05.000Z","message":{"role":"user","content":"Now check the tests"}}',
    '{"type":"assistant","timestamp":"2026-04-30T10:00:07.000Z","message":{"role":"assistant","model":"claude-sonnet-4-20250514","content":[{"type":"tool_use","id":"toolu_02","name":"Bash","input":{"command":"npm test"}},{"type":"tool_use","id":"toolu_03","name":"Skill","input":{"skill":"investigate"}}],"usage":{"input_tokens":500,"output_tokens":200,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}',
    '{"type":"system","timestamp":"2026-04-30T10:00:10.000Z","subtype":"away_summary","content":"Fixed login validation bug"}',
  ],
  noUserMessages: [
    '{"type":"assistant","timestamp":"2026-04-30T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":5,"output_tokens":3}}}',
  ],
  longMessage: [
    `{"type":"user","timestamp":"2026-04-30T10:00:00.000Z","message":{"role":"user","content":"${'x'.repeat(200)}"}}`,
    '{"type":"assistant","timestamp":"2026-04-30T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":5,"output_tokens":3}}}',
  ],
  iterationsUsage: [
    '{"type":"user","timestamp":"2026-04-30T10:00:00.000Z","message":{"role":"user","content":"hello"}}',
    '{"type":"assistant","timestamp":"2026-04-30T10:00:05.000Z","message":{"role":"assistant","model":"claude-sonnet-4-20250514","content":[{"type":"text","text":"hi"}],"usage":{"iterations":[{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":200,"cache_creation_input_tokens":100},{"input_tokens":150,"output_tokens":75,"cache_read_input_tokens":300,"cache_creation_input_tokens":150}]}}}',
  ],
} as const

function writeTranscript(dir: string, sessionId: string, lines: readonly string[]): string {
  mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${sessionId}.jsonl`)
  writeFileSync(filePath, `${lines.join('\n')}\n`)
  return filePath
}

describe('ingest-claude.sh', () => {
  let tmpDir: string
  let fakeClaudeDir: string
  let capturePath: string
  let pluginHook: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ingest-sh-test-'))
    fakeClaudeDir = path.join(tmpDir, '.claude', 'projects', '-tmp-my-project')
    mkdirSync(fakeClaudeDir, { recursive: true })

    const tempPluginDir = path.join(tmpDir, 'plugin')
    mkdirSync(path.join(tempPluginDir, 'hooks'), { recursive: true })
    mkdirSync(path.join(tempPluginDir, 'dist'), { recursive: true })

    const realHook = readFileSync(path.resolve(import.meta.dirname, '../../../hooks/ingest-claude.sh'), 'utf8')
    writeFileSync(path.join(tempPluginDir, 'hooks/ingest-claude.sh'), realHook)
    chmodSync(path.join(tempPluginDir, 'hooks/ingest-claude.sh'), 0o755)

    capturePath = path.join(tmpDir, 'captured.json')
    const stub = 'import { writeFileSync } from \'node:fs\';\n'
      + 'if (process.argv.includes(\'--raw\')) {\n'
      + '  let buf = \'\';\n'
      + '  for await (const chunk of process.stdin) { buf += chunk; }\n'
      + `  writeFileSync(${JSON.stringify(capturePath)}, buf);\n`
      + '  console.log(\'INGEST_RAW_OK\');\n'
      + '} else {\n'
      + `  writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args: process.argv.slice(2) }));\n`
      + '  console.log(\'INGEST_SLOW_OK\');\n'
      + '}\n'
    writeFileSync(path.join(tempPluginDir, 'dist/ingest.mjs'), stub)

    pluginHook = path.join(tempPluginDir, 'hooks/ingest-claude.sh')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function runIngest(
    args: string[],
    opts?: { stdin?: string; env?: Record<string, string> },
  ): { stdout: string; stderr: string; status: number | null } {
    const env = {
      ...process.env,
      AGENT_HOME: path.join(tmpDir, '.claude'),
      OHMYC_HOME: path.join(tmpDir, '.ohmyc-data'),
      ...opts?.env,
    }

    const result = spawnSync('bash', [pluginHook, ...args], {
      env,
      input: opts?.stdin,
      encoding: 'utf8',
    })

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
    }
  }

  function readCaptured(): Record<string, unknown> {
    return JSON.parse(readFileSync(capturePath, 'utf8'))
  }

  // ---------------------------------------------------------------------------
  // Argument validation
  // ---------------------------------------------------------------------------

  it('exits 0 when called without arguments and no stdin', () => {
    const result = runIngest([])
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('No transcript path in hook input')
  })

  it('exits 0 when transcript not found', () => {
    const result = runIngest(['nonexistent-session'])
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('Transcript not found')
  })

  // ---------------------------------------------------------------------------
  // Manual + hook invocation
  // ---------------------------------------------------------------------------

  it('manual invocation finds transcript and calls node bundle', () => {
    writeTranscript(fakeClaudeDir, 'test-session-001', FIXTURES.minimal)

    const result = runIngest(['test-session-001'])
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('Using jq fast path')
    expect(result.stdout).toContain('INGEST_RAW_OK')
  })

  it('hook invocation reads transcript_path from stdin JSON', () => {
    const transcriptPath = writeTranscript(fakeClaudeDir, 'test-session-002', FIXTURES.minimal)

    const hookInput = JSON.stringify({ transcript_path: transcriptPath })
    const result = runIngest([], { stdin: hookInput })

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('Using jq fast path')
    expect(result.stdout).toContain('INGEST_RAW_OK')
  })

  it('hook invocation reads transcript_path from stdin JSON when jq is unavailable', () => {
    const transcriptPath = writeTranscript(fakeClaudeDir, 'test-session-stdin-no-jq', FIXTURES.minimal)
    const fakeJq = path.join(tmpDir, 'jq')
    writeFileSync(fakeJq, '#!/bin/bash\nexit 1\n')
    chmodSync(fakeJq, 0o755)

    const result = runIngest([], {
      stdin: JSON.stringify({ transcript_path: transcriptPath }),
      env: { PATH: `${tmpDir}:${process.env.PATH}` },
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('Using slow path')
    expect(result.stdout).toContain('INGEST_SLOW_OK')
    expect(readCaptured()).toEqual({
      args: [
        '--session-id',
        'test-session-stdin-no-jq',
        '--transcript-path',
        transcriptPath,
        '--agent-name',
        'claude',
      ],
    })
  })

  it('hook invocation exits 0 when transcript_path missing', () => {
    const result = runIngest([], { stdin: JSON.stringify({}) })
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('No transcript path in hook input')
  })

  // ---------------------------------------------------------------------------
  // jq fast path — extracted field validation
  // ---------------------------------------------------------------------------

  describe('jq extraction', () => {
    it('captures agentName as "claude"', () => {
      writeTranscript(fakeClaudeDir, 'test-agent', FIXTURES.fullSession)

      const result = runIngest(['test-agent'])
      expect(result.status).toBe(0)

      const captured = readCaptured()
      expect(captured.agentName).toBe('claude')
    })

    it('extracts model from assistant messages', () => {
      writeTranscript(fakeClaudeDir, 'test-model', FIXTURES.fullSession)

      const result = runIngest(['test-model'])
      expect(result.status).toBe(0)

      const captured = readCaptured()
      expect(captured.model).toBe('claude-sonnet-4-20250514')
    })

    it('extracts turns, tokens, tools, skills from full session', () => {
      writeTranscript(fakeClaudeDir, 'test-full', FIXTURES.fullSession)

      const result = runIngest(['test-full'])
      expect(result.status).toBe(0)

      const captured = readCaptured()
      expect(captured.turns).toBe(2)
      expect(captured.tokensInput).toBe(17_973)
      expect(captured.tokensOutput).toBe(211)
      expect(captured.tokensCached).toBe(1536)
      expect(captured.tools).toEqual(expect.arrayContaining([
        { toolName: 'Read', callCount: 1 },
        { toolName: 'Bash', callCount: 1 },
        { toolName: 'Skill', callCount: 1 },
      ]))
      expect(captured.skills).toEqual(['investigate'])
    })

    it('computes durationMs from timestamps', () => {
      writeTranscript(fakeClaudeDir, 'test-duration', FIXTURES.fullSession)

      const result = runIngest(['test-duration'])
      expect(result.status).toBe(0)

      const captured = readCaptured()
      expect(typeof captured.startedAt).toBe('number')
      expect(typeof captured.endedAt).toBe('number')
      expect(captured.durationMs).toBe(captured.endedAt - captured.startedAt)
      expect(captured.durationMs).toBe(10_000)
    })

    it('prefers away_summary over firstUserMessage for summary', () => {
      writeTranscript(fakeClaudeDir, 'test-summary', FIXTURES.fullSession)

      const result = runIngest(['test-summary'])
      expect(result.status).toBe(0)

      const captured = readCaptured()
      expect(captured.summary).toBe('Fixed login validation bug')
      expect(captured.summarySource).toBe('auto')
    })

    it('uses firstUserMessage as summary when no away_summary', () => {
      writeTranscript(fakeClaudeDir, 'test-summary-fallback', FIXTURES.minimal)

      const result = runIngest(['test-summary-fallback'])
      expect(result.status).toBe(0)

      const captured = readCaptured()
      expect(captured.summary).toBe('hello')
      expect(captured.summarySource).toBe('first_message')
    })

    it('truncates long firstUserMessage to 140 chars', () => {
      writeTranscript(fakeClaudeDir, 'test-truncate', FIXTURES.longMessage)

      const result = runIngest(['test-truncate'])
      expect(result.status).toBe(0)

      const captured = readCaptured()
      expect(captured.summary.length).toBe(140)
      expect(captured.summarySource).toBe('first_message')
    })

    it('uses "(untitled session)" when no messages', () => {
      writeTranscript(fakeClaudeDir, 'test-notitle', FIXTURES.noUserMessages)

      const result = runIngest(['test-notitle'])
      expect(result.status).toBe(0)

      const captured = readCaptured()
      expect(captured.summary).toBe('(untitled session)')
      expect(captured.summarySource).toBe('auto')
    })

    it('includes fileSize from transcript', () => {
      writeTranscript(fakeClaudeDir, 'test-filesize', FIXTURES.minimal)

      const result = runIngest(['test-filesize'])
      expect(result.status).toBe(0)

      const captured = readCaptured()
      expect(typeof captured.fileSize).toBe('number')
      expect(captured.fileSize).toBeGreaterThan(0)
    })

    it('extracts tokens from iterations array', () => {
      writeTranscript(fakeClaudeDir, 'test-iterations', FIXTURES.iterationsUsage)

      const result = runIngest(['test-iterations'])
      expect(result.status).toBe(0)

      const captured = readCaptured()
      expect(captured.tokensInput).toBe(250)
      expect(captured.tokensOutput).toBe(125)
    })

    it('excludes tool_result arrays from turn count', () => {
      const lines = [
        '{"type":"user","timestamp":"2026-04-30T10:00:00.000Z","message":{"role":"user","content":"Run commands"}}',
        '{"type":"assistant","timestamp":"2026-04-30T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"OK"}],"usage":{"input_tokens":5,"output_tokens":3}}}',
        '{"type":"user","timestamp":"2026-04-30T10:00:10.000Z","message":{"role":"user","content":[{"tool_use_id":"toolu_01","type":"tool_result","content":"output","is_error":false}]}}',
        '{"type":"user","timestamp":"2026-04-30T10:00:15.000Z","message":{"role":"user","content":"What was the result?"}}',
      ]
      writeTranscript(fakeClaudeDir, 'test-toolresult', lines)

      const result = runIngest(['test-toolresult'])
      expect(result.status).toBe(0)

      const captured = readCaptured()
      expect(captured.turns).toBe(2)
    })
  })

  // ---------------------------------------------------------------------------
  // Fallback path (no jq)
  // ---------------------------------------------------------------------------

  it('falls back to slow path when jq is not available', () => {
    writeTranscript(fakeClaudeDir, 'test-fallback', FIXTURES.minimal)

    const fakeJq = path.join(tmpDir, 'jq')
    writeFileSync(fakeJq, '#!/bin/bash\nexit 1\n')
    chmodSync(fakeJq, 0o755)

    const result = runIngest(['test-fallback'], {
      env: { PATH: `${tmpDir}:${process.env.PATH}` },
    })
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('Using slow path')
    expect(result.stdout).toContain('INGEST_SLOW_OK')
    expect(readCaptured()).toEqual({
      args: [
        '--session-id',
        'test-fallback',
        '--transcript-path',
        path.join(fakeClaudeDir, 'test-fallback.jsonl'),
        '--agent-name',
        'claude',
      ],
    })
  })

  describe('home directory resolution', () => {
    it('uses ~/.config/ohmyc as default when OHMYC_HOME is unset', () => {
      writeTranscript(fakeClaudeDir, 'test-legacy-home', FIXTURES.minimal)

      const result = spawnSync('bash', [pluginHook, 'test-legacy-home'], {
        env: {
          ...process.env,
          AGENT_HOME: path.join(tmpDir, '.claude'),
          HOME: tmpDir,
          OHMYC_HOME: '',
        },
        encoding: 'utf8',
      })

      expect(result.status).toBe(0)
      expect(result.stderr).toContain('Using jq fast path')
    })
  })
})
