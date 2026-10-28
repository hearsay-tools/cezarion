import { usePageActive, pageIsActive } from '@/api/live-visibility'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { connectPreview, type PreviewConnection, type PreviewTransport } from '@/api/preview-socket'
import type { PreviewClientMessage, PreviewQuality, PreviewServer, PreviewServerMessage, PreviewStateMessage } from '@open-mercato/cezar-api-client'
import { toast } from '@/components/ui/toaster'
import { useActiveProjectId } from '@/lib/project-router'

import type { PreviewPaneProps } from './preview-pane'
import { PREVIEW_PHONE_QUERY, useMediaQuery } from './use-media-query'
import type { PreviewStateActions } from './preview-states'
import type { PreviewStageHandle, StageSize } from './preview-stage'
import { readStoredPreviewQuality, writeStoredPreviewQuality } from './preview-quality'
import type { PreviewOpenRequest } from './preview-state'
import type { PreviewStatsValue, PreviewViewport } from './preview-toolbar'
import { resolveAddress } from './preview-url'

type DialogMessage = Extract<PreviewServerMessage, { t: 'dialog' }>

const PING_MS = 2_000
const STATS_MS = 500
const ONE_SECOND = 1_000

/** What the pane asks the server to show: a registered server, a typed URL, or the agent's page. */
type Target = Extract<PreviewClientMessage, { t: 'open' }>['target']

/** The stages that describe the server being opened (not the browser around it). */
function answersServer(message: PreviewStateMessage, port: number): boolean {
  switch (message.stage) {
    case 'needs-approval':
    case 'port-held':
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

export function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).then(
    () => toast('Copied'),
    () => toast("Couldn't copy to the clipboard", { tone: 'danger' }),
  )
}

const serverUrl = (server: PreviewServer): string => `http://localhost:${server.port}${server.path && server.path !== '/' ? server.path : ''}`

/** The owner asked for a server or the agent's page, whose open is on its way. */
function awaitsTarget(request: PreviewOpenRequest | undefined): boolean {
  return request?.port !== undefined || request?.agent === true
}

/** One mounted pane owns the socket, its target refs and every transport effect. */
export function usePreviewPaneTransport({ run, servers, request, onPort, onLive, onClose }: PreviewPaneProps) {
  const pageActive = usePageActive()
  const viewerId = useRef(crypto.randomUUID())
  const opened = useRef(false)
  const projectId = useActiveProjectId()
  const compact = useMediaQuery(PREVIEW_PHONE_QUERY, false)

  const [generation, setGeneration] = useState(0)
  const [transport, setTransport] = useState<{ state: PreviewTransport; attempt: number }>({ state: 'connecting', attempt: 0 })
  const [everOpened, setEverOpened] = useState(false)
  const [takenOver, setTakenOver] = useState<string | undefined>(undefined)
  const [stage, setStage] = useState<PreviewStateMessage | undefined>(undefined)
  const [url, setUrl] = useState('')
  const [port, setPort] = useState<number | undefined>(undefined)
  /** The pane shows the agent's page (or asked for it and got `agent-idle`). */
  const [agent, setAgent] = useState(false)
  const [hasTarget, setHasTarget] = useState(false)
  const [hasFrame, setHasFrame] = useState(false)
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [dialog, setDialog] = useState<DialogMessage | undefined>(undefined)
  const [stats, setStats] = useState<PreviewStatsValue | undefined>(undefined)
  const [viewport, setViewport] = useState<PreviewViewport>('fit')
  const [quality, setQuality] = useState<PreviewQuality>(readStoredPreviewQuality)
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
  /** Every `open` carries the mode, so a reconnect or a new target streams it from the first frame. */
  const qualityRef = useRef(quality)
  qualityRef.current = quality
  const latest = useRef({ port, stage, agent })
  latest.current = { port, stage, agent }
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
          if (!pageIsActive()) return
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
          if (target.current) {
            conn?.send({ t: 'open', target: target.current, viewerId: viewerId.current, resume: opened.current, quality: qualityRef.current })
            opened.current = true
          }
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
  const connected = pageActive && transport.state === 'open' && takenOver === undefined
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
      setAgent('agent' in next)
      send({ t: 'open', target: next, viewerId: viewerId.current, quality: qualityRef.current })
      opened.current = socketOpen.current
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

  // The agent's page is shown as it is: the server attaches, never navigates. Its URL arrives as a
  // `url` message once the page is on screen.
  const openAgent = useCallback(() => openTarget({ agent: true }, ''), [openTarget])

  // Each open request re-applies once. Asking again for the server already on screen must not
  // navigate it away from where the owner is: only an approval to run is worth repeating.
  useEffect(() => {
    if (request?.agent) {
      if (latest.current.agent && latest.current.stage?.stage === 'streaming') return
      openAgent()
      return
    }
    if (request?.port === undefined) return
    const showing = latest.current.port === request.port && latest.current.stage?.stage === 'streaming'
    if (showing && request.run !== true) return
    openServer(request.port, request.run === true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])

  const empty = !hasTarget && !takenOver && transport.state !== 'blocked'
  // The empty state invites typing. A pane opened for a server is not empty, even in the commit
  // before its target lands: focusing then would hide the page URL and pop a phone's keyboard.
  const awaitingRequest = awaitsTarget(request)
  useEffect(() => {
    if (empty && !awaitingRequest) urlInput.current?.focus()
  }, [empty, awaitingRequest])

  const navigate = (input: string) => {
    const address = resolveAddress(input, servers)
    if (address.kind === 'error') return setAddressError(address.message)
    if (address.kind === 'server') return openServer(address.port)
    // On the agent's page a typed URL opens the pane's own page, never moves the agent's.
    if (latest.current.stage?.stage === 'streaming' && !latest.current.agent) {
      // The live page navigates in place, and from now on it is this URL, not a server: a
      // reconnect reopens it, and the switcher and header no longer mark a server as shown.
      target.current = { url: address.url }
      autoRun.current = undefined
      setPort(undefined)
      setAddressError(undefined)
      setUrl(address.url)
      return send({ t: 'nav', url: address.url })
    }
    openTarget({ url: address.url }, address.url)
  }

  // The page stays as it is: the server restarts only its stream at the new mode.
  const chooseQuality = useCallback(
    (next: PreviewQuality) => {
      qualityRef.current = next
      setQuality(next)
      writeStoredPreviewQuality(next)
      send({ t: 'quality', quality: next })
    },
    [send],
  )

  const reconnect = () => {
    // An explicit owner action may reclaim; automatic visibility resumes may not.
    opened.current = false
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

  return {
    compact, transport, everOpened, takenOver, stage, url, port, agent, hasFrame,
    cursor, dialog, setDialog, stats, viewport, setViewport, quality, chooseQuality, setStageSize, addressError,
    stageHandle, urlInput, send, connected, streaming, openServer, openAgent, empty,
    navigate, reconnect, actions,
  }
}
