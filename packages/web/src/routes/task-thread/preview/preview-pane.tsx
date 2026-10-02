import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { connectPreview, type PreviewConnection, type PreviewTransport } from '@/api/preview-socket'
import type {
  ApiRun,
  PreviewClientMessage,
  PreviewServer,
  PreviewServerMessage,
  PreviewStateMessage,
} from '@open-mercato/cezar-api-client'
import type { StatusDotTone } from '@/components/status-dot'
import { toast } from '@/components/ui/toaster'
import { useActiveProjectId } from '@/lib/project-router'

import { PreviewErrorBoundary } from './preview-error-boundary'
import { PREVIEW_PHONE_QUERY, useMediaQuery } from './use-media-query'
import { ConnectionBanner, PreviewEmptyState, PreviewStates, type PreviewStageState, type PreviewStateActions } from './preview-states'
import { PageDialog } from './page-dialog'
import { PreviewInput } from './preview-input'
import { PreviewStage, type PreviewStageHandle, type StageSize } from './preview-stage'
import type { PreviewOpenRequest } from './preview-state'
import type { ThreadPreviewServer } from '../thread-state'
import { PreviewToolbar, type PreviewStatsValue, type PreviewViewport } from './preview-toolbar'
import { resolveAddress } from './preview-url'

/**
 * The preview pane (#781, spec 2026-10-02-live-preview-v1, "Cockpit"). It owns one preview
 * socket for exactly as long as it is mounted: mount connects, unmount closes. Everything the
 * server says arrives as a `state` message and is drawn by `PreviewStates`; the pane adds the
 * three states only the cockpit can know (5.11 connection lost, 5.12 taken over, 5.14 proxy).
 */

type DialogMessage = Extract<PreviewServerMessage, { t: 'dialog' }>

const PING_MS = 2_000
const STATS_MS = 500
const ONE_SECOND = 1_000

type Target = { port: number } | { url: string }

export interface PreviewPaneProps {
  run: ApiRun
  /** The task's registered servers, newest registration last. */
  servers: readonly PreviewServer[]
  /** Where each registered server stands now (from the task's events). Absent reads as registered. */
  serverStates?: ReadonlyMap<number, ThreadPreviewServer>
  /** What the owner asked for: a server to show, and whether they already approved running it. */
  request?: PreviewOpenRequest
  /** Set where the pane replaces the transcript (below 1180 px): the way back to the conversation. */
  onSession?: () => void
  /** The server the pane shows changed (`undefined` for a typed URL). */
  onPort?: (port: number | undefined) => void
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

/** The stages that describe the server being opened (not the browser around it). */
function answersServer(message: PreviewStateMessage, port: number): boolean {
  switch (message.stage) {
    case 'needs-approval':
    case 'server-starting':
    case 'server-stalled':
    case 'server-exited':
    case 'server-stopped':
      return message.server.port === port
    case 'loading':
    case 'streaming':
      return true
    default:
      return false
  }
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).then(
    () => toast('Copied'),
    () => toast("Couldn't copy to the clipboard", { tone: 'danger' }),
  )
}

const serverUrl = (server: PreviewServer): string => `http://localhost:${server.port}${server.path && server.path !== '/' ? server.path : ''}`

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
  switch (stage?.stage) {
    case 'downloading': return { tone: 'pending', label: 'downloading' }
    case 'download-failed': return { tone: 'danger', label: 'download failed' }
    case 'sandbox-failed': return { tone: 'danger', label: 'browser failed' }
    case 'browser-exited': return { tone: 'danger', label: 'browser exited' }
    case 'needs-approval': return { tone: 'neutral', label: 'not started' }
    case 'server-starting': return { tone: 'pending', label: `waiting for :${stage.server.port}` }
    case 'server-stalled': return { tone: 'pending', label: 'waiting · 2 min' }
    case 'server-exited': return { tone: 'danger', label: 'server exited' }
    case 'server-stopped': return { tone: 'neutral', label: 'stopped' }
    case 'loading': return { tone: 'neutral', label: 'connecting…' }
    default: return undefined
  }
}

