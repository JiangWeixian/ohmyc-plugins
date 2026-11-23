import { readFileSync } from 'node:fs'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function codexReadSkills(transcriptPath: string): string[] {
  let raw: string
  try { raw = readFileSync(transcriptPath, 'utf8') } catch { return [] }
  const skills = new Set<string>()
  for (const line of raw.split('\n')) {
    if (!line.includes('"item_completed"')) continue
    let row: ReturnType<typeof object>
    try { row = object(JSON.parse(line)) } catch { continue }
    const payload = object(row?.payload)
    if (row?.type !== 'event_msg' || payload?.type !== 'item_completed') continue
    const item = object(payload.item)
    if (item?.type !== 'CommandExecution' || item.status !== 'completed' || item.exit_code !== 0
      || !Array.isArray(item.parsed_cmd)) continue
    for (const command of item.parsed_cmd) {
      const read = object(command)
      if (read?.type !== 'read' || typeof read.path !== 'string') continue
      const match = /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/.exec(read.path)
      if (match) skills.add(match[1])
    }
  }
  return [...skills]
}
