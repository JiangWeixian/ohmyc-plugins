import { skillFromReadPaths } from '../../shared/collectors/skill'

type Payload = Record<string, unknown>

function object(value: unknown): Payload | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Payload : undefined
}

export function grokReadSkill(
  name: string,
  input: unknown,
  output: unknown,
  succeeded: boolean,
  cwd?: string,
): string | undefined {
  if (!succeeded || name !== 'read_file') return undefined
  const result = object(output)
  const content = object(result?.FileContent)
  if (result?.type !== 'ReadFile' || 'FileNotFound' in result
    || result.is_error === true || result.isError === true
    || typeof content?.content !== 'string') return undefined
  return skillFromReadPaths(object(input)?.target_file, content.absolute_path, cwd)
}

export function grokAttachedSkills(history: string): string[] {
  const skills = new Set<string>()
  for (const line of history.split('\n')) {
    if (!line.includes('<skills_referenced>')) continue
    let row: ReturnType<typeof object>
    try { row = object(JSON.parse(line)) } catch { continue }
    if (row?.type !== 'user' || !Array.isArray(row.content)) continue
    for (const block of row.content) {
      const value = object(block)
      if (value?.type !== 'text' || typeof value.text !== 'string') continue
      const references = /^<user_query>\r?\n[\s\S]*?\r?\n<\/user_query>\r?\n<skill_information>\r?\n<skills_referenced>\r?\n([\s\S]*?)\r?\n<\/skills_referenced>/.exec(value.text)
      if (!references) continue
      for (const match of references[1].matchAll(/^<skill name="([^"\r\n]+)" path="[^"\r\n]+\/SKILL\.md"\s*\/>$/gm)) {
        skills.add(match[1])
      }
    }
  }
  return [...skills]
}