function PreviewPaneBody({ run, servers, serverStates, request, onSession, onPort, onLive, onClose }: PreviewPaneProps) {
  const projectId = useActiveProjectId()
  const compact = useMediaQuery(PREVIEW_PHONE_QUERY, false)

  const [generation, setGeneration] = useState(0)
  const [transport, setTransport] = useState<{ state: PreviewTransport; attempt: number }>({ state: 'connecting', attempt: 0 })
  const [everOpened, setEverOpened] = useState(false)
  const [takenOver, setTakenOver] = useState<string | undefined>(undefined)
  const [stage, setStage] = useState<PreviewStateMessage | undefined>(undefined)
  const [url, setUrl] = useState('')
  const [port, setPort] = useState<number | undefined>(undefined)
  const [hasTarget, setHasTarget] = useState(false)
  const [hasFrame, setHasFrame] = useState(false)
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [dialog, setDialog] = useState<DialogMessage | undefined>(undefined)
  const [stats, setStats] = useState<PreviewStatsValue | undefined>(undefined)
  const [viewport, setViewport] = useState<PreviewViewport>('fit')
  const [stageSize, setStageSize] = useState<StageSize | null>(null)
  const [addressError, setAddressError] = useState<string | undefined>(undefined)
  const [stageNonce, setStageNonce] = useState(0)

  const connection = useRef<PreviewConnection | undefined>(undefined)
  const stageHandle = useRef<PreviewStageHandle>(null)
  const urlInput = useRef<HTMLInputElement | null>(null)
  /** What to ask for whenever a socket opens: the first time, and after every reconnect. */
  const target = useRef<Target | undefined>(undefined)
  /** A port whose approval the owner already gave on a card: the next approval stage sends `run`. */
  const autoRun = useRef<number | undefined>(undefined)
  const latest = useRef({ port, stage })
  latest.current = { port, stage }
  const frames = useRef<Array<{ at: number; bytes: number }>>([])
  const rtt = useRef<number | undefined>(undefined)
  const seenFrame = useRef(false)

  /** Whether the current socket is open: nothing is queued, `open` is re-sent when it opens. */
  const socketOpen = useRef(false)

  const send = useCallback((message: PreviewClientMessage) => {
    if (socketOpen.current) connection.current?.send(message)
  }, [])

  useEffect(() => {
    let conn: PreviewConnection | undefined
    conn = connectPreview(
      // `default` is the boot project's alias; the route answers under it like any project id.
      { projectId: projectId ?? 'default', runId: run.id },
      {
        onFrame(blob) {
          const now = Date.now()
          frames.current.push({ at: now, bytes: blob.size })
          if (!seenFrame.current) {
            seenFrame.current = true
            setHasFrame(true)
          }
          const draw = stageHandle.current?.draw(blob) ?? Promise.resolve()
          // The server holds the next frame until this one is acked: draw first, then ask for more.
          void draw.finally(() => conn?.send({ t: 'ack' }))
        },
        onMessage(message) {
          switch (message.t) {
            case 'state':
              setStage(message)
              if (message.stage === 'streaming' || message.stage === 'loading') setStageNonce(n => n + 1)
              // A card's approval answers the first thing the server says about its port, and is
              // spent there: a stale card (the server was already up) must not leave a run waiting
              // for some later crash.
              if (autoRun.current !== undefined && answersServer(message, autoRun.current)) {
                const approved = autoRun.current
                autoRun.current = undefined
                if (message.stage === 'needs-approval' || message.stage === 'server-exited' || message.stage === 'server-stopped') {
                  conn?.send({ t: 'run', port: approved })
                }
              }
              return
            case 'url': return setUrl(message.url)
            case 'cursor': return setCursor(message.cursor)
            case 'dialog': return setDialog(message)
            case 'pong':
              rtt.current = Math.max(0, Date.now() - message.ts)
              return
            case 'downloadProgress':
              setStage(previous => (previous?.stage === 'downloading' ? { ...previous, received: message.received, total: message.total } : previous))
              return
            case 'replaced':
              // The server has closed this socket. Left to reconnect it would take the preview
              // straight back from the other tab, and the two would trade it forever.
              setTakenOver(message.by)
              socketOpen.current = false
              conn?.close()
              return
          }
        },
        onTransport(state, attempt) {
          socketOpen.current = state === 'open'
          setTransport({ state, attempt: attempt ?? 0 })
          if (state !== 'open') return
          setEverOpened(true)
          if (target.current) conn?.send({ t: 'open', target: target.current })
        },
      },
    )
    connection.current = conn
    return () => {
      socketOpen.current = false
      conn?.close()
      if (connection.current === conn) connection.current = undefined
    }
  }, [projectId, run.id, generation])

  // A resize is only meaningful to a browser that exists, so it follows the stage messages too.
  // A takeover closes the socket without a transport event, so it ends the connection here.
  const connected = transport.state === 'open' && takenOver === undefined
  const desired = compact || viewport === 'fit' ? stageSize : viewport
  useEffect(() => {
    if (desired && connected && (stage?.stage === 'streaming' || stage?.stage === 'loading')) {
      send({ t: 'resize', w: desired.w, h: desired.h })
    }
  }, [desired?.w, desired?.h, connected, stage?.stage, stageNonce, send]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the socket alive and measure the round trip.
  useEffect(() => {
    if (!connected) return
    const timer = setInterval(() => send({ t: 'ping', ts: Date.now() }), PING_MS)
    return () => clearInterval(timer)
  }, [connected, send])

  // Stats are read off the frame log twice a second, not once per frame.
  const streaming = connected && stage?.stage === 'streaming'
  useEffect(() => {
    if (!streaming) {
      setStats(undefined)
      return
    }
    const timer = setInterval(() => {
      const now = Date.now()
      frames.current = frames.current.filter(frame => now - frame.at <= ONE_SECOND)
      const next: PreviewStatsValue = {
        fps: frames.current.length,
        kbps: Math.round(frames.current.reduce((total, frame) => total + frame.bytes, 0) / 1024),
        ...(rtt.current === undefined ? {} : { rttMs: rtt.current }),
        ...(frames.current.length > 0 ? { lastFrameAt: frames.current.at(-1)!.at } : {}),
      }
      setStats(previous => {
        // Quiet seconds keep the time of the last frame, which is what turns the readout to idle.
        const lastFrameAt = next.lastFrameAt ?? previous?.lastFrameAt
        const merged: PreviewStatsValue = { ...next, ...(lastFrameAt === undefined ? {} : { lastFrameAt }) }
        if (previous && previous.fps === merged.fps && previous.kbps === merged.kbps && previous.rttMs === merged.rttMs && previous.lastFrameAt === merged.lastFrameAt) return previous
        return merged
      })
    }, STATS_MS)
    return () => clearInterval(timer)
  }, [streaming])

  useEffect(() => {
    onLive?.(streaming)
    return () => onLive?.(false)
  }, [streaming, onLive])

  useEffect(() => {
    onPort?.(port)
  }, [port, onPort])

  const openTarget = useCallback(
    (next: Target, shownUrl: string, approved = false) => {
      target.current = next
      autoRun.current = approved && 'port' in next ? next.port : undefined
      setHasTarget(true)
      setStage(undefined)
      setTakenOver(undefined)
      setAddressError(undefined)
      setUrl(shownUrl)
      setPort('port' in next ? next.port : undefined)
      send({ t: 'open', target: next })
    },
    [send],
  )

  const openServer = useCallback(
    (serverPort: number, approved = false) => {
      const server = servers.find(candidate => candidate.port === serverPort)
      openTarget({ port: serverPort }, server ? serverUrl(server) : `http://localhost:${serverPort}`, approved)
    },
    [servers, openTarget],
  )

  // Each open request re-applies once. Asking again for the server already on screen must not
  // navigate it away from where the owner is: only an approval to run is worth repeating.
  useEffect(() => {
    if (request?.port === undefined) return
    const showing = latest.current.port === request.port && latest.current.stage?.stage === 'streaming'
    if (showing && request.run !== true) return
    openServer(request.port, request.run === true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])

  const empty = !hasTarget && !takenOver && transport.state !== 'blocked'
  useEffect(() => {
    if (empty) urlInput.current?.focus()
  }, [empty])

  const navigate = (input: string) => {
    const address = resolveAddress(input, servers)
    if (address.kind === 'error') return setAddressError(address.message)
    if (address.kind === 'server') return openServer(address.port)
    if (latest.current.stage?.stage === 'streaming') {
      setAddressError(undefined)
      setUrl(address.url)
      return send({ t: 'nav', url: address.url })
    }
    openTarget({ url: address.url }, address.url)
  }

  const reconnect = () => {
    setTakenOver(undefined)
    setTransport({ state: 'connecting', attempt: 0 })
    seenFrame.current = false
    setGeneration(value => value + 1)
  }

  const actions: PreviewStateActions = useMemo(
    () => ({
      download: () => send({ t: 'download' }),
      cancelDownload: () => send({ t: 'cancelDownload' }),
      retryBrowser: () => send({ t: 'retryBrowser' }),
      run: serverPort => send({ t: 'run', port: serverPort }),
      stop: serverPort => send({ t: 'stop', port: serverPort }),
      keepWaiting: serverPort => send({ t: 'keepWaiting', port: serverPort }),
      close: onClose,
      useHere: reconnect,
      copy: copyText,
    }),
    [send, onClose], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const current = servers.find(server => server.port === port)
  const adopted = stage?.stage === 'streaming' && stage.adopted
  const lost = everOpened && (transport.state === 'reconnecting' || transport.state === 'closed')

  let overlay: ReactNode = null
  let dim = false
  if (transport.state === 'blocked') {
    overlay = <PreviewStates state={{ stage: 'proxy-blocked' }} actions={actions} />
  } else if (takenOver !== undefined) {
    dim = true
    overlay = <PreviewStates state={{ stage: 'taken-over', by: takenOver }} actions={actions} />
  } else if (empty) {
    overlay = <PreviewEmptyState servers={servers} states={serverStates} onOpen={serverPort => openServer(serverPort)} />
  } else if (stage?.stage === 'streaming' || (stage?.stage === 'loading' && hasFrame)) {
    overlay = null
  } else if (stage) {
    overlay = <PreviewStates state={stage as PreviewStageState} actions={actions} url={url} worktree={run.worktreePath} />
  } else if (!lost) {
    overlay = <PreviewStates state={{ t: 'state', stage: 'loading', step: 'browser' }} actions={actions} url={url} />
  }
  if (lost) dim = true

  // The page takes input while it is on screen and live: not behind a state, not while a dialog freezes it.
  const interactive = connected && overlay === null && !dialog
  const showPage = hasFrame && (stage?.stage === 'streaming' || stage?.stage === 'loading' || dim)

  return (
    <section data-slot="preview-pane-body" aria-label="Live preview" className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <PreviewToolbar
        url={url}
        servers={servers}
        serverStates={serverStates}
        badge={transport.state !== 'blocked'}
        current={current}
        adopted={adopted}
        viewport={compact ? 'fit' : viewport}
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
        onViewport={setViewport}
        onCopyUrl={() => copyText(url)}
        onStop={serverPort => send({ t: 'stop', port: serverPort })}
        onClose={onClose}
      />
      {addressError ? (
        <p role="alert" className="border-b border-border bg-card px-3 py-1.5 text-xs text-danger">{addressError}</p>
      ) : null}
      <PreviewStage
        ref={stageHandle}
        viewport={compact ? 'fit' : viewport}
        dimmed={dim && showPage}
        cursor={cursor}
        onSize={setStageSize}
        renderInput={geometry => (interactive ? <PreviewInput scale={geometry.scale} send={send} /> : null)}
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
    </section>
  )
}
