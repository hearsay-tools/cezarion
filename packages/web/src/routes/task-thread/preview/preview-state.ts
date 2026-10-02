import { createContext, useCallback, useContext, useMemo, useState } from 'react'

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
  openPane(request: PreviewOpenRequest): void
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

/** The task view's pane state. The pane (a separate component) reads and drives it. */
export function usePreviewPaneState(): PreviewPaneState {
  const [open, setOpen] = useState(false)
  const [live, setLive] = useState(false)
  const [port, setPort] = useState<number | undefined>(undefined)
  const [session, setSession] = useState(false)
  const [request, setRequest] = useState<PreviewOpenRequest | undefined>(undefined)
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
