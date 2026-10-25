import { describe, expect, it, vi } from 'vitest'
import TimelinePlugin from '../../../opencode'
import { createOpenCodeV2Runtime } from '../../../src/opencode/v2'

vi.mock('bun:sqlite', () => ({ Database: vi.fn() }))

describe('OpenCode v2 entrypoint', () => {
  it('exports the definition required by the v2 plugin loader', () => {
    expect(TimelinePlugin).toMatchObject({
      id: 'ohmyc.timeline',
      setup: expect.any(Function),
    })
  })
})

const user = (id: string, text: string) => ({ id, type: 'user', text, time: { created: 10 } })
const assistant = (id: string) => ({
  id, type: 'assistant', model: { providerID: 'test', id: 'test-model' },
  time: { created: 20, completed: 30 },
  tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 2 } },
  content: [{ type: 'tool', id: 'call-read', name: 'read', state: { status: 'completed', input: { path: 'a.ts' } } }],
})

function fixture(storage = new Map<string, any>()) {
  const infos: Record<string, any> = {
    root: { id: 'root', title: 'V2 session', location: { directory: '/workspace/project' }, time: { created: 1, updated: 30 } },
    child: { id: 'child', parentID: 'root', location: { directory: '/workspace/project' }, time: { created: 2, updated: 30 } },
  }
  const contexts: Record<string, any[]> = { root: [user('msg_1', 'First prompt'), assistant('msg_2')], child: [] }
  const ctx = {
    location: { directory: '/workspace/project' },
    session: {
      get: vi.fn(async ({ sessionID }) => { if (!infos[sessionID]) throw new Error('not found'); return infos[sessionID] }),
      context: vi.fn(async ({ sessionID }) => contexts[sessionID]),
    },
    storage: {
      get: async (key: string) => structuredClone(storage.get(key)),
      set: async (key: string, value: unknown) => { storage.set(key, structuredClone(value)) },
    },
  }
  const trees: any[] = []
  const log = vi.fn()
  const existingSessions = new Set<string>()
  const runtime = createOpenCodeV2Runtime(ctx as any, { writeTree: async tree => { trees.push(tree) }, hasExistingSession: id => existingSessions.has(id), log })
  const event = (type = 'session.execution.succeeded', sessionID = 'root', data = {}) => runtime.handleEvent({
    id: 'evt_test', type, created: 30, location: { directory: '/workspace/project' }, data: { sessionID, ...data },
  } as any)
  return { storage, infos, contexts, ctx, trees, log, runtime, event, existingSessions }
}

