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
// Converted to ParsedSessionData and checkpointed on lifecycle events.
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
  legacySkills: Set<string>
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
    legacySkills: new Set(),
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
  const toolCounts = new Map<string, number>()
  const skills = new Set(acc.legacySkills)

  for (const call of acc.toolCalls.values()) {
    toolCounts.set(call.toolName, (toolCounts.get(call.toolName) ?? 0) + 1)
    if ((call.toolName === 'Skill' || call.toolName === 'skill') && typeof call.args.name === 'string') {
      skills.add(call.args.name)
    }
  }

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
    tools: [...toolCounts.entries()].map(([toolName, callCount]) => ({ toolName, callCount })),
    skills: [...skills],
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
  loadSessionTree?: (sessionID: string) => Promise<unknown>
}

// Creates the event handler and tool hooks for a single project.
// Maintains an in-memory map of active sessions, flushing each to
// SQLite when the session goes idle or is deleted. Exported for testing.
export function createEventHandler(deps: EventHandlerDeps) {
  const sessions = new Map<string, SessionAccumulator>()
  // Maps subagent sessionID → parent sessionID. Populated from
  // session.created events where info.parentID is present.
  const childToParent = new Map<string, string>()
  const rootSessionIds = new Set<string>()
  const queues = new Map<string, Promise<void>>()
  let legacyCallCount = 0

  function enqueue(rootId: string, work: () => Promise<void>): Promise<void> {
    const previous = queues.get(rootId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(work)
    queues.set(rootId, current)
    return current.finally(() => {
      if (queues.get(rootId) === current) queues.delete(rootId)
    })
  }

  function canCheckpoint(acc: SessionAccumulator): boolean {
    if (!rootSessionIds.has(acc.sessionId)) {
      deps.log('warn', 'Skipped non-root OpenCode checkpoint', { sessionID: acc.sessionId })
      return false
    }
    return true
  }

  async function checkpoint(acc: SessionAccumulator): Promise<void> {
    if (!canCheckpoint(acc)) return
    acc.endedAt = Date.now()
    try {
      deps.writer.writeSession(toParsedSessionData(acc))
      acc.persisted = true
      acc.dirty = false
    } catch (error) {
      acc.dirty = true
      deps.log('error', 'Failed to write OpenCode checkpoint', {
        sessionID: acc.sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  function getRootSessionID(sessionID: string): string {
    let rootID = sessionID
    const visited = new Set<string>()

    while (childToParent.has(rootID) && !visited.has(rootID)) {
      visited.add(rootID)
      rootID = childToParent.get(rootID)!
    }

    return rootID
  }

  // Resolves a sessionID to its root parent accumulator. Subagent
  // sessions are transparently redirected so their tools, tokens and
  // turns merge into the parent session instead of creating a row.
  function getAccumulator(sessionId: string): SessionAccumulator {
    const targetId = getRootSessionID(sessionId)
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

  function putToolCall(acc: SessionAccumulator, value: ToolCallSnapshot): void {
    const callKey = keyed(value.sessionId, value.callId)
    acc.toolCalls.set(callKey, { ...acc.toolCalls.get(callKey), ...value })
    if (value.partId) acc.toolPartIndex.set(keyed(value.sessionId, value.partId), callKey)
    acc.dirty = true
  }

  function getArgs(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  }

  async function tryHydratingUnknownSession(sessionID: string, acc: SessionAccumulator): Promise<void> {
    if (rootSessionIds.has(acc.sessionId) || acc.hydrated || !deps.loadSessionTree) return

    try {
      await deps.loadSessionTree(sessionID)
    } catch (error) {
      deps.log('warn', 'OpenCode session hydration failed', {
        sessionID,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function recordToolCall(
    hookInput: { sessionID: string; tool: string; callID?: string; args?: unknown },
    args: Record<string, unknown>,
  ): Promise<void> {
    const rootID = getRootSessionID(hookInput.sessionID)
    await enqueue(rootID, async () => {
      const acc = getAccumulator(hookInput.sessionID)
      await tryHydratingUnknownSession(hookInput.sessionID, acc)
      const callID = typeof hookInput.callID === 'string' && hookInput.callID
        ? hookInput.callID
        : `legacy-${++legacyCallCount}`
      const existing = acc.toolCalls.get(keyed(hookInput.sessionID, callID))
      putToolCall(acc, {
        sessionId: hookInput.sessionID,
        callId: callID,
        toolName: hookInput.tool,
        args,
        messageId: existing?.messageId ?? null,
        partId: existing?.partId ?? null,
      })
    })
  }

  return {
    sessions,
    childToParent,

    handler: ({ event }: { event: any }) => {
      const sessionID = getEventSessionID(event)
      if (!sessionID) return Promise.resolve()

      const parentID = event.type === 'session.created'
        ? event.properties?.info?.parentID as string | undefined
        : undefined
      if (parentID) {
        const rootParentID = getRootSessionID(parentID)
        childToParent.set(sessionID, rootParentID)
        deps.log('debug', 'Subagent session detected', { sessionID, parentID: rootParentID })
      }
      const rootId = getRootSessionID(sessionID)

      return enqueue(rootId, async () => {
        try {
          const acc = getAccumulator(sessionID)
          const isNewRoot = event.type === 'session.created' && !parentID
          if (isNewRoot) {
            rootSessionIds.add(sessionID)
            acc.hydrated = true
          } else {
            await tryHydratingUnknownSession(sessionID, acc)
          }

          switch (event.type) {
            case 'session.created':
            case 'session.updated': {
              const info = event.properties?.info
              const titleChanged = info?.title !== undefined
                && String(info.title) !== acc.title
                && !isDefaultSessionTitle(String(info.title))
              if (info?.title !== undefined) acc.title = String(info.title)
              if (info?.time?.created !== undefined) acc.startedAt = Number(info.time.created)
              if (info?.time?.updated !== undefined) acc.endedAt = Number(info.time.updated)
              if (info?.model?.id) acc.sessionModel = String(info.model.id)
              acc.dirty = true
              if (event.type === 'session.updated' && acc.persisted && titleChanged) {
                await checkpoint(acc)
              }
              break
            }

            case 'session.idle': {
              // Subagent state is already merged into the root accumulator.
              // Keep the mapping because the child can resume after idle.
              if (isChild(sessionID)) {
                return
              }
              const acc = sessions.get(sessionID)
              if (acc) await checkpoint(acc)
              break
            }

            case 'session.deleted': {
              if (isChild(sessionID)) {
                childToParent.delete(sessionID)
                return
              }
              const acc = sessions.get(sessionID)
              if (acc) {
                await checkpoint(acc)
                if (!acc.dirty) sessions.delete(sessionID)
              }
              for (const [childID, rootID] of childToParent) {
                if (rootID === sessionID) childToParent.delete(childID)
              }
              rootSessionIds.delete(sessionID)
              break
            }

            case 'session.error': {
              if (isChild(sessionID)) {
                return
              }
              const acc = sessions.get(sessionID)
              if (acc) await checkpoint(acc)
              break
            }

            case 'message.updated': {
              // OpenCode sends message metadata under either .info or
              // .message depending on the event variant — accept both.
              const info = event.properties?.info || event.properties?.message
              if (info && (info.role === 'user' || info.role === 'assistant') && info.id !== undefined) {
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
                acc.messages.set(keyed(sessionID, snapshot.messageId), snapshot)
                acc.dirty = true
              }
              break
            }

            case 'message.part.updated': {
              const part = event.properties?.part
              if (part && part.type === 'text' && part.id !== undefined && part.messageID !== undefined) {
                const snapshot: TextPartSnapshot = {
                  sessionId: sessionID,
                  partId: String(part.id),
                  messageId: String(part.messageID),
                  text: String(part.text ?? ''),
                  synthetic: Boolean(part.synthetic),
                  ignored: Boolean(part.ignored),
                }
                acc.textParts.set(keyed(sessionID, snapshot.partId), snapshot)
                acc.dirty = true
              } else if (part && part.type === 'tool' && part.id !== undefined && part.callID !== undefined && part.tool !== undefined) {
                putToolCall(acc, {
                  sessionId: sessionID,
                  callId: String(part.callID),
                  toolName: String(part.tool),
                  args: getArgs(part.state?.input),
                  messageId: part.messageID === undefined ? null : String(part.messageID),
                  partId: String(part.id),
                })
              }
              break
            }

            case 'message.part.removed': {
              const partID = event.properties?.partID
              if (partID === undefined) break

              const partKey = keyed(sessionID, String(partID))
              const callKey = acc.toolPartIndex.get(partKey)
              if (callKey) acc.toolCalls.delete(callKey)
              acc.toolPartIndex.delete(partKey)
              acc.textParts.delete(partKey)
              acc.dirty = true
              break
            }

            case 'message.removed': {
              const messageID = event.properties?.messageID
              if (messageID === undefined) break

              const normalizedMessageID = String(messageID)
              let removed = acc.messages.delete(keyed(sessionID, normalizedMessageID))
              for (const [partKey, part] of acc.textParts) {
                if (part.sessionId === sessionID && part.messageId === normalizedMessageID) {
                  acc.textParts.delete(partKey)
                  removed = true
                }
              }
              for (const [callKey, call] of acc.toolCalls) {
                if (call.sessionId === sessionID && call.messageId === normalizedMessageID) {
                  acc.toolCalls.delete(callKey)
                  if (call.partId) acc.toolPartIndex.delete(keyed(sessionID, call.partId))
                  removed = true
                }
              }
              if (removed) acc.dirty = true
              break
            }
          }
        } catch (error) {
          deps.log('error', 'Event handler error', { error: error instanceof Error ? error.message : String(error) })
        }
      })
    },

    toolExecuteBefore: async (
      hookInput: { sessionID: string; tool: string; callID?: string },
      hookOutput?: { args?: unknown },
    ) => {
      try {
        await recordToolCall(hookInput, getArgs(hookOutput?.args))
      } catch (error) {
        deps.log('error', 'Tool execute error', { error: error instanceof Error ? error.message : String(error) })
      }
    },

    toolExecuteAfter: async (
      hookInput: { sessionID: string; tool: string; callID?: string; args?: unknown },
      _hookOutput?: unknown,
    ) => {
      try {
        const args = getArgs(hookInput.args)
        if (typeof hookInput.callID === 'string' && hookInput.callID) {
          await recordToolCall(hookInput, args)
        } else if (hookInput.tool === 'Skill' || hookInput.tool === 'skill') {
          const rootID = getRootSessionID(hookInput.sessionID)
          await enqueue(rootID, async () => {
            const acc = getAccumulator(hookInput.sessionID)
            await tryHydratingUnknownSession(hookInput.sessionID, acc)
            if (typeof args.name === 'string') {
              acc.legacySkills.add(args.name)
              acc.dirty = true
            }
          })
        }
      } catch (error) {
        deps.log('error', 'Tool execute error', { error: error instanceof Error ? error.message : String(error) })
      }
    },

    dispose: async (): Promise<void> => {
      const pendingQueues = [...new Set(queues.values())]
      await Promise.allSettled(pendingQueues)
      const dirtyRoots = [...sessions.values()].filter((acc) => acc.dirty)
      await Promise.all(dirtyRoots.map((acc) => checkpoint(acc)))
      queues.clear()
      sessions.clear()
      childToParent.clear()
      rootSessionIds.clear()
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
