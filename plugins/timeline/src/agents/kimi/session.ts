import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { CollectorEvent } from '../../shared/collectors/types'
import { kimiEvent, kimiSkill, object, text, turnId } from './hooks'

function time(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function parseKimiWire(raw: string, id: string, observedAt: number, cwd?: string, since?: number): CollectorEvent[] {
  const records: Record<string, unknown>[] = []
  let partial = false
  for (const source of raw.split('\n')) {
    if (!source.trim()) continue
    try {
      const data = object(JSON.parse(source))
      if (!data) partial = true
      else records.push(data)
    } catch {
      partial = true
    }
  }
  const metadata = records[0]
  if (metadata?.type !== 'metadata' || !['1.0', '1.1', '1.2', '1.3', '1.4', '1.5'].includes(String(metadata.protocol_version))) return []
  const events: CollectorEvent[] = [kimiEvent(id, observedAt, { sourceAt: since ?? time(metadata.created_at), rootSession: true })]
  const calls = new Map<string, { name: string; args: unknown }>()
  let project = cwd
  let model: string | undefined
  let lastAt = since ?? time(metadata.created_at) ?? observedAt
  let input = 0
  let cached = 0
  let output = 0
  let usages = 0
  for (const data of records.slice(1)) {
    if (data.agentId !== undefined && data.agentId !== 'main') continue
    const sourceAt = time(data.time)
    lastAt = Math.max(lastAt, sourceAt ?? 0)
    if (data.type === 'config.update') {
      project = text(data.cwd) ?? project
      model = text(data.model) ?? model
    }
    if (since !== undefined && data.type !== 'config.update'
      && (sourceAt === undefined || sourceAt < since)) continue
    if (data.type === 'turn.prompt') {
      const nativeTurn = turnId(data.turnId)
      const origin = object(data.origin)
      const prompt = Array.isArray(data.input) ? data.input.map(part => {
        const value = object(part)
        return value?.type === 'text' ? text(value.text) ?? '' : ''
      }).join('') : ''
      if (origin?.kind === 'user' && nativeTurn !== undefined && prompt.trim()) {
        events.push(kimiEvent(id, observedAt, { sourceAt, turnId: nativeTurn, prompt: prompt.slice(0, 140), confirmsTurn: true }, { fullPrompt: prompt }))
      }
    }
    if (data.type === 'context.append_loop_event') {
      const native = object(data.event)
      const callId = text(native?.toolCallId)
      const name = text(native?.name)
      if (native?.type === 'tool.call' && callId && name) calls.set(callId, { name, args: native.args })
      if (native?.type === 'tool.result' && callId) {
        const call = calls.get(callId)
        const result = object(native.result)
        if (call && result) {
          const skill = kimiSkill(call.name, call.args, result.isError !== true && result.truncated !== true, project)
          events.push(kimiEvent(id, observedAt, { sourceAt, tool: { id: callId, name: call.name, ...(skill ? { skill } : {}) } }))
        }
      }
    }
    if (data.type === 'usage.record') {
      const usage = object(data.usage)
      const values = [usage?.inputOther, usage?.inputCacheCreation, usage?.inputCacheRead, usage?.output]
      if (!values.every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) {
        partial = true
        continue
      }
      input += (usage!.inputOther as number) + (usage!.inputCacheCreation as number)
      cached += usage!.inputCacheRead as number
      output += usage!.output as number
      usages += 1
      model = text(data.model) ?? model
    }
  }
  events.push(kimiEvent(id, observedAt, {
    sourceAt: lastAt, project, model,
    usage: usages > 0 ? { input, cached, output, status: partial ? 'partial' : 'complete' } : undefined,
  }))
  return events
}

async function stableRead(file: string): Promise<{ raw: string; size: number; mtimeMs: number } | null> {
  try {
    const before = await stat(file)
    if (!before.isFile()) return null
    const raw = await readFile(file, 'utf8')
    const after = await stat(file)
    return before.size === after.size && before.mtimeMs === after.mtimeMs
      ? { raw, size: after.size, mtimeMs: after.mtimeMs } : null
  } catch {
    return null
  }
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export async function hydrateKimi(events: readonly CollectorEvent[], home: string): Promise<CollectorEvent[]> {
  const id = events[0]?.nativeSessionId
  if (!id || !events.some(event => event.needsHydration)) return []
  const index = await stableRead(path.join(home, 'session_index.jsonl'))
  if (!index) return []
  let entry: Record<string, unknown> | undefined
  for (const line of index.raw.split('\n')) {
    try {
      const value = object(JSON.parse(line))
      if (value?.sessionId === id) entry = value
    } catch {}
  }
  const directory = text(entry?.sessionDir)
  if (!directory || !path.isAbsolute(directory) || path.basename(directory) !== id) return []
  const sessionsRoot = await realpath(path.join(home, 'sessions')).catch(() => '')
  const actualDirectory = await realpath(directory).catch(() => '')
  if (!sessionsRoot || !actualDirectory || !inside(sessionsRoot, actualDirectory)) return []
  const wirePath = path.join(actualDirectory, 'agents/main/wire.jsonl')
  const statePath = path.join(actualDirectory, 'state.json')
  const actualWire = await realpath(wirePath).catch(() => '')
  const actualState = await realpath(statePath).catch(() => '')
  if (!inside(actualDirectory, actualWire) || !inside(actualDirectory, actualState)) return []
  const [wire, state] = await Promise.all([stableRead(actualWire), stableRead(actualState)])
  if (!wire || !state) return []
  let metadata: Record<string, unknown> | undefined
  try { metadata = object(JSON.parse(state.raw)) } catch { return [] }
  if (!metadata) return []
  if (metadata.id !== undefined && metadata.id !== id) return []
  const since = metadata.forkedFrom ? time(metadata.createdAt) : undefined
  if (metadata.forkedFrom && since === undefined) return []
  const observedAt = Math.max(...events.map(event => event.observedAt))
  const parsed = parseKimiWire(wire.raw, id, observedAt, text(entry?.workDir), since)
  if (parsed.length === 0) return []
  const after = await stat(actualWire).catch(() => null)
  if (!after || after.size !== wire.size || after.mtimeMs !== wire.mtimeMs) return []
  const stateAfter = await stat(actualState).catch(() => null)
  if (!stateAfter || stateAfter.size !== state.size || stateAfter.mtimeMs !== state.mtimeMs) return []
  const enriched = parsed.map((event, index) => {
    if (index !== parsed.length - 1) return event
    const { eventId: _eventId, observedAt: _observedAt, ...facts } = event
    const agents = object(metadata.agents)
    const hasChildren = agents && Object.keys(agents).some(agent => agent !== 'main')
    return kimiEvent(id, observedAt, {
      ...facts, sourceAt: Math.max(event.sourceAt ?? 0, wire.mtimeMs),
      title: text(metadata.title), transcriptPath: actualWire, fileSize: wire.size,
      usage: event.usage ? { ...event.usage, status: hasChildren && event.usage.status === 'complete' ? 'partial' : event.usage.status } : undefined,
    })
  })
  for (const original of events.filter(event => event.needsHydration && !event.resolvesEventId)) {
    const { eventId, observedAt: _observedAt, ...facts } = original
    enriched.push(kimiEvent(id, observedAt, { ...facts, sourceAt: original.sourceAt ?? original.observedAt, needsHydration: false, resolvesEventId: eventId }))
  }
  return enriched
}
