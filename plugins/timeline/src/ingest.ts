#!/usr/bin/env node
// Timeline plugin ingest entry - Claude Code Stop-hook hot path.
// Replaces `ohmyc dashboard --ingest` and `--ingest-raw`.

import { closeDatabase, openDatabase } from '@ohmyc/timeline'
import { parseTranscript } from '@ohmyc/timeline/ingest'
import { createWriter } from '@ohmyc/timeline/writer'
import { cac } from 'cac'

import type { ParsedSessionData } from '@ohmyc/timeline/schema'

const cli = cac('ohmyc-timeline-ingest')

cli
  .command('', 'Ingest a single session into the timeline DB')
  .option('--session-id <id>', 'Session UUID (disk-path mode)')
  .option('--transcript-path <path>', 'Path to JSONL transcript (disk-path mode)')
  .option('--agent-name <name>', 'Agent name for disk-path mode', { default: 'claude' })
  .option('--raw', 'Read pre-parsed ParsedSessionData JSON from stdin')
  .action(async (options: {
    sessionId?: string
    transcriptPath?: string
    agentName?: string
    raw?: boolean
  }) => {
    if (options.raw) {
      await runRawMode()
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
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) {
    console.error('error: --raw expects JSON on stdin')
    process.exit(1)
  }
  let data: ParsedSessionData
  try {
    data = JSON.parse(raw) as ParsedSessionData
  } catch (parseError) {
    console.error(`error: invalid JSON on stdin: ${parseError instanceof Error ? parseError.message : String(parseError)}`)
    process.exit(1)
  }
  const db = openDatabase()
  try {
    createWriter(db).writeSession(data)
  } finally {
    closeDatabase(db)
  }
}
