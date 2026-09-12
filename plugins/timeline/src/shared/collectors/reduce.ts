import type { ParsedSessionData } from '@ohmyc/timeline/schema'
import { sessionKey } from './identity'
import type { CollectorEvent, CollectorState, Usage } from './types'

function eventTime(event: CollectorEvent): number {
  return event.sourceAt ?? event.observedAt
}

function hasText(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function validUsage(usage: Usage | undefined): usage is Usage {
  return usage !== undefined
    && [usage.input, usage.output, usage.cached]
      .every(value => Number.isFinite(value) && value >= 0)
}

function rootEvent(event: CollectorEvent): boolean {
  return event.sourceSessionId === undefined
}

export function reduceEvents(
  state: CollectorState | null,
  events: readonly CollectorEvent[],
): CollectorState {
  if (!state && events.length === 0) throw new Error('empty collector batch')
  const first = state ?? events[0]
  const next: CollectorState = {
    version: 1,
    agent: first.agent,
    nativeSessionId: first.nativeSessionId,
    events: { ...(state?.events ?? {}) },
  }

  for (const event of events) {
    if (event.agent !== next.agent || event.nativeSessionId !== next.nativeSessionId) {
      throw new Error('mixed collector sessions')
    }
    const prior = next.events[event.eventId]
    if (!prior || event.observedAt < prior.observedAt) next.events[event.eventId] = event
  }
  return next
}

export function toSnapshot(state: CollectorState): ParsedSessionData | null {
  const events = Object.values(state.events)
    .filter(event => !event.unresolvedParent)
    .sort((a, b) => eventTime(a) - eventTime(b) || a.eventId.localeCompare(b.eventId))
  if (events.length === 0) return null

  const prompts = new Map<string, string>()
  const confirmed = new Set<string>()
  const toolCalls = new Map<string, CollectorEvent['tool']>()
  const skills = new Set<string>()
  let hasActivity = false

  for (const event of events) {
    if (rootEvent(event) && event.turnId && hasText(event.prompt)) {
      prompts.set(event.turnId, event.prompt)
    }
    if (rootEvent(event) && event.turnId && event.confirmsTurn) confirmed.add(event.turnId)
    if (event.confirmsTurn || event.tool || event.usage) hasActivity = true
    if (event.tool) {
      const source = event.sourceSessionId ?? event.nativeSessionId
      const key = JSON.stringify([source, event.turnId ?? '', event.tool.id])
      if (!toolCalls.has(key)) toolCalls.set(key, event.tool)
      if (hasText(event.tool.skill)) skills.add(event.tool.skill)
    }
  }

  const confirmedPrompts = [...prompts]
    .filter(([turnId]) => confirmed.has(turnId))
    .map(([, prompt]) => prompt)
  if (!hasActivity && confirmedPrompts.length === 0) return null

  const rootEvents = events.filter(rootEvent)
  const latestText = (select: (event: CollectorEvent) => string | undefined): string | undefined => {
    let value: string | undefined
    for (const event of rootEvents) {
      const candidate = select(event)
      if (hasText(candidate)) value = candidate
    }
    return value
  }

  let usage: Usage | undefined
  for (const event of rootEvents) {
    if (validUsage(event.usage)) usage = event.usage
  }

  const toolCounts = new Map<string, number>()
  for (const tool of toolCalls.values()) {
    if (!tool) continue
    toolCounts.set(tool.name, (toolCounts.get(tool.name) ?? 0) + 1)
  }

  const title = latestText(event => event.title)
  const firstPrompt = confirmedPrompts[0]?.slice(0, 140)
  const summary = title ?? firstPrompt ?? '(untitled session)'
  const firstTime = eventTime(events[0])
  const lastTime = eventTime(events.at(-1)!)

  return {
    sessionId: sessionKey(state.agent, state.nativeSessionId),
    project: latestText(event => event.project) ?? '',
    agentName: state.agent,
    startedAt: firstTime,
    endedAt: lastTime,
    durationMs: Math.max(0, lastTime - firstTime),
    turns: confirmedPrompts.length,
    tokensInput: usage?.input ?? 0,
    tokensOutput: usage?.output ?? 0,
    tokensCached: usage?.cached ?? 0,
    tokenStatus: usage?.status ?? 'unavailable',
    summary,
    summarySource: title || !firstPrompt ? 'auto' : 'first_message',
    transcriptPath: latestText(event => event.transcriptPath) ?? `${state.agent}://${state.nativeSessionId}`,
    fileSize: [...rootEvents].reverse().find(event => event.fileSize !== undefined)?.fileSize ?? 0,
    tools: [...toolCounts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([toolName, callCount]) => ({ toolName, callCount })),
    skills: [...skills].sort((a, b) => a.localeCompare(b)),
    model: latestText(event => event.model) ?? null,
  }
}
