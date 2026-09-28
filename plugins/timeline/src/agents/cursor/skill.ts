import { skillFromReadPaths } from '../../shared/collectors/skill'

type Payload = Record<string, unknown>

function object(value: unknown): Payload | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Payload : undefined
}

export function cursorReadSkill(
  name: string,
  input: unknown,
  output: unknown,
  succeeded: boolean,
  cwd?: string,
): string | undefined {
  if (!succeeded || name !== 'Read') return undefined
  let result = output
  if (typeof result === 'string') {
    try { result = JSON.parse(result) } catch { return undefined }
  }
  const read = object(result)
  if (!read || read.is_error === true || read.isError === true) return undefined
  if (typeof read.content_length !== 'number' || !Number.isInteger(read.content_length)
    || read.content_length < 0) return undefined
  const requested = object(input)
  return skillFromReadPaths(requested?.file_path ?? requested?.path, read.file_path, cwd)
}
