import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { eventKey } from '../../shared/collectors/identity'
import type { CollectorEvent, Usage } from '../../shared/collectors/types'

type Payload = Record<string, unknown>
type SemanticEvent = Omit<CollectorEvent, 'eventId' | 'observedAt'>

type StableFile = {
  path: string
  raw: string
  size: number
  mtimeMs: number
}

type Summary = {
  id: string
  project?: string
  title?: string
  model?: string
  updatedAt?: number
  kind: string
  directory: string
  fileSize: number
  mtimeMs: number
  parentId?: string
}

function object(value: unknown): Payload | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Payload
    : null
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
    && Number.isInteger(value) && value >= 0
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function event(semantic: SemanticEvent, observedAt: number): CollectorEvent {
  return { ...semantic, eventId: eventKey(semantic), observedAt }
}

function withoutIdentity(source: CollectorEvent): SemanticEvent {
  const { eventId: _eventId, observedAt: _observedAt, ...semantic } = source
  return semantic
}

export function parseGrokUsage(input: unknown, nativeSessionId: string): Usage | null {
  const payload = object(input)
  const session = object(payload?.session)
  if (text(payload?.sessionId) !== nativeSessionId || !session) return null
  const inputTokens = session.inputTokens
  const outputTokens = session.outputTokens
  const cachedReadTokens = session.cachedReadTokens
  const incomplete = session.usageIsIncomplete
  if (!nonnegativeInteger(inputTokens)
    || !nonnegativeInteger(outputTokens)
    || !nonnegativeInteger(cachedReadTokens)
    || (incomplete !== undefined && incomplete !== true && incomplete !== false)
    || cachedReadTokens > inputTokens) return null
  // On-disk inputTokens include cached reads. totalTokens is input plus output.
  return {
    input: inputTokens - cachedReadTokens,
    output: outputTokens,
    cached: cachedReadTokens,
    status: incomplete === true ? 'partial' : 'complete',
  }
}

async function stableRead(filePath: string): Promise<StableFile | null> {
  try {
    const before = await stat(filePath)
    if (!before.isFile()) return null
    const raw = await readFile(filePath, 'utf8')
    const after = await stat(filePath)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return null
    return { path: filePath, raw, size: after.size, mtimeMs: after.mtimeMs }
  } catch {
    return null
  }
}

function parseSummary(file: StableFile, expectedId: string): Summary | null {
  let payload: Payload | null
  try {
    payload = object(JSON.parse(file.raw))
  } catch {
    return null
  }
  const info = object(payload?.info)
  if (text(info?.id) !== expectedId) return null
  if (payload?.chat_format_version !== 1) {
    console.warn('[timeline] unsupported Grok chat format')
    return null
  }
  return {
    id: expectedId,
    project: text(info?.cwd),
    title: text(payload?.generated_title) ?? text(payload?.session_summary),
    model: text(payload?.current_model_id),
    updatedAt: timestamp(payload?.updated_at),
    kind: text(payload?.session_kind) ?? '',
    directory: path.dirname(file.path),
    fileSize: file.size,
    mtimeMs: file.mtimeMs,
    parentId: text(payload?.parent_session_id),
  }
}

async function directoriesNamed(root: string, expectedId: string): Promise<string[]> {
  const found: string[] = []
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectPath = path.join(root, project.name)
    if (project.name === expectedId) found.push(projectPath)
    let sessions
    try {
      sessions = await readdir(projectPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (session.isDirectory() && session.name === expectedId) {
        found.push(path.join(projectPath, session.name))
      }
    }
  }
  return [...new Set(found)]
}

async function locateSummary(
  events: readonly CollectorEvent[],
  grokHome: string,
  expectedId: string,
): Promise<Summary | null> {
  const candidates: string[] = []
  for (const transcriptPath of events.map(item => item.transcriptPath)) {
    if (transcriptPath) candidates.push(path.dirname(transcriptPath))
  }
  candidates.push(...await directoriesNamed(path.join(grokHome, 'sessions'), expectedId))
  for (const directory of [...new Set(candidates)]) {
    const file = await stableRead(path.join(directory, 'summary.json'))
    if (!file) continue
    const summary = parseSummary(file, expectedId)
    if (summary) return summary
  }
  return null
}

async function readUsage(summary: Summary): Promise<{
  usage: Usage
  sourceAt?: number
  fileSize: number
} | null> {
  const file = await stableRead(path.join(summary.directory, 'usage.json'))
  if (!file) return null
  let payload: unknown
  try {
    payload = JSON.parse(file.raw)
  } catch {
    return null
  }
  const usage = parseGrokUsage(payload, summary.id)
  if (!usage) return null
  const summaryAfter = await stat(path.join(summary.directory, 'summary.json')).catch(() => null)
  if (!summaryAfter
    || summaryAfter.size !== summary.fileSize
    || summaryAfter.mtimeMs !== summary.mtimeMs) return null
  return {
    usage,
    sourceAt: timestamp(object(payload)?.updatedAt),
    fileSize: file.size,
  }
}

