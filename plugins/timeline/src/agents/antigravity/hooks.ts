import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eventKey } from '../../shared/collectors/identity'
import { skillFromReadPaths } from '../../shared/collectors/skill'
import type { CollectorEvent } from '../../shared/collectors/types'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function isStepIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export async function parseAntigravityHook(input: unknown, observedAt: number): Promise<CollectorEvent[]> {
  const hook = object(input)
  const nativeSessionId = text(hook?.conversationId)
  if (!hook || !nativeSessionId) return []
  const workspace = Array.isArray(hook.workspacePaths) ? hook.workspacePaths.find(text) : undefined
  const base = {
    version: 1 as const,
    agent: 'antigravity' as const,
    nativeSessionId,
    project: text(workspace) ?? text(hook.cwd),
    model: text(hook.modelName),
  }
  const makeEvent = (facts: Partial<CollectorEvent>): CollectorEvent => {
    const event = { ...base, ...facts }
    return { ...event, eventId: eventKey(event), observedAt }
  }

  if (hook.hookEventName === 'PostToolUse') {
    const call = object(hook.toolCall)
    const name = text(call?.name)
    if (!name || !isStepIndex(hook.stepIdx)) return []
    const args = object(call?.args)
    const skill = !text(hook.error) && name === 'view_file' && args?.IsSkillFile === true
      ? skillFromReadPaths(args.AbsolutePath, args.AbsolutePath)
      : undefined
    return [makeEvent({ tool: { id: String(hook.stepIdx), name, skill } })]
  }

  if (hook.hookEventName !== 'Stop' || text(hook.terminationReason)?.toLowerCase() === 'error' || text(hook.error)) return []
  const suppliedPath = text(hook.transcriptPath)
  if (!suppliedPath) return []
  const transcriptPath = suppliedPath.startsWith('~/')
    ? path.join(os.homedir(), suppliedPath.slice(2))
    : suppliedPath
  if (!path.isAbsolute(transcriptPath)) return []
  const raw = await readFile(transcriptPath, 'utf8').catch(() => '')
  const events: CollectorEvent[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let step: Record<string, unknown> | undefined
    try { step = object(JSON.parse(line)) } catch { continue }
    if (step?.type !== 'USER_INPUT' || step.source !== 'USER_EXPLICIT' || step.status !== 'DONE') continue
    const prompt = text(step.content)
    if (!prompt || !isStepIndex(step.step_index)) continue
    const sourceAt = Date.parse(text(step.created_at) ?? '')
    events.push(makeEvent({
      turnId: String(step.step_index),
      prompt: prompt.slice(0, 140),
      confirmsTurn: true,
      ...(Number.isFinite(sourceAt) && sourceAt >= 0 ? { sourceAt } : {}),
    }))
  }
  const last = events.at(-1)
  if (!last) return []
  events.push(makeEvent({
    turnId: last.turnId,
    confirmsTurn: true,
    transcriptPath,
    fileSize: Buffer.byteLength(raw),
  }))
  return events
}
