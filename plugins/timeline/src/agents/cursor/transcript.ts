import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { eventKey } from '../../shared/collectors/identity'
import type { CollectorEvent } from '../../shared/collectors/types'

type Payload = Record<string, unknown>
type SemanticEvent = Omit<CollectorEvent, 'eventId' | 'observedAt'>

function object(value: unknown): Payload | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Payload
    : null
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => {
    const value = object(block)
    return value?.type === 'text' && typeof value.text === 'string' ? [value.text] : []
  }).join('\n')
}

function nativeUserQuery(value: string): string | undefined {
  const match = value.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/)
  const query = match?.[1]?.trim()
  return query ? query : undefined
}

function event(semantic: SemanticEvent, observedAt: number): CollectorEvent {
  return { ...semantic, eventId: eventKey(semantic), observedAt }
}

type TranscriptTurn = {
  prompt: string
  ordinal: number
  hasAssistantActivity: boolean
  tools: { id: string, name: string }[]
}

type Transcript = {
  turns: TranscriptTurn[]
  complete: boolean
  fileSize: number
}

async function readTranscript(transcriptPath: string): Promise<Transcript | null> {
  let info
  try {
    info = await stat(transcriptPath)
    if (!info.isFile()) return null
  } catch {
    return null
  }

  let raw: string
  try {
    raw = await readFile(transcriptPath, 'utf8')
  } catch {
    return null
  }

  const lines = raw.split('\n')
  const hasTrailingNewline = raw.endsWith('\n')
  if (hasTrailingNewline) lines.pop()
  let complete = true
  let warned = false
  const parsed: Payload[] = []
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue
    try {
      const value = object(JSON.parse(line))
      if (value) parsed.push(value)
    } catch {
      if (index === lines.length - 1 && !hasTrailingNewline) {
        complete = false
      } else if (!warned) {
        console.warn('[timeline] Cursor transcript contains an invalid JSONL line')
        warned = true
      }
    }
  }

  const occurrences = new Map<string, number>()
  const turns: TranscriptTurn[] = []
  let current: TranscriptTurn | undefined
  for (const row of parsed) {
    const role = typeof row.role === 'string' ? row.role : undefined
    const message = object(row.message)
    const content = contentText(message?.content)
    if (role === 'user') {
      const prompt = nativeUserQuery(content)
      if (!prompt) {
        current = undefined
        continue
      }
      const ordinal = occurrences.get(prompt) ?? 0
      occurrences.set(prompt, ordinal + 1)
      current = { prompt, ordinal, hasAssistantActivity: false, tools: [] }
      turns.push(current)
    } else if (role === 'assistant' && current) {
      const blocks = Array.isArray(message?.content) ? message.content : []
      const hasTool = blocks.some(block => object(block)?.type === 'tool_use')
      if (content.trim() || hasTool) current.hasAssistantActivity = true
      for (const block of blocks) {
        const tool = object(block)
        if (tool?.type === 'tool_use' && typeof tool.id === 'string' && tool.id.trim()
          && typeof tool.name === 'string' && tool.name.trim()) {
          current.tools.push({ id: tool.id, name: tool.name })
        }
      }
    }
  }
  return { turns, complete, fileSize: info.size }
}

function turnId(prompt: string, ordinal: number): string {
  const hash = createHash('sha256').update(prompt).digest('hex')
  return `transcript:${hash}:${ordinal}`
}

function withoutIdentity(source: CollectorEvent): SemanticEvent {
  const { eventId: _eventId, observedAt: _observedAt, ...semantic } = source
  return semantic
}

export async function hydrateCursor(
  events: readonly CollectorEvent[],
): Promise<readonly CollectorEvent[]> {
  const cursorEvents = events.filter(item => item.agent === 'cursor')
  if (cursorEvents.length === 0) return []
  if (new Set(cursorEvents.map(item => item.nativeSessionId)).size > 1) {
    throw new Error('mixed Cursor hydration sessions')
  }
  const output: CollectorEvent[] = []
  const rootProven = cursorEvents.some(item => item.rootSession === true)
  const reliableHookTurns = cursorEvents.some(item => item.turnId?.startsWith('transcript:') === false)
  const requests = cursorEvents.filter(item => item.needsHydration === true)
  const paths = [...new Set(requests.map(item => item.transcriptPath).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  ))]
  const loaded = new Map<string, Transcript>()
  for (const transcriptPath of paths) {
    const transcript = await readTranscript(transcriptPath)
    if (transcript) loaded.set(transcriptPath, transcript)
  }
  const unresolvedContext = cursorEvents.some(item => item.unresolvedParent) && !rootProven
  const observedAt = Math.min(...cursorEvents.map(item => item.observedAt))
  const exemplar = cursorEvents[0]
  const hookToolIds = new Set(cursorEvents.flatMap(item => item.tool ? [item.tool.id] : []))

  if (!reliableHookTurns) {
    const transcript = loaded.values().next().value as Transcript | undefined
    for (const turn of transcript?.turns ?? []) {
      if (!turn.hasAssistantActivity) continue
      const id = turnId(turn.prompt, turn.ordinal)
      const base: SemanticEvent = {
        version: 1,
        agent: 'cursor',
        nativeSessionId: exemplar.nativeSessionId,
        turnId: id,
        project: exemplar.project,
        model: exemplar.model,
        transcriptPath: exemplar.transcriptPath,
        unresolvedParent: unresolvedContext ? true : undefined,
      }
      output.push(event({ ...base, prompt: turn.prompt.slice(0, 140) }, observedAt))
      output.push(event({ ...base, confirmsTurn: true }, observedAt))
      for (const tool of turn.tools) {
        if (!hookToolIds.has(tool.id)) output.push(event({ ...base, tool }, observedAt))
      }
    }
  }

  if (loaded.size > 0) {
    const transcript = loaded.values().next().value as Transcript
    output.push(event({
      version: 1,
      agent: 'cursor',
      nativeSessionId: exemplar.nativeSessionId,
      project: exemplar.project,
      model: exemplar.model,
      transcriptPath: exemplar.transcriptPath,
      fileSize: transcript.fileSize,
      usage: { input: 0, output: 0, cached: 0, status: 'unavailable' },
      unresolvedParent: unresolvedContext ? true : undefined,
    }, observedAt))
  }

  for (const request of requests) {
    const transcript = request.transcriptPath ? loaded.get(request.transcriptPath) : undefined
    if (request.transcriptPath && !transcript?.complete) continue
    if (request.unresolvedParent && !rootProven) continue
    output.push(event({
      ...withoutIdentity(request),
      unresolvedParent: false,
      rootSession: request.rootSession ?? (rootProven ? true : undefined),
      needsHydration: false,
      resolvesEventId: request.eventId,
    }, request.observedAt))
  }

  for (const request of cursorEvents.filter(item => item.unresolvedParent && !item.needsHydration)) {
    if (!rootProven) continue
    output.push(event({
      ...withoutIdentity(request),
      unresolvedParent: false,
      rootSession: true,
      resolvesEventId: request.eventId,
    }, request.observedAt))
  }

  return output
}
