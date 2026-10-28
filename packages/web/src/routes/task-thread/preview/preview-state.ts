import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

import type { ApiRun, PreviewServer } from '@open-mercato/cezar-api-client'
import type { StatusDotTone } from '@/components/status-dot'
import { shortAge } from '@/lib/format'

import type { ThreadPreviewServer } from '../thread-state'
import { readPanePercent, readPreviewMemory, rememberPanePercent, rememberPreview, type PreviewTarget } from './preview-memory'
import { PREVIEW_DOCK_QUERY } from './use-media-query'

/**
 * Where the task view and the preview pane meet (#781). The header toggle, the server cards and
 * the pane itself all speak through this one context, so none of them imports another.
 *
 * Opening is only ever a request to SHOW the pane: `run` asks the pane to send the owner's `run`
 * message for that port, and only the cards' Run and open / Start again set it. The header toggle
 * never does, because it is not an approval of anything.
 */
export interface PreviewOpenRequest {
  /** The registered server to show. Absent (with no `agent`) opens the pane on its empty state to pick one. */
  port?: number | undefined
  /** Show the page the agent drives, as it is, with no navigation (hearsay-tools/cezarion#784). */
  agent?: true | undefined
  /** A URL the owner typed, reopened from the task's saved pane (hearsay-tools/cezarion#2077). */
  url?: string | undefined
  /** The owner pressed Run and open or Start again: the pane may send `run` for `port`. */
  run?: boolean
  /** Restored from the task's saved pane, not asked for now: a server no longer registered opens the empty state. */
  restored?: true | undefined
}

export interface PreviewPane {
  /** The pane is docked. */
  open: boolean
  /** The pane is streaming frames right now (the toggle's green dot). */
  live: boolean
  /** The server the pane is showing, when it is showing one. */
  port?: number | undefined
  /** The task's worktree is gone: every card reads 5.15 "worktree removed" and offers nothing. */
  worktreeRemoved?: boolean
  /** An agent drives the task's browser now: the agent's page is one more entry to pick. */
  agentLive?: boolean
  openPane(request: PreviewOpenRequest): void
}

/**
 * Whether the task's worktree is gone, from the run record alone: removed (no path), reclaimed by
 * retention, or a destroyed owned worker's checkout. Continue can restore a reclaimed worktree,
 * and the cards come back with it.
 */
export function worktreeRemoved(run: ApiRun): boolean {
  if (!run.worktreePath || run.worktreeReclaimedAt) return true
  const destroy = run.delegation?.role === 'worker' ? run.delegation.destroy : undefined
  return destroy !== undefined && !destroy.remaining.includes('worktree')
}

/** How a registered server reads right now: the dot and the words, on the card and in the pane's lists. */
export interface ServerStatus {
  tone: StatusDotTone
  ring: boolean
  pulse: boolean
  text: string
}

export function serverStatus(entry: ThreadPreviewServer): ServerStatus {
  const { state, server } = entry
  const age = shortAge(entry.stateAt)
  switch (state) {
    case 'registered':
      return server.answeredAtRegistration
        ? { tone: 'neutral', ring: false, pulse: false, text: 'was running when registered' }
        : { tone: 'neutral', ring: true, pulse: false, text: 'registered · not started' }
    case 'adopted':
      return { tone: 'neutral', ring: false, pulse: false, text: 'was running when registered' }
    case 'starting':
      return { tone: 'pending', ring: false, pulse: true, text: 'starting' }
    case 'up':
      return { tone: 'success', ring: false, pulse: false, text: age ? `up · ${age}` : 'up' }
    case 'stalled':
      return { tone: 'pending', ring: false, pulse: false, text: 'stalled · port silent 2 min' }
    case 'exited':
      return { tone: 'danger', ring: false, pulse: false, text: entry.exitCode === undefined ? 'exited' : `exited · code ${entry.exitCode}` }
    case 'stopped':
      return { tone: 'neutral', ring: true, pulse: false, text: entry.reason === 'idle' ? 'stopped after 15 min idle' : 'stopped' }
    case 'unavailable':
      return { tone: 'neutral', ring: true, pulse: false, text: 'unavailable' }
  }
}

/** What the pane knows of a server nothing has reported on yet: only its registration. */
export function registrationEntry(server: PreviewServer): ThreadPreviewServer {
  return { kind: 'preview-server', id: `preview-server:${server.port}`, server, state: 'registered', stateAt: server.registeredAt }
}

/** The server's entry from the task's reduced events, else its registration. */
export function entryFor(server: PreviewServer, states: ReadonlyMap<number, ThreadPreviewServer> | undefined): ThreadPreviewServer {
  return states?.get(server.port) ?? registrationEntry(server)
}

/** `Open` where the page can load now, `Review` where the owner has to look at an approval first. */
export function opensDirectly(entry: ThreadPreviewServer): boolean {
  if (entry.state === 'registered') return entry.server.answeredAtRegistration
  return entry.state === 'up' || entry.state === 'starting' || entry.state === 'adopted'
}

