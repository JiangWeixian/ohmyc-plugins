// Compatibility copy of @ohmyc/timeline claude-usage until the pinned snapshot includes the fix.
/** Sum per-request Claude usage, retaining only the latest snapshot of each message.
 * Cache read/write are disjoint from input. Iterations replace top-level totals.
 */
export function collectClaudeUsage(records: Iterable<unknown>) {
  const messages = new Map<string, Record<string, unknown>>()
  let anonymous = 0
  for (const value of records) {
    const row = object(value)
    const message = object(row?.message)
    const usage = object(message?.usage)
    if (row?.type !== 'assistant' || message?.role !== 'assistant' || !usage) continue
    const id = typeof message.id === 'string' && message.id ? `id:${message.id}` : `row:${anonymous++}`
    messages.set(id, usage)
  }
  let tokensInput = 0
  let tokensOutput = 0
  let tokensCached = 0
  for (const usage of messages.values()) {
    const parts = Array.isArray(usage.iterations) && usage.iterations.length ? usage.iterations : [usage]
    for (const part of parts) {
      const item = object(part)
      tokensInput += count(item?.input_tokens)
      tokensOutput += count(item?.output_tokens)
      tokensCached += count(item?.cache_read_input_tokens) + count(item?.cache_creation_input_tokens)
    }
  }
  return { tokensInput, tokensOutput, tokensCached }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}
