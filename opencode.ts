// OpenCode plugin for OhMyC Timeline — captures session lifecycle
// events (turns, tokens, tools, skills) and writes them to a shared
// SQLite database at ~/.config/ohmyc/timeline.db.
import { appendFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { closeDatabase, createWriter, openDatabase } from '@ohmyc/timeline'
import type { NodeSqliteDatabase } from '@ohmyc/timeline'

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

// Mutable state accumulated across events for a single session.
// Converted to ParsedSessionData and flushed to SQLite on session.idle.
interface SessionAccumulator {
  sessionId: string
  project: string
  startedAt: number
  endedAt: number
  turns: number
  tokensInput: number
  tokensOutput: number
  tokensCached: number
  tools: Map<string, number> // tool name -> invocation count
  skills: Set<string>
  firstUserMessage: string | null
  summary: string | null
  model: string | null
}

// Creates a fresh accumulator for a session. Exported for testing.
export function createAccumulator(sessionId: string, project?: string): SessionAccumulator {
  return {
    sessionId,
    project: project ?? 'unknown',
    startedAt: Date.now(),
    endedAt: Date.now(),
    turns: 0,
    tokensInput: 0,
    tokensOutput: 0,
    tokensCached: 0,
    tools: new Map(),
    skills: new Set(),
    firstUserMessage: null,
    summary: null,
    model: null,
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
  return {
    sessionId: acc.sessionId,
    project: acc.project,
    agentName: 'opencode',
    startedAt: acc.startedAt,
    endedAt: acc.endedAt,
    durationMs: acc.endedAt - acc.startedAt,
    turns: acc.turns,
    tokensInput: acc.tokensInput,
    tokensOutput: acc.tokensOutput,
    tokensCached: acc.tokensCached,
    // Prefer explicit summary (e.g. from away_summary), then the
    // first user message, then a placeholder for empty sessions.
    summary: acc.summary ?? acc.firstUserMessage ?? '(untitled session)',
    summarySource: acc.firstUserMessage ? 'first_message' : 'auto',
    // OpenCode emits sessionID in two different shapes depending on
    // the event type — check both locations.
    transcriptPath: `opencode://${acc.sessionId}`,
    fileSize: 0,
    tools: [...acc.tools.entries()].map(([toolName, callCount]) => ({ toolName, callCount })),
    skills: [...acc.skills],
    model: acc.model,
  }
}

function getEventSessionID(event: any): string | undefined {
  // session.created puts the id at properties.info.id; all other
  // events use properties.sessionID.
  if (event.properties?.sessionID) {
    return event.properties.sessionID as string
  }
  if (event.properties?.info?.id) {
    return event.properties.info.id as string
  }
  return undefined
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
          case 'session.created': {
            const sessionID = getEventSessionID(event)
            if (sessionID) {
              const parentID = event.properties?.info?.parentID as string | undefined
              if (parentID) {
                childToParent.set(sessionID, parentID)
                deps.log('debug', 'Subagent session detected', { sessionID, parentID })
              }
              const acc = getAccumulator(sessionID)
              acc.startedAt = Math.min(acc.startedAt, Date.now())
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
            if (info) {
              // sessionID vs session_id: OpenCode versions differ on casing.
              const sessionID = info.sessionID || info.session_id
              if (sessionID) {
                const acc = getAccumulator(sessionID)

                if (info.role === 'user') {
                  acc.turns += 1
                }

                if (info.role === 'assistant' && info.tokens) {
                  acc.tokensInput += info.tokens.input || 0
                  acc.tokensOutput += info.tokens.output || 0
                  if (info.tokens.cache) {
                    acc.tokensCached += (info.tokens.cache.read || 0) + (info.tokens.cache.write || 0)
                  }
                }

                if (info.modelID) {
                  acc.model = info.modelID
                }
              }
            }
            break
          }

          case 'message.part.updated': {
            // Only capture non-synthetic, non-ignored text parts as the
            // user's first message (used as a fallback session summary).
            const part = event.properties?.part
            if (part && part.type === 'text' && !part.synthetic && !part.ignored) {
              const sessionID = part.sessionID || part.session_id
              if (sessionID && part.text?.trim()) {
                const acc = getAccumulator(sessionID)
                if (!acc.firstUserMessage) {
                  acc.firstUserMessage = part.text.trim()
                }
              }
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

  let db: NodeSqliteDatabase | undefined
  let writer: ReturnType<typeof createWriter> | undefined

  try {
    db = openDatabase()
    writer = createWriter(db)
  } catch (error) {
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
