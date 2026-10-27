import type { ReactNode } from 'react'

import type { PreviewTransport } from '@/api/preview-socket'
import type { PreviewServer, PreviewStateMessage } from '@open-mercato/cezar-api-client'

import type { ThreadPreviewServer } from '../thread-state'
import { PreviewEmptyState, PreviewStates, type PreviewStageState, type PreviewStateActions } from './preview-states'

type OverlayContent =
  | { kind: 'none' }
  | { kind: 'empty'; agentIdle: boolean }
  | { kind: 'state'; state: PreviewStageState; url?: string; worktree?: string | undefined }

interface OverlayState {
  transport: PreviewTransport
  takenOver: string | undefined
  empty: boolean
  stage: PreviewStateMessage | undefined
  hasFrame: boolean
  lost: boolean
  url: string
  worktree: string | undefined
}

/** Keep overlay precedence independent of rendering and transport side effects. */
export function paneOverlay({ transport, takenOver, empty, stage, hasFrame, lost, url, worktree }: OverlayState): { content: OverlayContent; dim: boolean } {
  const dim = lost || (transport !== 'blocked' && takenOver !== undefined)
  if (transport === 'blocked') return { content: { kind: 'state', state: { stage: 'proxy-blocked' } }, dim }
  if (takenOver !== undefined) return { content: { kind: 'state', state: { stage: 'taken-over', by: takenOver } }, dim }
  if (empty || stage?.stage === 'agent-idle') return { content: { kind: 'empty', agentIdle: !empty && stage?.stage === 'agent-idle' }, dim }
  if (stage?.stage === 'streaming' || (stage?.stage === 'loading' && hasFrame)) return { content: { kind: 'none' }, dim }
  if (stage) return { content: { kind: 'state', state: stage, url, worktree }, dim }
  if (!lost) return { content: { kind: 'state', state: { t: 'state', stage: 'loading', step: 'browser' }, url }, dim }
  return { content: { kind: 'none' }, dim }
}

interface OverlayActions {
  servers: readonly PreviewServer[]
  serverStates: ReadonlyMap<number, ThreadPreviewServer> | undefined
  agentLive: boolean | undefined
  openServer(port: number): void
  openAgent(): void
  actions: PreviewStateActions
}

export function renderPaneOverlay(content: OverlayContent, { servers, serverStates, agentLive, openServer, openAgent, actions }: OverlayActions): ReactNode {
  switch (content.kind) {
    case 'none': return null
    case 'state': {
      const { kind: _, ...props } = content
      return <PreviewStates {...props} actions={actions} />
    }
    case 'empty': return (
      <PreviewEmptyState
        servers={servers}
        states={serverStates}
        onOpen={serverPort => openServer(serverPort)}
        agentLive={agentLive === true}
        agentIdle={content.agentIdle}
        onOpenAgent={openAgent}
      />
    )
  }
}
