import type { Plugin } from '@opencode/plugin'
import type { HydratedSessionNode } from '../../opencode'

type Context = Pick<Plugin.Context, 'location' | 'session' | 'storage'>
type Message = Awaited<ReturnType<Context['session']['context']>>[number]
type Event = { type: string; location?: { directory: string }; data: unknown }
type Log = (level: string, message: string, data?: Record<string, unknown>) => void
type Snapshot = Omit<HydratedSessionNode, 'children'> & {
  children: string[]
  complete: boolean
  compaction?: string
  deleted?: boolean
  historyIDs: string[]
  skillMessages: Array<{ id: string; names: string[] }>
}

const checkpointEvents = new Set([
  'session.inbox.delivered', 'session.step.ended', 'session.step.failed',
  'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted',
  'session.renamed', 'session.skill.activated', 'session.compaction.ended',
  'session.compaction.failed', 'session.revert.committed', 'session.deleted',
])
const key = (id: string) => `timeline.v2.session.${id}`

function normalizeMessages(messages: Message[]): HydratedSessionNode['messages'] {
  return messages.flatMap((message): HydratedSessionNode['messages'] => {
    if (message.type === 'compaction' && message.status !== 'running' && message.tokens) {
      return [{ info: { id: message.id, role: 'assistant', time: message.time,
        modelID: message.status === 'completed' ? message.model?.id : undefined, tokens: message.tokens }, parts: [] }]
    }
    if (message.type !== 'user' && message.type !== 'assistant') return []
    const info = {
      id: message.id, role: message.type, time: message.time,
      ...(message.type === 'assistant' ? { modelID: message.model.id, tokens: message.tokens } : {}),
    }
    const parts: Record<string, unknown>[] = message.type === 'user'
      ? [{ id: `${message.id}:text`, messageID: message.id, type: 'text', text: message.text }]
      : message.content.flatMap(part => part.type !== 'tool' || part.state.status === 'streaming' ? [] : [{
        id: part.id, messageID: message.id, type: 'tool', callID: part.id,
        tool: part.name, state: { input: part.state.input },
      }])
    return [{ info, parts }]
  })
}

