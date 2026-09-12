#!/usr/bin/env node
// Timeline plugin ingest entry - Claude Code Stop-hook hot path.
// Replaces `ohmyc dashboard --ingest` and `--ingest-raw`.

import { closeDatabase, openDatabase } from '@ohmyc/timeline'
import { parseTranscript } from '@ohmyc/timeline/ingest'
import { createWriter } from '@ohmyc/timeline/writer'
import { cac } from 'cac'
import os from 'node:os'
import path from 'node:path'

import type { ParsedSessionData } from '@ohmyc/timeline/schema'
import { parseCursorHook } from './agents/cursor/hooks'
import { hydrateCursor } from './agents/cursor/transcript'
import { parseGrokHook } from './agents/grok/hooks'
import { hydrateGrok } from './agents/grok/session'
import { detectHost } from './shared/collectors/identity'
import { ingestEvents, replayPending } from './shared/collectors/ingest-event'
import type { CollectorEvent, Host } from './shared/collectors/types'

const cli = cac('ohmyc-timeline-ingest')

cli
  .command('', 'Ingest a single session into the timeline DB')
  .option('--session-id <id>', 'Session UUID (disk-path mode)')
  .option('--transcript-path <path>', 'Path to JSONL transcript (disk-path mode)')
  .option('--agent-name <name>', 'Agent name for disk-path mode', { default: 'claude' })
  .option('--raw', 'Read pre-parsed ParsedSessionData JSON from stdin')
  .option('--hook <host>', 'Read native cursor, grok, or auto hook JSON from stdin')
  .option('--replay-pending', 'Replay durable collector events')
  .option('--detect-host', 'Print cursor, grok, or legacy for hook JSON on stdin')
  .action(async (options: {
    sessionId?: string
    transcriptPath?: string
    agentName?: string
    raw?: boolean
    hook?: string
    replayPending?: boolean
    detectHost?: boolean
  }) => {
    if (options.detectHost) {
      if (options.raw || options.hook || options.replayPending || options.sessionId || options.transcriptPath) {
        fail('--detect-host cannot be combined with a write mode')
      }
      const input = await readJsonStdin('--detect-host')
      process.stdout.write(`${detectHost(input, process.env) ?? 'legacy'}\n`)
      return
    }
    const diskMode = options.sessionId !== undefined || options.transcriptPath !== undefined
    const writeModes = [options.raw, options.hook !== undefined, options.replayPending, diskMode]
      .filter(Boolean).length
    if (writeModes > 1) {
      fail('--hook, --raw, --replay-pending, and disk mode are mutually exclusive')
    }
    if (options.raw) {
      await runRawMode()
      return
    }
    if (options.hook !== undefined) {
      await runHookMode(options.hook)
      return
    }
    if (options.replayPending) {
      await runReplayMode()
      return
    }
    if (!options.sessionId || !options.transcriptPath) {
      console.error('error: --session-id and --transcript-path are required when --raw is not set')
      process.exit(1)
    }
    await runDiskMode(options.sessionId, options.transcriptPath, options.agentName ?? 'claude')
  })

cli.help()
cli.parse()

async function runDiskMode(sessionId: string, transcriptPath: string, agentName: string): Promise<void> {
  const db = openDatabase()
  try {
    const data = parseTranscript(sessionId, transcriptPath, { agentName })
    createWriter(db).writeSession(data)
  } finally {
    closeDatabase(db)
  }
}

async function runRawMode(): Promise<void> {
  const data = await readJsonStdin('--raw') as ParsedSessionData
  const db = openDatabase()
  try {
    createWriter(db).writeSession(data)
  } finally {
    closeDatabase(db)
  }
}

function fail(message: string): never {
  console.error(`error: ${message}`)
  process.exit(1)
}

async function readJsonStdin(mode: string): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) fail(`${mode} expects JSON on stdin`)
  try {
    return JSON.parse(raw)
  } catch (parseError) {
    fail(`invalid JSON on stdin: ${parseError instanceof Error ? parseError.message : String(parseError)}`)
  }
}

function collectorHome(): string {
  return process.env.OHMYC_HOME ?? path.join(os.homedir(), '.config', 'ohmyc')
}

function grokHome(): string {
  return process.env.GROK_HOME ?? path.join(os.homedir(), '.grok')
}

function hydrate(events: readonly CollectorEvent[]): Promise<readonly CollectorEvent[]> {
  const agent = events[0]?.agent
  if (agent === 'cursor') return hydrateCursor(events)
  if (agent === 'grok') return hydrateGrok(events, grokHome())
  return Promise.resolve([])
}

function parseHook(host: Host, input: unknown): CollectorEvent[] {
  const observedAt = Date.now()
  return host === 'cursor'
    ? parseCursorHook(input, observedAt)
    : parseGrokHook(input, observedAt)
}

async function withCollectorWriter(
  action: (write: ReturnType<typeof createWriter>['writeSession']) => Promise<void>,
): Promise<void> {
  let db: ReturnType<typeof openDatabase> | undefined
  let writer: ReturnType<typeof createWriter> | undefined
  try {
    await action(data => {
      db ??= openDatabase()
      writer ??= createWriter(db)
      return writer.writeSession(data)
    })
  } finally {
    if (db) closeDatabase(db)
  }
}

async function runHookMode(requestedHost: string): Promise<void> {
  if (!['cursor', 'grok', 'auto'].includes(requestedHost)) {
    fail('--hook must be cursor, grok, or auto')
  }
  const input = await readJsonStdin('--hook')
  const host = requestedHost === 'auto'
    ? detectHost(input, process.env)
    : requestedHost as Host
  if (!host) fail('unable to detect native hook host')
  const events = parseHook(host, input)
  if (events.length === 0) fail(`invalid ${host} hook payload`)
  await withCollectorWriter(async write => {
    await ingestEvents(events, { home: collectorHome(), hydrate, write })
  })
}

async function runReplayMode(): Promise<void> {
  await withCollectorWriter(async write => {
    await replayPending({ home: collectorHome(), hydrate, write })
  })
}