/** Screen 05 names the script, not its flags: `npm run dev` for `npm run dev -- --port 5173 ...`. */
export function serverScript(command: string): string {
  return command.split(' -- ')[0]!.trim()
}

/** `null` outside a task view that hosts a pane (the git tabs, a sub-agent sheet): no toggle, no card action. */
export const PreviewPaneContext = createContext<PreviewPane | null>(null)

export function usePreviewPane(): PreviewPane | null {
  return useContext(PreviewPaneContext)
}

export interface PreviewPaneState extends PreviewPane {
  /** The latest open request; a new object per call, so asking for the same port twice re-fires. */
  request: PreviewOpenRequest | undefined
  /** Below 1180 px the pane replaces the transcript; this is the owner stepping back to read it. */
  session: boolean
  /** What the pane shows now, as it reports it. */
  target: PreviewTarget | undefined
  /** The pane's share of the split, in percent. */
  percent: number
  closePane(): void
  showSession(): void
  setLive(live: boolean): void
  setTarget(target: PreviewTarget | undefined): void
  setPercent(percent: number): void
}

interface PaneSnapshot {
  open: boolean
  target: PreviewTarget | undefined
  request: PreviewOpenRequest | undefined
  session: boolean
  percent: number
}

const targetPort = (target: PreviewTarget | undefined): number | undefined => (target && 'port' in target ? target.port : undefined)

function docked(): boolean {
  return typeof window.matchMedia !== 'function' || window.matchMedia(PREVIEW_DOCK_QUERY).matches
}

/**
 * The pane as the owner left it on this task (hearsay-tools/cezarion#2077). A restored pane only
 * shows the page again: it never carries `run`, so nothing starts without the owner's approval.
 * Below 1180 px it comes back behind the transcript, so the task is what the owner sees first.
 */
function restore(scope: string | undefined): PaneSnapshot {
  const memory = scope === undefined ? undefined : readPreviewMemory(scope)
  const open = memory?.open === true
  const target = open ? memory.target : undefined
  return {
    open,
    target,
    request: open ? { ...target, restored: true } : undefined,
    session: open && !docked(),
    percent: readPanePercent(scope),
  }
}

/**
 * The task view's pane state. The pane (a separate component) reads and drives it. A new `scope`
 * (another task) starts from that task's saved pane, else closed. Only this state resets: the
 * task's tabs stay mounted. Each owner action saves the task's pane as it is now.
 */
export function usePreviewPaneState(scope?: string): PreviewPaneState {
  const [initial] = useState(() => restore(scope))
  const [open, setOpen] = useState(initial.open)
  const [live, setLive] = useState(false)
  const [target, setTargetState] = useState<PreviewTarget | undefined>(initial.target)
  const [session, setSession] = useState(initial.session)
  const [request, setRequest] = useState<PreviewOpenRequest | undefined>(initial.request)
  const [percent, setPercentState] = useState(initial.percent)
  const [current, setCurrent] = useState(scope)
  const openRef = useRef(open)
  openRef.current = open
  if (current !== scope) {
    const next = restore(scope)
    setCurrent(scope)
    setOpen(next.open)
    setLive(false)
    setTargetState(next.target)
    setSession(next.session)
    setRequest(next.request)
    setPercentState(next.percent)
  }
  const save = useCallback(
    (change: Parameters<typeof rememberPreview>[1]) => {
      if (scope !== undefined) rememberPreview(scope, change)
    },
    [scope],
  )
  const openPane = useCallback(
    (next: PreviewOpenRequest) => {
      setRequest({ ...next })
      const shown: PreviewTarget | undefined = next.port !== undefined ? { port: next.port } : next.agent ? { agent: true } : undefined
      setSession(false)
      setOpen(true)
      if (shown) {
        setTargetState(shown)
        save({ open: true, target: shown })
      } else if (!openRef.current) {
        // A closed pane opens on its chooser: the target saved before the close no longer holds.
        setTargetState(undefined)
        save({ open: true, target: undefined })
      } else {
        // Already open, the pane keeps what it shows, and so does the saved state.
        save({ open: true })
      }
    },
    [save],
  )
  const closePane = useCallback(() => {
    setOpen(false)
    setLive(false)
    setSession(false)
    setTargetState(undefined)
    save({ open: false })
  }, [save])
  const setTarget = useCallback(
    (next: PreviewTarget | undefined) => {
      setTargetState(next)
      save({ target: next })
    },
    [save],
  )
  const setPercent = useCallback(
    (next: number) => {
      setPercentState(next)
      rememberPanePercent(scope, next)
    },
    [scope],
  )
  const showSession = useCallback(() => setSession(true), [])
  const port = targetPort(target)
  return useMemo(
    () => ({ open, live, port, target, percent, request, session, openPane, closePane, showSession, setLive, setTarget, setPercent }),
    [open, live, port, target, percent, request, session, openPane, closePane, showSession, setTarget, setPercent],
  )
}
