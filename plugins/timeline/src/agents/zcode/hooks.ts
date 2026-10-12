import { readFile } from 'node:fs/promises'
import { eventKey } from '../../shared/collectors/identity'
import { skillFromReadPaths } from '../../shared/collectors/skill'
import type { CollectorEvent } from '../../shared/collectors/types'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

async function transcriptPrompt(file: string | undefined): Promise<string | undefined> {
  if (!file) return undefined
  try {
    const raw = await readFile(file, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const message = object(object(JSON.parse(line))?.message)
      if (message?.role !== 'user' || !Array.isArray(message.content)) continue
      const prompt = message.content.map(block => {
        const data = object(block)
        return data?.type === 'text' ? text(data.text) ?? '' : ''
      }).join('\n')
      if (prompt.trim()) return prompt
    }
  } catch {
    return undefined
  }
  return undefined
}

export async function parseZcodeHook(input: unknown, observedAt: number): Promise<CollectorEvent[]> {
  const data = object(input)
  const id = text(data?.sessionId)
  const hook = text(data?.hookEventName)
  if (!data || !id || !hook || !Number.isFinite(observedAt)
    || (data.session_id !== undefined && data.session_id !== id)
    || (data.hook_event_name !== undefined && data.hook_event_name !== hook)) return []
  const nativeTime = typeof data.timestamp === 'string' ? Date.parse(data.timestamp) : NaN
  const base = {
    version: 1 as const,
    agent: 'zcode' as const,
    nativeSessionId: id,
    project: text(data.cwd),
    ...(Number.isFinite(nativeTime) ? { sourceAt: nativeTime } : {}),
  }
  const makeEvent = (facts: Partial<CollectorEvent>): CollectorEvent => {
    const semantic = { ...base, ...facts }
    return { ...semantic, eventId: eventKey(semantic), observedAt }
  }
  if (hook === 'SessionStart') {
    return [makeEvent({ model: text(data.model), rootSession: true })]
  }
  const turnId = text(data.turnId)
  if (!turnId) return []
  if (hook === 'UserPromptSubmit') {
    const prompt = text(data.prompt)
      ?? await transcriptPrompt(text(data.transcriptPath) ?? text(data.transcript_path))
    return prompt ? [makeEvent({ turnId, prompt: prompt.slice(0, 140) })] : []
  }
  if (hook === 'Stop') return [makeEvent({ turnId, confirmsTurn: true })]
  if (hook !== 'PostToolUse' && hook !== 'PostToolUseFailure') return []
  const toolId = text(data.toolCallId)
  const name = text(data.toolName)
  if (!toolId || !name) return []
  let skill: string | undefined
  if (hook === 'PostToolUse' && data.error === undefined && data.toolResponse !== undefined) {
    const args = object(data.toolInput)
    if (name === 'Skill') skill = text(args?.skill)
    const requested = text(args?.file_path)
    const cwd = text(data.cwd)
    if (name === 'Read') skill = skillFromReadPaths(requested, object(data.toolResponse)?.filePath, cwd)
  }
  return [
    makeEvent({ turnId, confirmsTurn: true }),
    makeEvent({ tool: { id: toolId, name, ...(skill ? { skill } : {}) } }),
  ]
}
