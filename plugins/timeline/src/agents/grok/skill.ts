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