function isSubagentKind(kind: string): boolean {
  return kind === 'subagent' || kind === 'subagent_fork'
}

async function findParent(
  child: Summary,
  grokHome: string,
): Promise<Summary | null> {
  // An explicit non-child kind never attaches. A missing kind still uses the
  // parent id or subagent meta, because current summaries omit session_kind.
  if (child.kind !== '' && !isSubagentKind(child.kind)) return null
  const sessionsRoot = path.join(grokHome, 'sessions')
  if (child.parentId) {
    for (const directory of await directoriesNamed(sessionsRoot, child.parentId)) {
      const summaryFile = await stableRead(path.join(directory, 'summary.json'))
      if (!summaryFile) continue
      const parent = parseSummary(summaryFile, child.parentId)
      if (parent) return parent
    }
  }
  let projects
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return null
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectPath = path.join(sessionsRoot, project.name)
    let parents
    try {
      parents = await readdir(projectPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const parent of parents) {
      if (!parent.isDirectory()) continue
      const parentDirectory = path.join(projectPath, parent.name)
      const metaFile = await stableRead(path.join(
        parentDirectory, 'subagents', child.id, 'meta.json',
      ))
      if (!metaFile) continue
      let meta: Payload | null
      try {
        meta = object(JSON.parse(metaFile.raw))
      } catch {
        continue
      }
      const parentId = text(meta?.parent_session_id)
      if (!parentId
        || text(meta?.child_session_id) !== child.id
        || text(meta?.subagent_id) !== child.id) continue
      const summaryFile = await stableRead(path.join(parentDirectory, 'summary.json'))
      if (!summaryFile) continue
      const parentSummary = parseSummary(summaryFile, parentId)
      if (parentSummary && parentSummary.directory === parentDirectory) return parentSummary
    }
  }
  return null
}

function metadataEvent(
  summary: Summary,
  usage: Awaited<ReturnType<typeof readUsage>>,
  exemplar: CollectorEvent,
): CollectorEvent {
  return event({
    version: 1,
    agent: 'grok',
    nativeSessionId: summary.id,
    rootSession: true,
    project: summary.project,
    title: summary.title,
    model: summary.model,
    transcriptPath: path.join(summary.directory, 'chat_history.jsonl'),
    fileSize: summary.fileSize + (usage?.fileSize ?? 0),
    sourceAt: usage?.sourceAt ?? summary.updatedAt,
    usage: usage?.usage,
  }, exemplar.observedAt)
}

function uniqueRequests(events: readonly CollectorEvent[]): CollectorEvent[] {
  const requests = new Map<string, CollectorEvent>()
  for (const item of events) {
    if (item.needsHydration === true && !item.resolvesEventId) requests.set(item.eventId, item)
  }
  return [...requests.values()]
}

export async function hydrateGrok(
  events: readonly CollectorEvent[],
  grokHome: string,
): Promise<readonly CollectorEvent[]> {
  const grokEvents = events.filter(item => item.agent === 'grok')
  if (grokEvents.length === 0) return []
  if (new Set(grokEvents.map(item => item.nativeSessionId)).size > 1) {
    throw new Error('mixed Grok hydration sessions')
  }
  const exemplar = grokEvents[0]
  const requests = uniqueRequests(grokEvents)
  if (requests.length === 0) return []
  const summary = await locateSummary(grokEvents, grokHome, exemplar.nativeSessionId)
  if (!summary) return []

  if (requests.some(item => item.unresolvedParent)) {
    const parent = await findParent(summary, grokHome)
    if (!parent) return []
    return requests.map(request => event({
      ...withoutIdentity(request),
      nativeSessionId: parent.id,
      sourceSessionId: request.nativeSessionId,
      project: parent.project,
      model: parent.model,
      title: parent.title,
      rootSession: undefined,
      unresolvedParent: false,
      needsHydration: false,
      resolvesEventId: request.eventId,
      usage: undefined,
      prompt: undefined,
    }, request.observedAt))
  }

  const usage = await readUsage(summary)
  const output: CollectorEvent[] = [metadataEvent(summary, usage, exemplar)]
  if (!usage || usage.usage.status === 'partial') return output
  for (const request of requests) {
    if (request.turnId && request.sourceAt !== undefined
      && usage.sourceAt !== undefined && usage.sourceAt < request.sourceAt) continue
    output.push(event({
      ...withoutIdentity(request),
      project: summary.project,
      model: summary.model,
      title: summary.title,
      transcriptPath: path.join(summary.directory, 'chat_history.jsonl'),
      rootSession: true,
      unresolvedParent: false,
      needsHydration: false,
      resolvesEventId: request.eventId,
    }, request.observedAt))
  }
  return output
}
