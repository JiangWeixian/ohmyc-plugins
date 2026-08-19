// OpenCode plugin for OhMyC Timeline — captures session lifecycle
// events (turns, tokens, tools, skills) and writes them to a shared
// SQLite database at ~/.config/ohmyc/timeline.db.
import { appendFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Database } from 'bun:sqlite'

import { createWriter } from '@ohmyc/timeline'
import { CURRENT_SCHEMA_VERSION, SCHEMA_SQL } from '@ohmyc/timeline'

import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import type { ParsedSessionData } from '@ohmyc/timeline/ingest'

const LOG_FILE = path.join(os.tmpdir(), 'timeline-plugin.log')

export interface HydratedSessionNode {
  info: Record<string, any>
  messages: Array<{ info: Record<string, any>; parts: Array<Record<string, any>> }>
  children: HydratedSessionNode[]
}

interface SdkResponse<T> {
  data?: T
  error?: unknown
}

export type OpenCodeSnapshotClient = {
  session: Pick<PluginInput['client']['session'], 'get' | 'messages' | 'children'>
}

export type LoadSessionTree = (sessionId: string) => Promise<HydratedSessionNode>

type SnapshotSessionApi = {
  get: (options: { path: { id: string }; url: '/session/{id}' }) => Promise<SdkResponse<Record<string, any>>>
  messages: (options: { path: { id: string }; url: '/session/{id}/message' }) => Promise<SdkResponse<HydratedSessionNode['messages']>>
  children: (options: { path: { id: string }; url: '/session/{id}/children' }) => Promise<SdkResponse<Array<Record<string, any>>>>
}

function responseData<T>(label: string, response: SdkResponse<T>): T {
  if (response.error || response.data === undefined) {
    throw new Error(`${label} failed: ${JSON.stringify(response.error ?? 'missing data')}`)
  }
  return response.data
}

export function createSessionTreeLoader(client: OpenCodeSnapshotClient): LoadSessionTree {
  const session = client.session as unknown as SnapshotSessionApi

  return async (observedSessionId) => {
    const nodes = new Map<string, Promise<HydratedSessionNode>>()

    function loadNode(sessionId: string, knownInfo?: Record<string, any>): Promise<HydratedSessionNode> {
      const existing = nodes.get(sessionId)
      if (existing) return existing

      const node = Promise.all([
        knownInfo
          ? Promise.resolve({ data: knownInfo })
          : session.get({ path: { id: sessionId }, url: '/session/{id}' }),
        session.messages({ path: { id: sessionId }, url: '/session/{id}/message' }),
        session.children({ path: { id: sessionId }, url: '/session/{id}/children' }),
      ]).then(async ([infoResponse, messagesResponse, childrenResponse]) => {
        const info = responseData<Record<string, any>>('session.get', infoResponse)
        const messages = responseData<HydratedSessionNode['messages']>('session.messages', messagesResponse)
        const childInfos = responseData<Array<Record<string, any>>>('session.children', childrenResponse)
        const children = await Promise.all(childInfos.map((child) => loadNode(String(child.id), child)))
        return { info, messages, children }
      })
      nodes.set(sessionId, node)
      void node.catch(() => {
        if (nodes.get(sessionId) === node) nodes.delete(sessionId)
      })
      return node
    }

    const observed = await loadNode(observedSessionId)
    if (!observed.info.parentID) return observed

    let rootInfo = observed.info
    while (rootInfo.parentID) {
      rootInfo = responseData<Record<string, any>>(
        'session.get',
        await session.get({ path: { id: String(rootInfo.parentID) }, url: '/session/{id}' }),
      )
    }
    return loadNode(String(rootInfo.id), rootInfo)
  }
}

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

