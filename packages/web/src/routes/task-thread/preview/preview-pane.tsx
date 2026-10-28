import type { ReactNode } from 'react'
import type { PreviewTransport } from '@/api/preview-socket'
import type { ApiRun, PreviewServer, PreviewStateMessage } from '@open-mercato/cezar-api-client'
import type { StatusDotTone } from '@/components/status-dot'

import { PreviewErrorBoundary } from './preview-error-boundary'
import { ConnectionBanner } from './preview-states'
import { PageDialog } from './page-dialog'
import { PreviewInput } from './preview-input'
import { PreviewStage } from './preview-stage'
import type { PreviewTarget } from './preview-memory'
import type { PreviewOpenRequest } from './preview-state'
import type { ThreadPreviewServer } from '../thread-state'
import { PreviewToolbar } from './preview-toolbar'
import { paneOverlay, renderPaneOverlay } from './pane-overlay'
import { copyText, usePreviewPaneTransport } from './use-preview-pane-transport'

/** The pane renders the transport's state; its hook owns one socket for this mount. */
export interface PreviewPaneProps {
  run: ApiRun
  /** The task's registered servers, newest registration last. */
  servers: readonly PreviewServer[]
  /** Where each registered server stands now (from the task's events). Absent reads as registered. */
  serverStates?: ReadonlyMap<number, ThreadPreviewServer> | undefined
  /** An agent drives the task's browser now: its page is one more entry to pick (hearsay-tools/cezarion#784). */
  agentLive?: boolean | undefined
  /** What the owner asked for: a server to show, and whether they already approved running it. */
  request?: PreviewOpenRequest | undefined
  /** Set where the pane replaces the transcript (below 1180 px): the way back to the conversation. */
  onSession?: (() => void) | undefined
  /** What the pane shows changed: a server, the agent's page or a typed URL (hearsay-tools/cezarion#2077). */
  onTarget?: (target: PreviewTarget | undefined) => void
  /** Frames are flowing (the header toggle's green dot). */
  onLive?: (live: boolean) => void
  onClose: () => void
}

export { PreviewErrorBoundary }

export function PreviewPane(props: PreviewPaneProps) {
  return (
    <PreviewErrorBoundary onClose={props.onClose}>
      <PreviewPaneBody {...props} />
    </PreviewErrorBoundary>
  )
}

function statusFor(
  transport: { state: PreviewTransport; attempt: number },
  everOpened: boolean,
  takenOver: boolean,
  stage: PreviewStateMessage | undefined,
): { tone: StatusDotTone; label: string } | undefined {
  if (transport.state === 'blocked') return { tone: 'neutral', label: 'not supported' }
  if (takenOver) return { tone: 'neutral', label: 'paused' }
  if (everOpened && (transport.state === 'reconnecting' || transport.state === 'closed')) return { tone: 'danger', label: 'offline' }
  if (transport.state !== 'open') return { tone: 'neutral', label: 'connecting…' }
  return stage ? stageStatus(stage) : undefined
}

/** The toolbar's reading for a stage, once the socket is open and the pane is its own. */
function stageStatus(stage: PreviewStateMessage): { tone: StatusDotTone; label: string } | undefined {
  switch (stage.stage) {
    case 'downloading': return { tone: 'pending', label: 'downloading' }
    case 'download-failed': return { tone: 'danger', label: 'download failed' }
    case 'sandbox-failed': return { tone: 'danger', label: 'browser failed' }
    case 'browser-exited': return { tone: 'danger', label: stage.reason === 'timeout' ? 'browser timed out' : 'browser exited' }
    case 'needs-approval': return { tone: 'neutral', label: 'not started' }
    case 'port-held': return { tone: 'danger', label: 'port in use' }
    case 'server-starting': return { tone: 'pending', label: `waiting for :${stage.server.port}` }
    case 'server-stalled': return { tone: 'pending', label: 'waiting · 2 min' }
    case 'server-exited': return { tone: 'danger', label: 'server exited' }
    case 'server-stopped': return { tone: 'neutral', label: 'stopped' }
    case 'agent-idle': return { tone: 'neutral', label: 'agent idle' }
    case 'loading': return { tone: 'neutral', label: 'connecting…' }
    default: return undefined
  }
}

