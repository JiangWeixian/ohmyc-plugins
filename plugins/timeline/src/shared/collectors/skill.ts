import path from 'node:path'

export function skillFromReadPaths(input: unknown, output: unknown, cwd?: string): string | undefined {
  if (typeof input !== 'string' || !input.trim()
    || typeof output !== 'string' || !path.isAbsolute(output)) return undefined
  if (!path.isAbsolute(input) && (!cwd || !path.isAbsolute(cwd))) return undefined
  const requested = path.resolve(cwd ?? '/', input)
  if (requested !== path.normalize(output) || path.basename(requested) !== 'SKILL.md') return undefined
  const skill = path.basename(path.dirname(requested))
  return skill || undefined
}