type ToolCallKey = string | symbol
type SnapshotSource = 'hydrated' | 'live'
type RootMetadataField = 'title' | 'startedAt' | 'endedAt' | 'sessionModel'

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
  toolCalls: Map<ToolCallKey, ToolCallSnapshot>
  toolPartIndex: Map<string, ToolCallKey>
  taskHookAliases: Map<string, string>
  liveMessageKeys: Set<string>
  livePartKeys: Set<string>
  liveToolCallKeys: Set<ToolCallKey>
  messageTombstones: Set<string>
  partTombstones: Set<string>
  liveRootMetadataFields: Set<RootMetadataField>
  legacySkills: Set<string>
  dirty: boolean
  persisted: boolean
  checkpointPending: boolean
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
    taskHookAliases: new Map(),
    liveMessageKeys: new Set(),
    livePartKeys: new Set(),
    liveToolCallKeys: new Set(),
    messageTombstones: new Set(),
    partTombstones: new Set(),
    liveRootMetadataFields: new Set(),
    legacySkills: new Set(),
    dirty: false,
    persisted: false,
    checkpointPending: false,
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
  const rootUserMessages = userMessages
    .filter((message) => message.sessionId === acc.sessionId)
    .sort((a, b) => a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId))
  const firstText = rootUserMessages.flatMap((message) =>
    [...acc.textParts.values()]
      .filter((part) => part.sessionId === acc.sessionId && part.messageId === message.messageId)
      .filter((part) => !part.synthetic && !part.ignored && part.text.trim())
      .sort((a, b) => a.partId.localeCompare(b.partId))
      .map((part) => part.text.trim()),
  )[0]
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
  loadSessionTree: LoadSessionTree
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
  const hydrations = new Map<string, Promise<string>>()
  let routingTail: Promise<void> = Promise.resolve()
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

  async function checkpoint(acc: SessionAccumulator): Promise<boolean> {
    acc.checkpointPending = true
    if (!canCheckpoint(acc)) return false
    acc.endedAt = Date.now()
    try {
      deps.writer.writeSession(toParsedSessionData(acc))
      acc.persisted = true
      acc.dirty = false
      acc.checkpointPending = false
      return true
    } catch (error) {
      acc.dirty = true
      deps.log('error', 'Failed to write OpenCode checkpoint', {
        sessionID: acc.sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
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

  function putToolCall(
    acc: SessionAccumulator,
    value: ToolCallSnapshot,
    callKey: ToolCallKey = keyed(value.sessionId, value.callId),
    source: SnapshotSource = 'live',
  ): void {
    const partKey = value.partId ? keyed(value.sessionId, value.partId) : null
    if (source === 'hydrated' && (
      (partKey !== null && (acc.livePartKeys.has(partKey) || acc.partTombstones.has(partKey)))
      || (value.messageId !== null && acc.messageTombstones.has(keyed(value.sessionId, value.messageId)))
    )) return
    const existing = acc.toolCalls.get(callKey)
    if (source === 'hydrated' && acc.liveToolCallKeys.has(callKey) && existing) {
      const messageId = existing.messageId ?? value.messageId
      const partId = existing.partId ?? value.partId
      acc.toolCalls.set(callKey, { ...existing, messageId, partId })
      if (partId) acc.toolPartIndex.set(keyed(value.sessionId, partId), callKey)
      acc.dirty = true
      return
    }
    if (source === 'live') {
      acc.liveToolCallKeys.add(callKey)
      if (partKey !== null) acc.partTombstones.delete(partKey)
    }
    acc.toolCalls.set(callKey, { ...existing, ...value })
    if (partKey !== null) acc.toolPartIndex.set(partKey, callKey)
    acc.dirty = true
  }

  function isTaskTool(toolName: unknown): boolean {
    return typeof toolName === 'string' && toolName.toLowerCase() === 'task'
  }

  function reconcileTaskHookAlias(
    acc: SessionAccumulator,
    sessionID: string,
    part: { id: unknown; callID: unknown; tool: unknown; messageID?: unknown },
  ): Record<string, unknown> | undefined {
    const partId = String(part.id)
    const callId = String(part.callID)
    const partKey = keyed(sessionID, partId)
    const callKey = keyed(sessionID, callId)
    const alias = acc.toolCalls.get(partKey)
    const canonical = acc.toolCalls.get(callKey)

    if (
      partKey === callKey
      || !isTaskTool(part.tool)
      || (canonical && !isTaskTool(canonical.toolName))
      || (alias && isTaskTool(alias.toolName) && alias.partId !== null)
    ) return undefined

    if (alias && isTaskTool(alias.toolName)) {
      acc.toolCalls.delete(partKey)
      acc.liveToolCallKeys.delete(partKey)
      acc.toolCalls.set(callKey, {
        ...canonical,
        ...alias,
        callId,
        messageId: part.messageID === undefined ? null : String(part.messageID),
        partId,
      })
      acc.liveToolCallKeys.add(callKey)
    }

    acc.taskHookAliases.set(partKey, callKey)
    const existing = acc.toolCalls.get(callKey)
    return acc.liveToolCallKeys.has(callKey) ? existing?.args : undefined
  }

  function getArgs(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  }

  function putMessageSnapshot(
    acc: SessionAccumulator,
    sessionID: string,
    info: any,
    source: SnapshotSource = 'live',
  ): void {
    if (!info || (info.role !== 'user' && info.role !== 'assistant') || info.id === undefined) return

    const messageKey = keyed(sessionID, String(info.id))
    if (source === 'hydrated' && (acc.liveMessageKeys.has(messageKey) || acc.messageTombstones.has(messageKey))) return
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
    if (source === 'live') {
      acc.liveMessageKeys.add(messageKey)
      acc.messageTombstones.delete(messageKey)
    }
    acc.messages.set(messageKey, snapshot)
    acc.dirty = true
  }

  function putPartSnapshot(
    acc: SessionAccumulator,
    sessionID: string,
    part: any,
    source: SnapshotSource = 'live',
  ): void {
    if (part?.type === 'text' && part.id !== undefined && part.messageID !== undefined) {
      const partKey = keyed(sessionID, String(part.id))
      const messageKey = keyed(sessionID, String(part.messageID))
      if (source === 'hydrated' && (
        acc.livePartKeys.has(partKey)
        || acc.partTombstones.has(partKey)
        || acc.messageTombstones.has(messageKey)
      )) return
      const snapshot: TextPartSnapshot = {
        sessionId: sessionID,
        partId: String(part.id),
        messageId: String(part.messageID),
        text: String(part.text ?? ''),
        synthetic: Boolean(part.synthetic),
        ignored: Boolean(part.ignored),
      }
      if (source === 'live') {
        acc.livePartKeys.add(partKey)
        acc.partTombstones.delete(partKey)
      }
      acc.textParts.set(partKey, snapshot)
      acc.dirty = true
    } else if (part?.type === 'tool' && part.id !== undefined && part.callID !== undefined && part.tool !== undefined) {
      const partKey = keyed(sessionID, String(part.id))
      const messageKey = part.messageID === undefined ? null : keyed(sessionID, String(part.messageID))
      if (source === 'hydrated' && (
        acc.livePartKeys.has(partKey)
        || acc.partTombstones.has(partKey)
        || (messageKey !== null && acc.messageTombstones.has(messageKey))
      )) return
      if (source === 'live') {
        acc.livePartKeys.add(partKey)
        acc.partTombstones.delete(partKey)
      }
      const liveArgs = reconcileTaskHookAlias(acc, sessionID, part)
      putToolCall(acc, {
        sessionId: sessionID,
        callId: String(part.callID),
        toolName: String(part.tool),
        args: liveArgs ?? getArgs(part.state?.input),
        messageId: part.messageID === undefined ? null : String(part.messageID),
        partId: String(part.id),
      }, keyed(sessionID, String(part.callID)), source)
    }
  }

  function applyRootMetadata(
    acc: SessionAccumulator,
    info: Record<string, any>,
    source: SnapshotSource,
  ): void {
    function assign(field: RootMetadataField, value: string | number | null): void {
      if (source === 'hydrated' && acc.liveRootMetadataFields.has(field)) return
      if (field === 'title') acc.title = value as string
      else if (field === 'startedAt') acc.startedAt = value as number
      else if (field === 'endedAt') acc.endedAt = value as number
      else acc.sessionModel = value as string | null
      if (source === 'live') acc.liveRootMetadataFields.add(field)
    }

    if (info.title !== undefined) assign('title', String(info.title))
    if (info.time?.created !== undefined) assign('startedAt', Number(info.time.created))
    if (info.time?.updated !== undefined) assign('endedAt', Number(info.time.updated))
    if (info.model?.id) assign('sessionModel', String(info.model.id))
    else if (info.modelID) assign('sessionModel', String(info.modelID))
    acc.dirty = true
  }

  function collectHydratedNodes(tree: HydratedSessionNode): Array<{ sessionID: string; node: HydratedSessionNode }> {
    const nodes: Array<{ sessionID: string; node: HydratedSessionNode }> = []

    function visit(node: HydratedSessionNode): void {
      if (!node.info?.id) throw new Error('Hydrated OpenCode session is missing an ID')
      nodes.push({ sessionID: String(node.info.id), node })
      for (const child of node.children) visit(child)
    }

    visit(tree)
    return nodes
  }

  function mergeAccumulator(target: SessionAccumulator, source: SessionAccumulator): void {
    for (const [key, value] of source.messages) {
      if (!target.messages.has(key)) target.messages.set(key, value)
    }
    for (const [key, value] of source.textParts) {
      if (!target.textParts.has(key)) target.textParts.set(key, value)
    }
    for (const [key, value] of source.toolCalls) {
      if (!target.toolCalls.has(key)) target.toolCalls.set(key, value)
    }
    for (const [key, value] of source.toolPartIndex) {
      if (!target.toolPartIndex.has(key)) target.toolPartIndex.set(key, value)
    }
    for (const [key, value] of source.taskHookAliases) {
      target.taskHookAliases.set(key, value)
    }
    for (const key of source.liveMessageKeys) target.liveMessageKeys.add(key)
    for (const key of source.livePartKeys) target.livePartKeys.add(key)
    for (const key of source.liveToolCallKeys) target.liveToolCallKeys.add(key)
    for (const key of source.messageTombstones) target.messageTombstones.add(key)
    for (const key of source.partTombstones) target.partTombstones.add(key)
    for (const skill of source.legacySkills) target.legacySkills.add(skill)
    target.dirty ||= source.dirty
    target.persisted ||= source.persisted
    target.checkpointPending ||= source.checkpointPending
  }

  function clearSessionTombstones(acc: SessionAccumulator, sessionID: string): void {
    const prefix = `${sessionID}:`
    for (const key of acc.messageTombstones) {
      if (key.startsWith(prefix)) acc.messageTombstones.delete(key)
    }
    for (const key of acc.partTombstones) {
      if (key.startsWith(prefix)) acc.partTombstones.delete(key)
    }
  }

  function clearTaskHookAliases(acc: SessionAccumulator, sessionID: string): void {
    const prefix = `${sessionID}:`
    for (const key of acc.taskHookAliases.keys()) {
      if (key.startsWith(prefix)) acc.taskHookAliases.delete(key)
    }
  }

  function mergeHydratedTree(tree: HydratedSessionNode, observedSessionID: string): string {
    const nodes = collectHydratedNodes(tree)
    const rootSessionID = nodes[0].sessionID
    const acc = getAccumulator(rootSessionID)

    const migratedSessionIDs = new Set([...nodes.map(({ sessionID }) => sessionID), observedSessionID])
    for (const sessionID of migratedSessionIDs) {
      const source = sessions.get(sessionID)
      if (source && source !== acc) {
        mergeAccumulator(acc, source)
        sessions.delete(sessionID)
      }
    }
    for (const { sessionID } of nodes.slice(1)) childToParent.set(sessionID, rootSessionID)
    if (observedSessionID !== rootSessionID) childToParent.set(observedSessionID, rootSessionID)
    applyRootMetadata(acc, tree.info, 'hydrated')
    for (const { sessionID, node } of nodes) {
      for (const message of node.messages) putMessageSnapshot(acc, sessionID, message.info, 'hydrated')
    }
    for (const { sessionID, node } of nodes) {
      for (const message of node.messages) {
        for (const part of message.parts) putPartSnapshot(acc, sessionID, part, 'hydrated')
      }
    }
    acc.hydrated = true
    rootSessionIds.add(rootSessionID)
    return rootSessionID
  }

  function ensureRootRoute(sessionID: string): Promise<string> {
    const knownRoot = getRootSessionID(sessionID)
    if (rootSessionIds.has(knownRoot) || sessions.get(knownRoot)?.hydrated) {
      return Promise.resolve(knownRoot)
    }

    const existing = hydrations.get(sessionID)
    if (existing) return existing

    const hydration = deps.loadSessionTree(sessionID)
      .then((tree) => mergeHydratedTree(tree, sessionID))
      .catch((error) => {
        deps.log('warn', 'OpenCode session hydration failed', {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
        return getRootSessionID(sessionID)
      })
    hydrations.set(sessionID, hydration)
    void hydration.finally(() => {
      if (hydrations.get(sessionID) === hydration) hydrations.delete(sessionID)
    })
    return hydration
  }

  function routeAndEnqueue(sessionID: string, work: (rootID: string) => Promise<void>): Promise<void> {
    let queued: Promise<void> = Promise.resolve()
    const routed = routingTail.catch(() => undefined).then(async () => {
      const rootID = await ensureRootRoute(sessionID)
      queued = enqueue(rootID, () => work(rootID))
    })
    routingTail = routed.catch(() => undefined)
    return routed.then(() => queued)
  }

  async function recordToolCall(
    hookInput: { sessionID: string; tool: string; callID?: string; args?: unknown },
    args: Record<string, unknown>,
  ): Promise<void> {
    await routeAndEnqueue(hookInput.sessionID, async () => {
      const acc = getAccumulator(hookInput.sessionID)
      const realCallID = typeof hookInput.callID === 'string' && hookInput.callID
        ? hookInput.callID
        : null
      const directCallID = realCallID ?? `legacy-${++legacyCallCount}`
      const directCallKey = realCallID
        ? keyed(hookInput.sessionID, realCallID)
        : Symbol(`legacy-tool-call:${directCallID}`)
      const taskAlias = realCallID && isTaskTool(hookInput.tool)
        ? acc.taskHookAliases.get(keyed(hookInput.sessionID, realCallID))
        : undefined
      const callKey = taskAlias && acc.toolCalls.has(taskAlias) ? taskAlias : directCallKey
      const existing = acc.toolCalls.get(callKey)
      putToolCall(acc, {
        sessionId: hookInput.sessionID,
        callId: existing?.callId ?? directCallID,
        toolName: hookInput.tool,
        args,
        messageId: existing?.messageId ?? null,
        partId: existing?.partId ?? null,
      }, callKey)
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
      const isNewRoot = event.type === 'session.created' && !parentID
      if (isNewRoot) rootSessionIds.add(sessionID)

      return routeAndEnqueue(sessionID, async () => {
        try {
          const acc = getAccumulator(sessionID)
          if (isNewRoot) {
            acc.hydrated = true
          }

          switch (event.type) {
            case 'session.created':
            case 'session.updated': {
              const info = event.properties?.info
              let titleChanged = false
              if (!isChild(sessionID)) {
                titleChanged = info?.title !== undefined
                  && String(info.title) !== acc.title
                  && !isDefaultSessionTitle(String(info.title))
                if (info) applyRootMetadata(acc, info, 'live')
              }
              if (event.type === 'session.updated' && (
                acc.checkpointPending
                || (acc.persisted && titleChanged)
              )) {
                await checkpoint(acc)
              }
              break
            }

            case 'session.idle': {
              // Subagent state is already merged into the root accumulator.
              // Keep the mapping because the child can resume after idle.
              if (isChild(sessionID)) {
                if (acc.dirty || acc.checkpointPending) await checkpoint(acc)
                return
              }
              await checkpoint(acc)
              break
            }

            case 'session.deleted': {
              if (isChild(sessionID)) {
                clearSessionTombstones(acc, sessionID)
                clearTaskHookAliases(acc, sessionID)
                childToParent.delete(sessionID)
                return
              }
              const checkpointed = await checkpoint(acc)
              if (checkpointed) {
                clearTaskHookAliases(acc, sessionID)
                sessions.delete(sessionID)
                for (const [childID, rootID] of childToParent) {
                  if (rootID === sessionID) childToParent.delete(childID)
                }
                rootSessionIds.delete(sessionID)
              }
              break
            }

            case 'session.error': {
              if (isChild(sessionID)) {
                if (acc.dirty || acc.checkpointPending) await checkpoint(acc)
                return
              }
              await checkpoint(acc)
              break
            }

            case 'message.updated': {
              // OpenCode sends message metadata under either .info or
              // .message depending on the event variant — accept both.
              const info = event.properties?.info || event.properties?.message
              putMessageSnapshot(acc, sessionID, info)
              break
            }

            case 'message.part.updated': {
              const part = event.properties?.part
              putPartSnapshot(acc, sessionID, part)
              break
            }

            case 'message.part.removed': {
              const partID = event.properties?.partID
              if (partID === undefined) break

              const partKey = keyed(sessionID, String(partID))
              const callKey = acc.toolPartIndex.get(partKey)
              if (callKey) {
                acc.toolCalls.delete(callKey)
                acc.liveToolCallKeys.delete(callKey)
              }
              acc.taskHookAliases.delete(partKey)
              acc.toolPartIndex.delete(partKey)
              acc.textParts.delete(partKey)
              acc.livePartKeys.delete(partKey)
              acc.partTombstones.add(partKey)
              acc.dirty = true
              break
            }

            case 'message.removed': {
              const messageID = event.properties?.messageID
              if (messageID === undefined) break

              const normalizedMessageID = String(messageID)
              const messageKey = keyed(sessionID, normalizedMessageID)
              let removed = acc.messages.delete(messageKey)
              acc.liveMessageKeys.delete(messageKey)
              acc.messageTombstones.add(messageKey)
              for (const [partKey, part] of acc.textParts) {
                if (part.sessionId === sessionID && part.messageId === normalizedMessageID) {
                  acc.textParts.delete(partKey)
                  acc.livePartKeys.delete(partKey)
                  acc.partTombstones.add(partKey)
                  removed = true
                }
              }
              for (const [callKey, call] of acc.toolCalls) {
                if (call.sessionId === sessionID && call.messageId === normalizedMessageID) {
                  acc.toolCalls.delete(callKey)
                  acc.liveToolCallKeys.delete(callKey)
                  if (call.partId) {
                    const partKey = keyed(sessionID, call.partId)
                    acc.taskHookAliases.delete(partKey)
                    acc.toolPartIndex.delete(partKey)
                    acc.livePartKeys.delete(partKey)
                    acc.partTombstones.add(partKey)
                  }
                  removed = true
                }
              }
              acc.dirty = removed || acc.messageTombstones.has(messageKey)
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
          await routeAndEnqueue(hookInput.sessionID, async () => {
            const acc = getAccumulator(hookInput.sessionID)
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
      await routingTail.catch(() => undefined)
      const pendingQueues = [...new Set(queues.values())]
      await Promise.allSettled(pendingQueues)
      const dirtyRoots = [...sessions.values()].filter((acc) => acc.dirty)
      await Promise.all(dirtyRoots.map((acc) => checkpoint(acc)))
      for (const acc of sessions.values()) acc.taskHookAliases.clear()
      queues.clear()
      sessions.clear()
      childToParent.clear()
      rootSessionIds.clear()
      hydrations.clear()
    },
  }
}

export async function disposeTimelineRuntime(
  disposeRuntime: () => Promise<void>,
  close: () => void,
): Promise<void> {
  try {
    await disposeRuntime()
  } finally {
    close()
  }
}

export function createTimelineHooks(input: {
  project: string
  writer: ReturnType<typeof createWriter>
  client: Parameters<typeof createSessionTreeLoader>[0]
  close: () => void
}) {
  const runtime = createEventHandler({
    project: input.project,
    writer: input.writer,
    log,
    loadSessionTree: createSessionTreeLoader(input.client),
  })

  return {
    event: runtime.handler,
    'tool.execute.before': runtime.toolExecuteBefore,
    'tool.execute.after': runtime.toolExecuteAfter,
    dispose: () => disposeTimelineRuntime(runtime.dispose, input.close),
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

  return createTimelineHooks({
    project,
    writer: writer!,
    client: input.client,
    close: () => db?.close(),
  })
}

export default TimelinePlugin
