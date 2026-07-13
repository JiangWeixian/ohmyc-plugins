// OpenCode plugin for OhMyC Timeline — captures session lifecycle
// events (turns, tokens, tools, skills) and writes them to a shared
// SQLite database at ~/.config/ohmyc/timeline.db.
import { appendFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Database } from 'bun:sqlite'

import { createWriter } from '@ohmyc/timeline'
import { CURRENT_SCHEMA_VERSION, SCHEMA_SQL } from '@ohmyc/timeline'

import type { Plugin } from '@opencode-ai/plugin'
import type { ParsedSessionData } from '@ohmyc/timeline/ingest'

const LOG_FILE = path.join(os.tmpdir(), 'timeline-plugin.log')

function log(level: string, message: string, extra?: Record<string, unknown>): void {
  const entry = `[${new Date().toISOString()}] [${level}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}\n`
  try {
    appendFileSync(LOG_FILE, entry)
  } catch {
    console.log(entry)
  }
}

function getDbPath(): string {
  const home = process.env.OHMYC_HOME || path.join(os.homedir(), '.config', 'ohmyc')
  return path.join(home, 'timeline.db')
}

function ensureDb(): Database {
  const dbPath = getDbPath()
  mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  ensureSchema(db)
  return db
}

function ensureSchema(db: Database): void {
  // Inline migration: if the sessions table already exists, check
  // whether it has the agent_name column (added in schema v3) and
  // add it if missing. This avoids a separate migration framework.
  const hasSessions = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get()
  if (hasSessions) {
    const hasAgentName = db.query('PRAGMA table_info(sessions)').all()
      .some((col: any) => col.name === 'agent_name')
    if (!hasAgentName) {
      db.exec('ALTER TABLE sessions ADD COLUMN agent_name TEXT;')
    }
    return
  }

  db.exec(SCHEMA_SQL)
  db.query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(CURRENT_SCHEMA_VERSION))
}

interface MessageSnapshot {
  sessionId: string
  messageId: string
  role: 'user' | 'assistant'
  createdAt: number
  model: string | null
  tokens: { input: number; output: number; cached: number }
}

interface TextPartSnapshot {
  sessionId: string
  partId: string
  messageId: string
  text: string
  synthetic: boolean
  ignored: boolean
}

interface ToolCallSnapshot {
  sessionId: string
  callId: string
  toolName: string
  args: Record<string, unknown>
  messageId: string | null
  partId: string | null
}

// Mutable state accumulated across events for a single session.
// Converted to ParsedSessionData and flushed to SQLite on session.idle.
interface SessionAccumulator {
  sessionId: string
  project: string
  startedAt: number
  endedAt: number
  title: string | null
  sessionModel: string | null
  messages: Map<string, MessageSnapshot>
  textParts: Map<string, TextPartSnapshot>
  toolCalls: Map<string, ToolCallSnapshot>
  toolPartIndex: Map<string, string>
  tools: Map<string, number>
  skills: Set<string>
  dirty: boolean
  persisted: boolean
  hydrated: boolean
}

// Mirrors OpenCode session/session.ts isDefaultTitle() for generated root/child titles.
const defaultTitlePattern = /^(?:New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function isDefaultSessionTitle(title: string | null | undefined): boolean {
  return !title?.trim() || defaultTitlePattern.test(title)
}

function keyed(sessionId: string, id: string): string {
  return `${sessionId}:${id}`
}

// Creates a fresh accumulator for a session. Exported for testing.
export function createAccumulator(sessionId: string, project = 'unknown'): SessionAccumulator {
  const now = Date.now()
  return {
    sessionId,
    project,
    startedAt: now,
    endedAt: now,
    title: null,
    sessionModel: null,
    messages: new Map(),
    textParts: new Map(),
    toolCalls: new Map(),
    toolPartIndex: new Map(),
    tools: new Map(),
    skills: new Set(),
    dirty: false,
    persisted: false,
    hydrated: false,
  }
}

function getProjectName(input: { project?: { worktree?: string }; directory?: string }): string {
  if (input.project?.worktree) {
    return path.basename(input.project.worktree)
  }
  if (input.directory) {
    return path.basename(input.directory)
  }
  return 'unknown'
}

function toParsedSessionData(acc: SessionAccumulator): ParsedSessionData {
  const messages = [...acc.messages.values()]
  const userMessages = messages.filter((message) => message.role === 'user')
  const assistantMessages = messages.filter((message) => message.role === 'assistant')
  const firstRootUser = userMessages
    .filter((message) => message.sessionId === acc.sessionId)
    .sort((a, b) => a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId))[0]
  const firstText = [...acc.textParts.values()]
    .filter((part) => part.sessionId === acc.sessionId && part.messageId === firstRootUser?.messageId)
    .filter((part) => !part.synthetic && !part.ignored && part.text.trim())
    .sort((a, b) => a.partId.localeCompare(b.partId))[0]?.text.trim()
  const explicitTitle = isDefaultSessionTitle(acc.title) ? null : acc.title!.trim()
  const summary = explicitTitle ?? firstText ?? '(untitled session)'
  const tokensInput = assistantMessages.reduce((sum, message) => sum + message.tokens.input, 0)
  const tokensOutput = assistantMessages.reduce((sum, message) => sum + message.tokens.output, 0)
  const tokensCached = assistantMessages.reduce((sum, message) => sum + message.tokens.cached, 0)
  const latestAssistant = assistantMessages
    .sort((a, b) => a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId))
    .at(-1)

  return {
    sessionId: acc.sessionId,
    project: acc.project,
    agentName: 'opencode',
    startedAt: acc.startedAt,
    endedAt: acc.endedAt,
    durationMs: acc.endedAt - acc.startedAt,
    turns: userMessages.length,
    tokensInput,
    tokensOutput,
    tokensCached,
    summary,
    summarySource: explicitTitle || !firstText ? 'auto' : 'first_message',
    transcriptPath: `opencode://${acc.sessionId}`,
    fileSize: 0,
    tools: [...acc.tools.entries()].map(([toolName, callCount]) => ({ toolName, callCount })),
    skills: [...acc.skills],
    model: latestAssistant?.model ?? acc.sessionModel,
  }
}