function PreviewPaneBody(props: PreviewPaneProps) {
  const { run, servers, serverStates, agentLive, onSession, onClose } = props
  const transportState = usePreviewPaneTransport(props)
  const {
    compact, transport, everOpened, takenOver, stage, url, port, agent, hasFrame,
    stats, viewport, setViewport, quality, chooseQuality, addressError,
    urlInput, send, streaming, openServer, openAgent, empty,
    navigate, actions,
  } = transportState

  const current = servers.find(server => server.port === port)
  const adopted = stage?.stage === 'streaming' && stage.adopted
  const lost = everOpened && (transport.state === 'reconnecting' || transport.state === 'closed')

  const { content, dim } = paneOverlay({ transport: transport.state, takenOver, empty, stage, hasFrame, lost, url, worktree: run.worktreePath })
  const overlay = renderPaneOverlay(content, { servers, serverStates, agentLive, openServer, openAgent, actions })

  return (
    <section data-slot="preview-pane-body" aria-label="Live preview" className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <PreviewToolbar
        url={url}
        servers={servers}
        serverStates={serverStates}
        badge={transport.state !== 'blocked'}
        current={current}
        agentLive={agentLive === true}
        agentShown={agent}
        adopted={adopted}
        viewport={compact ? 'fit' : viewport}
        quality={quality}
        compact={compact}
        navEnabled={streaming}
        loading={stage?.stage === 'loading'}
        stats={streaming ? stats ?? { fps: 0, kbps: 0 } : undefined}
        status={streaming ? undefined : statusFor(transport, everOpened, takenOver !== undefined, stage)}
        urlInputRef={urlInput}
        onSession={onSession}
        onNavigate={navigate}
        onBack={() => send({ t: 'back' })}
        onForward={() => send({ t: 'forward' })}
        onReload={ignoreCache => send({ t: 'reload', ...(ignoreCache ? { ignoreCache: true } : {}) })}
        onPickServer={serverPort => openServer(serverPort)}
        onPickAgent={openAgent}
        onViewport={setViewport}
        onQuality={chooseQuality}
        onCopyUrl={() => copyText(url)}
        onStop={serverPort => send({ t: 'stop', port: serverPort })}
        onClose={onClose}
      />
      {addressError ? (
        <p role="alert" className="border-b border-border bg-card px-3 py-1.5 text-xs text-danger">{addressError}</p>
      ) : null}
      <PaneStage transportState={transportState} overlay={overlay} dim={dim} lost={lost} />
    </section>
  )
}

function PaneStage({ transportState, overlay, dim, lost }: {
  transportState: ReturnType<typeof usePreviewPaneTransport>
  overlay: ReactNode
  dim: boolean
  lost: boolean
}) {
  const { connected, dialog, hasFrame, stage, stageHandle, compact, viewport, cursor, setStageSize, send, urlInput, transport, reconnect, setDialog } = transportState
  const stageName = stage?.stage
  // The page takes input while it is on screen and live: not behind a state, not while a dialog freezes it.
  const interactive = connected && overlay === null && !dialog
  const showPage = hasFrame && (stageName === 'streaming' || stageName === 'loading' || dim)

  return (
    <PreviewStage
      ref={stageHandle}
      viewport={compact ? 'fit' : viewport}
      dimmed={dim && showPage}
      cursor={cursor}
      onSize={setStageSize}
      renderInput={geometry => (interactive ? <PreviewInput scale={geometry.scale} send={send} onLeave={() => urlInput.current?.focus()} /> : null)}
    >
      {lost ? <ConnectionBanner attempt={transport.attempt} exhausted={transport.state === 'closed'} onReconnect={reconnect} /> : null}
      {overlay ? (
        <div data-slot="preview-overlay" className={dim && hasFrame ? 'absolute inset-0 overflow-auto bg-background/85' : 'absolute inset-0 overflow-auto bg-background'}>
          {overlay}
        </div>
      ) : null}
      {dialog ? (
        <PageDialog
          dialog={dialog}
          onResult={result => {
            setDialog(undefined)
            send({ t: 'dialogResult', ...result })
          }}
        />
      ) : null}
    </PreviewStage>
  )
}
