import { closeDatabase, openDatabase } from '@ohmyc/timeline'
import { createWriter } from '@ohmyc/timeline/writer'
import { expect, it } from 'vitest'

it('the bundled writer preserves token completeness', () => {
  const db = openDatabase({ dbPath: ':memory:' })
  try {
    createWriter(db).writeSession({
      sessionId: 'cursor:c1', agentName: 'cursor', project: '/tmp/demo',
      startedAt: 1000, endedAt: 2000, durationMs: 1000, turns: 1,
      tokensInput: 0, tokensOutput: 0, tokensCached: 0,
      tokenStatus: 'unavailable', summary: 'hello', summarySource: 'first_message',
      transcriptPath: 'cursor://c1', fileSize: 0, tools: [], skills: [], model: null,
    })
    expect(db.prepare('SELECT token_status FROM sessions').get())
      .toEqual({ token_status: 'unavailable' })
  }
  finally {
    closeDatabase(db)
  }
})