describe('OpenCode v2 collection', () => {
  it('converts v2 messages, tokens, tools and native skills into the shared snapshot', async () => {
    const f = fixture()
    f.contexts.root.push({ id: 'msg_3', type: 'skill', name: 'review', time: { created: 25 } })
    await f.event()
    expect(f.trees[0]).toMatchObject({
      info: { id: 'root', directory: '/workspace/project' }, skills: ['review'],
      messages: [
        { info: { id: 'msg_1', role: 'user' }, parts: [{ text: 'First prompt' }] },
        { info: { id: 'msg_2', role: 'assistant', modelID: 'test-model', tokens: { input: 100, reasoning: 5 } },
          parts: [{ callID: 'call-read', tool: 'read', state: { input: { path: 'a.ts' } } }] },
      ],
    })
  })

  it('retains messages through observed compaction and plugin restart without double counting', async () => {
    const f = fixture()
    await f.event()
    await f.runtime.beforeCompaction('root')
    f.contexts.root = [{ id: 'msg_3', type: 'compaction', status: 'completed', time: { created: 40 } }, user('msg_4', 'After compact')]
    await f.event('session.compaction.ended')
    const resumed = fixture(f.storage)
    resumed.contexts.root = f.contexts.root
    await resumed.event()
    await resumed.event('session.renamed')
    expect(resumed.trees.at(-1).messages.map((m: any) => m.info.id)).toEqual(['msg_1', 'msg_2', 'msg_4'])
  })

  it('does not overwrite statistics with a context truncated before the plugin observed it', async () => {
    const f = fixture()
    f.contexts.root.unshift({ id: 'msg_compact', type: 'compaction', status: 'completed', time: { created: 5 } })
    await f.event()
    expect(f.trees).toEqual([])
    expect(f.log).toHaveBeenCalledWith('warn', expect.stringContaining('incomplete'), expect.any(Object))
  })

  it.each([false, true])('does not trust an unfinished compaction across restart (failed: %s)', async failed => {
    const f = fixture()
    await f.runtime.beforeCompaction('root')
    if (failed) await f.event('session.compaction.failed')
    const resumed = fixture(f.storage)
    resumed.contexts.root = [{ id: 'msg_offline_compact', type: 'compaction', status: 'completed', time: { created: 40 } }]
    await resumed.event()
    expect(resumed.trees).toEqual([])
    expect(resumed.log).toHaveBeenCalledWith('warn', expect.stringContaining('incomplete'), expect.any(Object))
  })

  it('reconciles a revert to an earlier observed compaction boundary', async () => {
    const f = fixture()
    await f.runtime.beforeCompaction('root')
    const first = { id: 'compact_1', type: 'compaction', status: 'completed', time: { created: 40 } }
    f.contexts.root = [first, user('msg_4', 'After first compact')]
    await f.event('session.compaction.ended')
    await f.runtime.beforeCompaction('root')
    f.contexts.root = [{ id: 'compact_2', type: 'compaction', status: 'completed', time: { created: 50 } }, user('msg_5', 'After second compact')]
    await f.event('session.compaction.ended')
    const resumed = fixture(f.storage)
    resumed.contexts.root = [first]
    await resumed.event('session.revert.committed')
    await resumed.event()
    expect(resumed.trees).toHaveLength(2)
    expect(resumed.trees.at(-1).messages.map((m: any) => m.info.id)).toEqual(['msg_1', 'msg_2'])
  })

  it('retries a failed compaction checkpoint write before consuming its capture', async () => {
    const f = fixture()
    await f.runtime.beforeCompaction('root')
    f.contexts.root = [{ id: 'compact_1', type: 'compaction', status: 'completed', time: { created: 40 } }]
    const save = f.ctx.storage.set
    f.ctx.storage.set = vi.fn(save).mockRejectedValueOnce(new Error('storage unavailable'))
    await f.event('session.compaction.ended')
    await f.event()
    expect(f.trees.at(-1).messages.map((m: any) => m.info.id)).toEqual(['msg_1', 'msg_2'])
    const writes = f.trees.length
    f.contexts.root = [{ id: 'compact_missed', type: 'compaction', status: 'completed', time: { created: 50 } }]
    await f.event()
    expect(f.trees).toHaveLength(writes)
    expect(f.log).toHaveBeenCalledWith('warn', expect.stringContaining('incomplete'), expect.any(Object))
  })

  it('preserves an existing Timeline root when historical children cannot be enumerated', async () => {
    const f = fixture()
    f.existingSessions.add('root')
    await f.event()
    expect(f.trees).toEqual([])
  })

  it('includes billed compaction usage and skills attached to user prompts', async () => {
    const f = fixture()
    f.contexts.root[0].skills = [{ id: 'review', name: 'review' }]
    await f.runtime.beforeCompaction('root')
    f.contexts.root = [{ id: 'msg_3', type: 'compaction', status: 'completed', model: { id: 'compact-model' },
      time: { created: 40 }, tokens: { input: 250, output: 30, reasoning: 5, cache: { read: 10, write: 0 } } }]
    await f.event('session.compaction.ended')
    expect(f.trees.at(-1)).toMatchObject({ skills: ['review'], messages: [
      { info: { id: 'msg_1' } }, { info: { id: 'msg_2' } },
      { info: { id: 'msg_3', role: 'assistant', modelID: 'compact-model', tokens: { input: 250 } } },
    ] })
  })

  it('merges child checkpoints into their root and retains the child across restart', async () => {
    const f = fixture()
    f.contexts.child = [user('msg_child', 'Child prompt')]
    await f.event('session.execution.failed', 'child')
    expect(f.trees.at(-1)).toMatchObject({ info: { id: 'root' }, children: [{ info: { id: 'child' } }] })
    const resumed = fixture(f.storage)
    resumed.contexts.child = f.contexts.child
    await resumed.event()
    expect(resumed.trees.at(-1).children[0].messages).toHaveLength(1)
  })

  it('ignores events from another location and token deltas', async () => {
    const f = fixture()
    await f.runtime.handleEvent({ type: 'session.execution.succeeded', location: { directory: '/elsewhere' }, data: { sessionID: 'root' } } as any)
    await f.event('session.text.delta')
    expect(f.trees).toEqual([])
    expect(f.ctx.session.get).not.toHaveBeenCalled()
  })

  it('retries a failed snapshot read on the next checkpoint', async () => {
    const f = fixture()
    f.ctx.session.context.mockRejectedValueOnce(new Error('temporary'))
    await f.event()
    expect(f.trees).toEqual([])
    await f.event()
    expect(f.trees).toHaveLength(1)
  })

  it('flushes queued work on disposal and keeps a deleted child snapshot', async () => {
    const f = fixture()
    f.contexts.child = [user('msg_child', 'Child prompt')]
    await f.event('session.execution.succeeded', 'child')
    delete f.infos.child
    void f.event('session.deleted', 'child')
    await f.runtime.dispose()
    expect(f.trees.at(-1).children[0].messages).toHaveLength(1)
  })

  it('retains a known child deleted while the plugin was offline', async () => {
    const f = fixture()
    f.contexts.child = [user('msg_child', 'Child prompt')]
    await f.event('session.execution.succeeded', 'child')
    const resumed = fixture(f.storage)
    resumed.ctx.session.get.mockImplementation(async ({ sessionID }) => {
      if (sessionID === 'child') throw { _tag: 'Session.NotFoundError', sessionID }
      return resumed.infos[sessionID]
    })
    await resumed.event()
    expect(resumed.trees.at(-1)).toMatchObject({ children: [{ messages: [{ info: { id: 'msg_child' } }] }] })
  })

  it('reconciles reverted messages and skills using transcript order instead of lexical IDs', async () => {
    const f = fixture()
    f.contexts.root = [user('msg_fork_2', 'First'), user('msg_fork_10', 'Second'),
      { id: 'msg_fork_11', type: 'skill', name: 'review', time: { created: 25 } }]
    await f.event()
    f.contexts.root = []
    await f.event('session.revert.committed', 'root', { to: 'msg_fork_2' })
    expect(f.trees.at(-1)).toMatchObject({ messages: [], skills: [] })
  })

  it('removes messages reverted while offline even when the revert event was missed', async () => {
    const f = fixture()
    await f.event()
    const resumed = fixture(f.storage)
    resumed.contexts.root = [user('msg_1', 'First prompt'), user('msg_3', 'Replacement prompt')]
    await resumed.event()
    expect(resumed.trees.at(-1).messages.map((m: any) => m.info.id)).toEqual(['msg_1', 'msg_3'])
  })
})
