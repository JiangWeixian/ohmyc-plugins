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

const CODEX_LINES = [
  '{"timestamp":"2026-06-13T01:00:00.000Z","type":"session_meta","payload":{"id":"codex-session-001","cwd":"/tmp/codex-project"}}',
  '{"timestamp":"2026-06-13T01:00:01.000Z","type":"turn_context","payload":{"model":"gpt-5.5","cwd":"/tmp/codex-project"}}',
  '{"timestamp":"2026-06-13T01:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello codex"}]}}',
  String.raw`{"timestamp":"2026-06-13T01:00:02.500Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<skill>\n<name>superpowers:writing-plans</name>\n<path>/tmp/skills/writing-plans/SKILL.md</path>\n---\nname: writing-plans\ndescription: Use when you have a spec or requirements for a multi-step task, before touching code\n---\n\n# Writing Plans\n</skill>"}]}}`,
  String.raw`{"timestamp":"2026-06-13T01:00:02.750Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"sed -n '1,240p' /tmp/skills/test-driven-development/SKILL.md\"}"}}`,
  String.raw`{"timestamp":"2026-06-13T01:00:03.000Z","type":"response_item","payload":{"type":"function_call","name":"functions.exec_command","arguments":"{\"cmd\":\"pwd\"}"}}`,
  '{"timestamp":"2026-06-13T01:00:04.000Z","type":"event_msg","payload":{"type":"token_count","info":{"input_tokens":10,"output_tokens":5,"cached_input_tokens":2}}}',
]

const CODEX_UUID = '019ebc25-b5ab-72a0-b391-0364d948be20'

