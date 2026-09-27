import { expect, it } from 'vitest'
import { collectClaudeUsage } from '../../../src/compat/claude-usage'

it('deduplicates snapshots and sums all request cache buckets', () => {
  const row = (id: string, output: number) => ({ type: 'assistant', message: {
    id, role: 'assistant', usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 },
  } })
  expect(collectClaudeUsage([row('a', 1), row('a', 5), row('b', 3)]))
    .toEqual({ tokensInput: 20, tokensOutput: 8, tokensCached: 100 })
})
