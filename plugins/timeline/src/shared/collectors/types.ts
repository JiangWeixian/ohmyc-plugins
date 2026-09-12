import type { ParsedSessionData, TokenStatus } from '@ohmyc/timeline/schema'

export type Host = 'cursor' | 'grok'

export type Usage = {
  input: number
  output: number
  cached: number
  status: Exclude<TokenStatus, 'legacy'>
}

export type CollectorEvent = {
  version: 1
  agent: Host
  nativeSessionId: string
  sourceSessionId?: string
  unresolvedParent?: boolean
  rootSession?: boolean
  eventId: string
  observedAt: number
  sourceAt?: number
  turnId?: string
  prompt?: string
  confirmsTurn?: boolean
  tool?: {
    id: string
    name: string
    skill?: string
  }
  project?: string
  model?: string
  title?: string
  transcriptPath?: string
  fileSize?: number
  usage?: Usage
  needsHydration?: boolean
}

export type CollectorState = {
  version: 1
  agent: Host
  nativeSessionId: string
  events: Record<string, CollectorEvent>
}

export type Hydrate = (events: readonly CollectorEvent[])
  => Promise<readonly CollectorEvent[]>

export type WriteSnapshot = (data: ParsedSessionData) => void
