import { createContext } from 'react'

import type { ThreadConversationMessage } from './thread-state'

/** Loaded messages only: never invent a link to an evicted/unloaded history row. */
export interface ConversationTarget {
  message: ThreadConversationMessage
  rowKey: string
  rowIndex: number
}

export const ConversationNavigation = createContext<{
  targets: ReadonlyMap<string, ConversationTarget>
  replies: ReadonlyMap<string, readonly ConversationTarget[]>
  navigate: (target: ConversationTarget) => void
}>({ targets: new Map(), replies: new Map(), navigate: () => {} })
