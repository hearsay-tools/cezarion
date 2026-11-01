import { createContext, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useLocation, useNavigationType } from 'react-router'

/**
 * What the Files view keeps after it unmounts, so a return from the reader reopens it where the
 * reader left it (hearsay-tools/cezarion#2400). One snapshot per history entry: the open folders,
 * and the tree pane's and main pane's scroll offsets. A visit to an entry with no snapshot starts
 * with folders closed, as the lazy tree requires. In memory only: a reload starts fresh.
 */
type Snapshot = { runId: string; folders: ReadonlySet<string>; tree: number; main: number }
const snapshots = new Map<string, Snapshot>()

/** Tests start from an empty memory, as a reload does. */
export function clearFilesViewMemory(): void {
  snapshots.clear()
}

/** The Files entry a link into the reader came from; the reader's fallback Back carries it. */
export function restoreKeyOf(state: unknown): string | null {
  const key = (state as { filesRestoreKey?: unknown } | null)?.filesRestoreKey
  return typeof key === 'string' && key ? key : null
}

/** The tree's open folders. A folder reports its toggles, and a remembered folder reports when its
 *  listing is still loading, so the tree offset waits for the rows it was measured against. */
export type FolderMemory = {
  isOpen: (path: string) => boolean
  setOpen: (path: string, open: boolean) => void
  loading: (path: string, pending: boolean) => void
}
export const FolderMemoryContext = createContext<FolderMemory | null>(null)

const mainPane = () => document.querySelector<HTMLElement>('[data-slot="main"]')

/**
 * Restores the snapshot of the entry being returned to: by Back or Forward (`POP`), or by the
 * reader's fallback Back, which pushes the Files URL and names the entry in its state. The
 * offsets apply in a passive effect, after the shell's layout effect has reset its scroller for
 * the new pathname, and only once the root listing has settled (success or refusal) and every
 * remembered folder has loaded again. The snapshot is recorded on every scroll and folder toggle,
 * and when a new entry starts while the view stays mounted.
 */
export function useFilesViewMemory(runId: string, rootSettled: boolean): { tree: RefObject<HTMLElement | null>; folders: FolderMemory } {
  const tree = useRef<HTMLElement | null>(null)
  const location = useLocation()
  const returnKey = useNavigationType() === 'POP' ? location.key : restoreKeyOf(location.state)
  const [arrival] = useState(() => {
    const saved = returnKey ? snapshots.get(returnKey) : undefined
    return saved?.runId === runId ? saved : null
  })
  const open = useRef(new Set(arrival?.folders ?? []))
  const pending = useRef(new Set<string>())
  const [pendingCount, setPendingCount] = useState(0)
  const restored = useRef(arrival === null)

  const record = useCallback(() => {
    if (!restored.current) return
    snapshots.set(location.key, { runId, folders: new Set(open.current), tree: tree.current?.scrollTop ?? 0, main: mainPane()?.scrollTop ?? 0 })
  }, [location.key, runId])

  const folders = useMemo<FolderMemory>(() => ({
    isOpen: path => open.current.has(path),
    setOpen: (path, value) => { if (value) open.current.add(path); else open.current.delete(path); record() },
    loading: (path, isPending) => {
      if (!arrival?.folders.has(path)) return
      if (isPending) pending.current.add(path)
      else pending.current.delete(path)
      setPendingCount(pending.current.size)
    },
  }), [arrival, record])

  useEffect(() => {
    // Children register their pending folders in their own effects, which run before this one.
    if (restored.current || !arrival || !rootSettled || pending.current.size > 0) return
    if (tree.current) tree.current.scrollTop = arrival.tree
    const main = mainPane()
    if (main) main.scrollTop = arrival.main
    restored.current = true
    record()
  }, [arrival, rootSettled, pendingCount, record])

  useEffect(() => {
    record()
    const panes = [tree.current, mainPane()].filter((pane): pane is HTMLElement => pane !== null)
    for (const pane of panes) pane.addEventListener('scroll', record, { passive: true })
    return () => { for (const pane of panes) pane.removeEventListener('scroll', record) }
  }, [record])

  return { tree, folders }
}