export function createOpenCodeV2Runtime(
  ctx: Context,
  deps: { writeTree: (tree: HydratedSessionNode) => Promise<void>; hasExistingSession: (id: string) => boolean; log: Log },
) {
  let tail = Promise.resolve()
  const compacting = new Set<string>()

  const saved = async (id: string) => await ctx.storage.get(key(id)) as Snapshot | undefined
  const save = async (id: string, snapshot: Snapshot) => {
    await ctx.storage.set(key(id), JSON.parse(JSON.stringify(snapshot)))
  }

  async function checkpoint(sessionID: string, options: { compacting?: boolean; compactionFailed?: boolean; deleted?: boolean } = {}) {
    if (options.compactionFailed) compacting.delete(sessionID)
    const loaded = new Map<string, Snapshot>()
    const completedCompactions = new Set<string>()
    async function load(id: string): Promise<Snapshot> {
      const existing = loaded.get(id)
      if (existing) return existing
      const previous = await saved(id)
      if (previous?.deleted || (id === sessionID && options.deleted)) {
        if (!previous) throw new Error('Deleted session has no collected snapshot')
        const snapshot = { ...previous, deleted: true }
        loaded.set(id, snapshot)
        return snapshot
      }
      let info: Awaited<ReturnType<Context['session']['get']>>
      let context: Message[]
      try {
        [info, context] = await Promise.all([
          ctx.session.get({ sessionID: id }), ctx.session.context({ sessionID: id }),
        ])
      } catch (error) {
        if (!previous || !error || typeof error !== 'object' || !('_tag' in error) || error._tag !== 'Session.NotFoundError') throw error
        const snapshot = { ...previous, deleted: true }
        loaded.set(id, snapshot)
        return snapshot
      }
      const compaction = context.findLast(message => message.type === 'compaction' && message.status === 'completed')?.id
      const historyIDs = previous?.historyIDs ?? []
      const boundary = compaction ? historyIDs.indexOf(compaction) : -1
      const legacyRoot = !previous && !info.parentID && deps.hasExistingSession(id)
      const complete = !legacyRoot && previous?.complete !== false && (!compaction || boundary >= 0 || compacting.has(id))
      const prefix = compaction ? historyIDs.slice(0, boundary >= 0 ? boundary : undefined) : []
      const prefixIDs = new Set(prefix)
      const retain = (messageID: string) => prefixIDs.has(messageID)
      const messages = new Map((previous?.messages ?? []).filter(message => retain(String(message.info.id))).map(message => [message.info.id, message]))
      for (const message of normalizeMessages(context)) messages.set(message.info.id, message)
      const skillMessages = new Map((previous?.skillMessages ?? []).filter(message => retain(message.id)).map(message => [message.id, message]))
      for (const message of context) {
        const names = message.type === 'skill' ? [message.name] : message.type === 'user' ? message.skills?.map(skill => skill.name) ?? [] : []
        if (names.length) skillMessages.set(message.id, { id: message.id, names })
      }
      const snapshot: Snapshot = {
        info: { id: info.id, parentID: info.parentID, title: info.title, time: info.time, model: info.model, directory: info.location.directory },
        messages: [...messages.values()],
        historyIDs: [...new Set([...prefix, ...context.filter(message => message.type !== 'compaction' || message.status !== 'running').map(message => message.id)])],
        skillMessages: [...skillMessages.values()],
        skills: [...new Set([...skillMessages.values()].flatMap(message => message.names))],
        children: previous?.children ?? [], complete, compaction,
      }
      if (compaction && compaction !== previous?.compaction) completedCompactions.add(id)
      loaded.set(id, snapshot)
      return snapshot
    }

    let rootID = sessionID
    let snapshot = await load(rootID)
    if (snapshot.info.directory !== ctx.location.directory) return
    const parents = new Set<string>()
    while (snapshot.info.parentID) {
      if (parents.has(rootID)) throw new Error('Cyclic OpenCode session parent')
      parents.add(rootID)
      const childID = rootID
      rootID = String(snapshot.info.parentID)
      snapshot = await load(rootID)
      snapshot.children = [...new Set([...snapshot.children, childID])]
    }

    let complete = true
    const visited = new Set<string>()
    async function tree(id: string): Promise<HydratedSessionNode> {
      if (visited.has(id)) throw new Error('Cyclic OpenCode session tree')
      visited.add(id)
      const node = await load(id)
      complete &&= node.complete
      return { info: node.info, messages: node.messages, skills: node.skills, children: await Promise.all(node.children.map(tree)) }
    }
    const root = await tree(rootID)
    for (const [id, node] of loaded) {
      await save(id, node)
      if (completedCompactions.has(id)) compacting.delete(id)
    }
    if (options.compacting) compacting.add(sessionID)
    if (!complete) {
      deps.log('warn', 'OpenCode v2 history incomplete; preserving existing Timeline statistics', { sessionID: rootID })
      return
    }
    await deps.writeTree(root)
  }

  function enqueue(sessionID: string, options?: Parameters<typeof checkpoint>[1]) {
    tail = tail.then(() => checkpoint(sessionID, options)).catch(error => {
      deps.log('error', 'OpenCode v2 checkpoint failed', { sessionID, error: error instanceof Error ? error.message : String(error) })
    })
    return tail
  }

  return {
    handleEvent(event: Event): Promise<void> {
      if (!checkpointEvents.has(event.type) || (event.location && event.location.directory !== ctx.location.directory)) return Promise.resolve()
      const data = event.data as { sessionID?: string }
      if (!data?.sessionID) return Promise.resolve()
      return enqueue(data.sessionID, {
        deleted: event.type === 'session.deleted',
        compactionFailed: event.type === 'session.compaction.failed',
      })
    },
    beforeCompaction: (sessionID: string) => enqueue(sessionID, { compacting: true }),
    dispose: () => tail,
  }
}
