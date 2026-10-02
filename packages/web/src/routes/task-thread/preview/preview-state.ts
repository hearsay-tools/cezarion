import { createContext, useCallback, useContext, useMemo, useState } from 'react'

import type { ApiRun, PreviewServer } from '@open-mercato/cezar-api-client'
import type { StatusDotTone } from '@/components/status-dot'
import { shortAge } from '@/lib/format'

import type { ThreadPreviewServer } from '../thread-state'

/**
 * Where the task view and the preview pane meet (#781). The header toggle, the server cards and
 * the pane itself all speak through this one context, so none of them imports another.
 *
 * Opening is only ever a request to SHOW the pane: `run` asks the pane to send the owner's `run`
 * message for that port, and only the cards' Run and open / Start again set it. The header toggle
 * never does, because it is not an approval of anything.
 */
export interface PreviewOpenRequest {
  /** The registered server to show. Absent opens the pane on its empty state to pick one. */
  port?: number
  /** The owner pressed Run and open or Start again: the pane may send `run` for `port`. */
  run?: boolean
}

export interface PreviewPane {
  /** The pane is docked. */
  open: boolean
  /** The pane is streaming frames right now (the toggle's green dot). */
  live: boolean
  /** The server the pane is showing, when it is showing one. */
  port?: number
  /** The task's worktree is gone: every card reads 5.15 "worktree removed" and offers nothing. */
  worktreeRemoved?: boolean
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
  closePane(): void
  showSession(): void
  setLive(live: boolean): void
  setPort(port: number | undefined): void
}

/**
 * The task view's pane state. The pane (a separate component) reads and drives it. A new `scope`
 * (another task) starts with the pane closed. Only this state resets: the task's tabs stay mounted.
 */
export function usePreviewPaneState(scope?: string): PreviewPaneState {
  const [open, setOpen] = useState(false)
  const [live, setLive] = useState(false)
  const [port, setPort] = useState<number | undefined>(undefined)
  const [session, setSession] = useState(false)
  const [request, setRequest] = useState<PreviewOpenRequest | undefined>(undefined)
  const [current, setCurrent] = useState(scope)
  if (current !== scope) {
    setCurrent(scope)
    setOpen(false)
    setLive(false)
    setPort(undefined)
    setSession(false)
    setRequest(undefined)
  }
  const openPane = useCallback((next: PreviewOpenRequest) => {
    setRequest({ ...next })
    if (next.port !== undefined) setPort(next.port)
    setSession(false)
    setOpen(true)
  }, [])
  const closePane = useCallback(() => {
    setOpen(false)
    setLive(false)
    setSession(false)
    setPort(undefined)
  }, [])
  const showSession = useCallback(() => setSession(true), [])
  return useMemo(
    () => ({ open, live, port, request, session, openPane, closePane, showSession, setLive, setPort }),
    [open, live, port, request, session, openPane, closePane, showSession],
  )
}
