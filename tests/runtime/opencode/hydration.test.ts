import { describe, expect, it, vi } from 'vitest'

import { createSessionTreeLoader } from '../../../opencode'

vi.mock('bun:sqlite', () => ({ Database: vi.fn() }))

describe('createSessionTreeLoader', () => {
  const rootMessageWithParts = {
    info: {
      id: 'root-user',
      sessionID: 'root',
      role: 'user',
      time: { created: 10 },
      model: { providerID: 'test', modelID: 'model' },
    },
    parts: [{ id: 'root-text', sessionID: 'root', messageID: 'root-user', type: 'text', text: 'Root prompt' }],
  }
  const childMessageWithParts = {
    info: {
      id: 'child-assistant',
      sessionID: 'child',
      role: 'assistant',
      time: { created: 20, completed: 30 },
      modelID: 'model',
      tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 10, write: 5 } },
    },
    parts: [{
      id: 'child-tool',
      sessionID: 'child',
      messageID: 'child-assistant',
      type: 'tool',
      callID: 'child-call',
      tool: 'Read',
      state: { status: 'completed', input: { filePath: '/tmp/a' }, output: '', title: '', metadata: {}, time: { start: 20, end: 21 } },
    }],
  }

  it('unwraps fields responses and recursively loads descendants', async () => {
    const client = {
      session: {
        get: vi.fn().mockResolvedValue({ data: { id: 'root', title: 'Accurate title', time: { created: 1, updated: 2 } } }),
        messages: vi.fn(({ path: { id } }) => Promise.resolve({
          data: id === 'root' ? [rootMessageWithParts] : [childMessageWithParts],
        })),
        children: vi.fn(({ path: { id } }) => Promise.resolve({
          data: id === 'root' ? [{ id: 'child', parentID: 'root', title: 'Child session - 2026-07-12T03:16:01.973Z' }] : [],
        })),
      },
    }

    const tree = await createSessionTreeLoader(client as any)('root')

    expect(tree.info.id).toBe('root')
    expect(tree.children[0].info.id).toBe('child')
    expect(client.session.messages).toHaveBeenCalledTimes(2)
    expect(client.session.children).toHaveBeenCalledTimes(2)
    expect(client.session.messages).toHaveBeenCalledWith({ path: { id: 'root' }, url: '/session/{id}/message' })
    expect(client.session.children).toHaveBeenCalledWith({ path: { id: 'child' }, url: '/session/{id}/children' })
  })

  it('keeps more than one internal server page without client cursor requests', async () => {
    const messages = Array.from({ length: 51 }, (_, index) => ({
      info: { id: `msg-${index}`, sessionID: 'root', role: 'user', time: { created: index } },
      parts: [],
    }))
    const client = { session: {
      get: vi.fn().mockResolvedValue({ data: { id: 'root', title: 'root', time: { created: 1, updated: 2 } } }),
      messages: vi.fn().mockResolvedValue({ data: messages }),
      children: vi.fn().mockResolvedValue({ data: [] }),
    } }

    const tree = await createSessionTreeLoader(client as any)('root')

    expect(tree.messages).toHaveLength(51)
    expect(client.session.messages).toHaveBeenCalledWith({ path: { id: 'root' }, url: '/session/{id}/message' })
    expect(client.session.messages).toHaveBeenCalledTimes(1)
  })

  it('resolves an initially observed child back to its root', async () => {
    const client = {
      session: {
        get: vi.fn(({ path: { id } }) => Promise.resolve({ data: id === 'child'
          ? { id: 'child', parentID: 'root', title: 'child', time: { created: 2, updated: 2 } }
          : { id: 'root', title: 'root', time: { created: 1, updated: 2 } } })),
        messages: vi.fn().mockResolvedValue({ data: [] }),
        children: vi.fn(({ path: { id } }) => Promise.resolve({ data: id === 'root'
          ? [{ id: 'child', parentID: 'root', title: 'child', time: { created: 2, updated: 2 } }]
          : [] })),
      },
    }

    const tree = await createSessionTreeLoader(client as any)('child')

    expect(tree.info.id).toBe('root')
    expect(client.session.messages).toHaveBeenCalledTimes(2)
    expect(client.session.children).toHaveBeenCalledTimes(2)
    expect(client.session.messages.mock.calls.map(([{ path }]) => path.id)).toEqual(['child', 'root'])
    expect(client.session.children.mock.calls.map(([{ path }]) => path.id)).toEqual(['child', 'root'])
  })

  it('does not retain failed child loads across retries', async () => {
    const client = {
      session: {
        get: vi.fn(({ path: { id } }) => Promise.resolve({ data: id === 'child'
          ? { id: 'child', parentID: 'root', title: 'child', time: { created: 2, updated: 2 } }
          : { id: 'root', title: 'root', time: { created: 1, updated: 2 } } })),
        messages: vi.fn()
          .mockRejectedValueOnce(new Error('temporary'))
          .mockResolvedValue({ data: [] }),
        children: vi.fn(({ path: { id } }) => Promise.resolve({ data: id === 'root'
          ? [{ id: 'child', parentID: 'root', title: 'child', time: { created: 2, updated: 2 } }]
          : [] })),
      },
    }
    const loadSessionTree = createSessionTreeLoader(client as any)

    await expect(loadSessionTree('child')).rejects.toThrow('temporary')
    await expect(loadSessionTree('child')).resolves.toMatchObject({ info: { id: 'root' } })

    expect(client.session.messages.mock.calls.map(([{ path }]) => path.id)).toEqual(['child', 'child', 'root'])
    expect(client.session.children.mock.calls.map(([{ path }]) => path.id)).toEqual(['child', 'child', 'root'])
  })

  it('rejects SDK errors instead of accepting missing data', async () => {
    const client = { session: {
      get: vi.fn().mockResolvedValue({ error: { message: 'missing' } }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
      children: vi.fn().mockResolvedValue({ data: [] }),
    } }

    await expect(createSessionTreeLoader(client as any)('missing')).rejects.toThrow('session.get failed')
  })
})