function writeTranscript(dir: string, sessionId: string, lines: readonly string[]): string {
  mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${sessionId}.jsonl`)
  writeFileSync(filePath, `${lines.join('\n')}\n`)
  return filePath
}

describe('ingest-codex.sh', () => {
  let tmpDir: string
  let capturePath: string
  let pluginHook: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'codex-hook-test-'))

    const tempPluginDir = path.join(tmpDir, 'plugin')
    mkdirSync(path.join(tempPluginDir, 'hooks'), { recursive: true })
    mkdirSync(path.join(tempPluginDir, 'dist'), { recursive: true })

    const realHook = readFileSync(path.resolve(import.meta.dirname, '../../../hooks/ingest-codex.sh'), 'utf8')
    pluginHook = path.join(tempPluginDir, 'hooks/ingest-codex.sh')
    writeFileSync(pluginHook, realHook)
    chmodSync(pluginHook, 0o755)

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
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function runCodexHook(stdin: string, env?: Record<string, string>) {
    return spawnSync('bash', [pluginHook], {
      env: {
        ...process.env,
        CODEX_HOME: path.join(tmpDir, '.codex'),
        OHMYC_HOME: path.join(tmpDir, '.ohmyc-data'),
        ...env,
      },
      input: stdin,
      encoding: 'utf8',
    })
  }

  function readCaptured(): Record<string, unknown> {
    return JSON.parse(readFileSync(capturePath, 'utf8'))
  }

  it('uses jq fast path for Codex transcript_path stdin', () => {
    const transcriptPath = writeTranscript(
      path.join(tmpDir, '.codex', 'sessions', '2026', '06', '13'),
      'codex-session-001',
      CODEX_LINES,
    )

    const result = runCodexHook(JSON.stringify({
      session_id: 'codex-session-001',
      transcript_path: transcriptPath,
    }))

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('INGEST_RAW_OK')
    expect(readCaptured()).toMatchObject({
      sessionId: 'codex-session-001',
      agentName: 'codex',
      project: '/tmp/codex-project',
      turns: 1,
      tokensInput: 10,
      tokensOutput: 5,
      tokensCached: 2,
      summary: 'hello codex',
      summarySource: 'first_message',
      skills: ['superpowers:writing-plans', 'test-driven-development'],
      model: 'gpt-5.5',
    })
  })

  it('uses Codex Desktop total_token_usage in jq fast path', () => {
    const transcriptPath = writeTranscript(
      path.join(tmpDir, '.codex', 'sessions', '2026', '06', '13'),
      'codex-session-token-usage',
      [
        '{"timestamp":"2026-06-13T01:00:00.000Z","type":"session_meta","payload":{"id":"codex-session-token-usage","cwd":"/tmp/codex-project"}}',
        '{"timestamp":"2026-06-13T01:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello codex"}]}}',
        '{"timestamp":"2026-06-13T01:00:02.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":19368,"cached_input_tokens":4992,"output_tokens":176}}}}',
        '{"timestamp":"2026-06-13T01:00:03.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":40256,"cached_input_tokens":24320,"output_tokens":222,"reasoning_output_tokens":65,"total_tokens":40478},"last_token_usage":{"input_tokens":20888,"cached_input_tokens":19328,"output_tokens":46}}}}',
      ],
    )

    const result = runCodexHook(JSON.stringify({
      session_id: 'codex-session-token-usage',
      transcript_path: transcriptPath,
    }))

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('INGEST_RAW_OK')
    expect(readCaptured()).toMatchObject({
      sessionId: 'codex-session-token-usage',
      agentName: 'codex',
      tokensInput: 40_256,
      tokensOutput: 222,
      tokensCached: 24_320,
    })
  })

  it('keeps jq fast path output equivalent to the Node parser shape', () => {
    const homeProject = path.join(tmpDir, 'codex-project')
    const transcriptPath = writeTranscript(
      path.join(tmpDir, '.codex', 'sessions', '2026', '06', '13'),
      `rollout-2026-06-13T01-02-03-${CODEX_UUID}`,
      [
        `{"timestamp":"2026-06-13T01:00:00.123Z","type":"session_meta","payload":{"id":"${CODEX_UUID}","cwd":${JSON.stringify(homeProject)}}}`,
        `{"timestamp":"2026-06-13T01:00:01.456Z","type":"turn_context","payload":{"model":"gpt-5.5","cwd":${JSON.stringify(homeProject)}}}`,
        '{"timestamp":"2026-06-13T01:00:02.789Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello codex"}]}}',
        String.raw`{"timestamp":"2026-06-13T01:00:02.900Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<skill>\n<name>superpowers:writing-plans</name>\n<path>/tmp/skills/writing-plans/SKILL.md</path>\n---\nname: writing-plans\ndescription: Use when you have a spec or requirements for a multi-step task, before touching code\n---\n\n# Writing Plans\n</skill>"}]}}`,
        String.raw`{"timestamp":"2026-06-13T01:00:03.500Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"sed -n '1,240p' /tmp/skills/test-driven-development/SKILL.md\"}"}}`,
        String.raw`{"timestamp":"2026-06-13T01:00:03.999Z","type":"response_item","payload":{"type":"function_call","name":"functions.exec_command","arguments":"{\"cmd\":\"pwd\"}"}}`,
        '{"timestamp":"2026-06-13T01:00:04.987Z","type":"event_msg","payload":{"type":"token_count","info":{"input_tokens":10,"output_tokens":5,"cached_input_tokens":2}}}',
      ],
    )

    const result = runCodexHook(JSON.stringify({ transcript_path: transcriptPath }), {
      HOME: tmpDir,
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('INGEST_RAW_OK')
    expect(readCaptured()).toMatchObject({
      sessionId: CODEX_UUID,
      agentName: 'codex',
      project: '~/codex-project',
      startedAt: Date.parse('2026-06-13T01:00:00.123Z'),
      endedAt: Date.parse('2026-06-13T01:00:04.987Z'),
      durationMs: 4864,
      turns: 1,
      tokensInput: 10,
      tokensOutput: 5,
      tokensCached: 2,
      summary: 'hello codex',
      summarySource: 'first_message',
      tools: [
        { toolName: 'exec_command', callCount: 1 },
        { toolName: 'functions.exec_command', callCount: 1 },
      ],
      skills: ['superpowers:writing-plans', 'test-driven-development'],
      model: 'gpt-5.5',
    })
  })

  it('finds Codex transcript by session_id and falls back to Node parser when jq is unavailable', () => {
    const transcriptPath = writeTranscript(
      path.join(tmpDir, '.codex', 'sessions', '2026', '06', '13'),
      'codex-session-002',
      CODEX_LINES,
    )
    const fakeJq = path.join(tmpDir, 'jq')
    writeFileSync(fakeJq, '#!/bin/bash\nexit 1\n')
    chmodSync(fakeJq, 0o755)

    const result = runCodexHook(JSON.stringify({ session_id: 'codex-session-002' }), {
      PATH: `${tmpDir}:${process.env.PATH}`,
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('INGEST_SLOW_OK')
    expect(readCaptured()).toEqual({
      args: [
        '--session-id',
        'codex-session-002',
        '--transcript-path',
        transcriptPath,
        '--agent-name',
        'codex',
      ],
    })
  })
})