function getEventSessionID(event: any): string | undefined {
  const properties = event.properties
  return properties?.sessionID
    ?? properties?.info?.sessionID
    ?? properties?.info?.session_id
    ?? properties?.part?.sessionID
    ?? properties?.part?.session_id
    ?? properties?.info?.id
}

// Dependencies injected into createEventHandler. Exported for testing.
export interface EventHandlerDeps {
  project: string // directory basename of the active project
  writer: ReturnType<typeof createWriter> // SQLite session writer
  log: typeof log // logging function
}

// Creates the event handler and tool hooks for a single project.
// Maintains an in-memory map of active sessions, flushing each to
// SQLite when the session goes idle or is deleted. Exported for testing.
export function createEventHandler(deps: EventHandlerDeps) {
  const sessions = new Map<string, SessionAccumulator>()
  // Maps subagent sessionID → parent sessionID. Populated from
  // session.created events where info.parentID is present.
  const childToParent = new Map<string, string>()

  // Resolves a sessionID to its root parent accumulator. Subagent
  // sessions are transparently redirected so their tools, tokens and
  // turns merge into the parent session instead of creating a row.
  function getAccumulator(sessionId: string): SessionAccumulator {
    const parentId = childToParent.get(sessionId)
    const targetId = parentId ?? sessionId
    let acc = sessions.get(targetId)
    if (!acc) {
      acc = createAccumulator(targetId, deps.project)
      sessions.set(targetId, acc)
    }
    return acc
  }

  // Checks whether a sessionID belongs to a subagent (has a parent).
  function isChild(sessionId: string): boolean {
    return childToParent.has(sessionId)
  }

  return {
    sessions,
    childToParent,

    handler: async ({ event }: { event: any }) => {
      try {
        switch (event.type) {
          case 'session.created':
          case 'session.updated': {
            const sessionID = getEventSessionID(event)
            if (sessionID) {
              const parentID = event.type === 'session.created'
                ? event.properties?.info?.parentID as string | undefined
                : undefined
              if (parentID) {
                childToParent.set(sessionID, parentID)
                deps.log('debug', 'Subagent session detected', { sessionID, parentID })
              }
              const acc = getAccumulator(sessionID)
              const info = event.properties?.info
              if (info?.title !== undefined) acc.title = String(info.title)
              if (info?.time?.created !== undefined) acc.startedAt = Number(info.time.created)
              if (info?.time?.updated !== undefined) acc.endedAt = Number(info.time.updated)
              if (info?.model?.id) acc.sessionModel = String(info.model.id)
              acc.dirty = true
            }
            break
          }

          case 'session.idle': {
            const sessionID = getEventSessionID(event)
            if (sessionID) {
              // Subagent idle: merge is already done (getAccumulator
              // redirected to parent). Just clean up the mapping.
              if (isChild(sessionID)) {
                childToParent.delete(sessionID)
                return
              }
              const acc = sessions.get(sessionID)
              if (!acc) {
                return
              }
              acc.endedAt = Date.now()
              const data = toParsedSessionData(acc)
              try {
                deps.writer.writeSession(data)
                sessions.delete(sessionID)
              } catch (writeError) {
                deps.log('error', 'Failed to write session on idle', {
                  sessionID,
                  error: writeError instanceof Error ? writeError.message : String(writeError),
                })
              }
            }
            break
          }

          case 'session.deleted': {
            const sessionID = getEventSessionID(event)
            if (sessionID) {
              if (isChild(sessionID)) {
                childToParent.delete(sessionID)
                return
              }
              const acc = sessions.get(sessionID)
              if (acc) {
                acc.endedAt = Date.now()
                deps.writer.writeSession(toParsedSessionData(acc))
                sessions.delete(sessionID)
              }
            }
            break
          }

          case 'session.error': {
            const sessionID = getEventSessionID(event)
            if (sessionID) {
              if (isChild(sessionID)) {
                childToParent.delete(sessionID)
                return
              }
              const acc = sessions.get(sessionID)
              if (acc) {
                acc.endedAt = Date.now()
                deps.writer.writeSession(toParsedSessionData(acc))
              }
            }
            break
          }

          case 'message.updated': {
            // OpenCode sends message metadata under either .info or
            // .message depending on the event variant — accept both.
            const info = event.properties?.info || event.properties?.message
            const sessionID = getEventSessionID(event)
            if (info && sessionID && (info.role === 'user' || info.role === 'assistant') && info.id !== undefined) {
              const cache = info.tokens?.cache
              const snapshot: MessageSnapshot = {
                sessionId: sessionID,
                messageId: String(info.id),
                role: info.role,
                createdAt: Number(info.time?.created ?? Date.now()),
                model: info.modelID ? String(info.modelID) : null,
                tokens: {
                  input: Number(info.tokens?.input ?? 0),
                  output: Number(info.tokens?.output ?? 0),
                  cached: Number(cache?.read ?? 0) + Number(cache?.write ?? 0),
                },
              }
              const acc = getAccumulator(sessionID)
              acc.messages.set(keyed(sessionID, snapshot.messageId), snapshot)
              acc.dirty = true
            }
            break
          }

          case 'message.part.updated': {
            const part = event.properties?.part
            const sessionID = getEventSessionID(event)
            if (part && part.type === 'text' && sessionID && part.id !== undefined && part.messageID !== undefined) {
              const snapshot: TextPartSnapshot = {
                sessionId: sessionID,
                partId: String(part.id),
                messageId: String(part.messageID),
                text: String(part.text ?? ''),
                synthetic: Boolean(part.synthetic),
                ignored: Boolean(part.ignored),
              }
              const acc = getAccumulator(sessionID)
              acc.textParts.set(keyed(sessionID, snapshot.partId), snapshot)
              acc.dirty = true
            }
            break
          }
        }
      } catch (error) {
        deps.log('error', 'Event handler error', { error: error instanceof Error ? error.message : String(error) })
      }
    },

    toolExecuteBefore: async (hookInput: { sessionID: string; tool: string }) => {
      try {
        const acc = getAccumulator(hookInput.sessionID)
        acc.tools.set(hookInput.tool, (acc.tools.get(hookInput.tool) || 0) + 1)
      } catch (error) {
        deps.log('error', 'Tool execute error', { error: error instanceof Error ? error.message : String(error) })
      }
    },

    toolExecuteAfter: async (hookInput: { sessionID: string; tool: string; args: any }) => {
      try {
        // Both "Skill" and "skill" are valid depending on the agent
        // version — check both to avoid missing skill invocations.
        if (hookInput.tool === 'Skill' || hookInput.tool === 'skill') {
          const acc = getAccumulator(hookInput.sessionID)
          const args = hookInput.args
          if (args && typeof args === 'object' && typeof args.name === 'string') {
            acc.skills.add(args.name)
          }
        }
      } catch (error) {
        deps.log('error', 'Tool execute error', { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}

// OpenCode plugin entry point. Initializes the SQLite database and
// returns event + tool hooks that the OpenCode runtime calls.
export const TimelinePlugin: Plugin = async (input) => {
  const project = getProjectName(input)

  let db: Database | undefined
  let writer: ReturnType<typeof createWriter> | undefined

  try {
    db = ensureDb()
    writer = createWriter(db)
  } catch (error) {
    // Return empty hooks on DB failure — the plugin is non-essential and
    // should not crash the OpenCode host process.
    log('error', 'Database init failed', { error: error instanceof Error ? error.message : String(error) })
    return {}
  }

  const { handler, toolExecuteBefore, toolExecuteAfter } = createEventHandler({ project, writer: writer!, log })

  return {
    event: handler,
    'tool.execute.before': toolExecuteBefore,
    'tool.execute.after': toolExecuteAfter,
  }
}

export default TimelinePlugin
