import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useLocation, useNavigationType } from 'react-router'

/**
 * What the Files view keeps while it is unmounted, so Back from the reader reopens it where the
 * reader left it (hearsay-tools/cezarion#2400): each run's open folders and the tree pane's and
 * main pane's scroll offsets, for the history entry they belong to. A visit to a new entry starts
 * with folders closed, as the lazy tree requires. In memory only: a reload starts fresh.
 */
const openFolders = new Map<string, { key: string; folders: Set<string> }>()
const offsets = new Map<string, { tree: number; main: number }>()

/** Tests start from an empty memory, as a reload does. */
export function clearFilesViewMemory(): void {
  openFolders.clear()
  offsets.clear()
}

/** On mount: the folders open at this history entry, or none for an entry not seen before. */
export function enterFolders(runId: string, key: string): void {
  if (openFolders.get(runId)?.key !== key) openFolders.set(runId, { key, folders: new Set() })
}

/** While mounted: a new entry (another file selected) keeps the tree as it is. */
export function moveFolders(runId: string, key: string): void {
  const entry = openFolders.get(runId)
  if (entry) entry.key = key
}

export function isFolderOpen(runId: string, path: string): boolean {
  return openFolders.get(runId)?.folders.has(path) ?? false
}

export function rememberFolder(runId: string, path: string, open: boolean): void {
  const folders = openFolders.get(runId)?.folders
  if (open) folders?.add(path)
  else folders?.delete(path)
}

const mainPane = () => document.querySelector<HTMLElement>('[data-slot="main"]')

/** Records the tree pane's and main pane's offsets for this history entry, and puts them back
 *  when Back or Forward returns to it once the tree has loaded. A new entry starts where it is. */
export function useFilesScrollMemory(runId: string, ready: boolean): RefObject<HTMLElement | null> {
  const tree = useRef<HTMLElement | null>(null)
  const { key } = useLocation()
  const returning = useNavigationType() === 'POP'
  // Before any folder renders: the tree reads its open folders during its first render.
  useState(() => enterFolders(runId, key))
  useEffect(() => moveFolders(runId, key), [runId, key])
  useEffect(() => {
    const record = () => offsets.set(key, { tree: tree.current?.scrollTop ?? 0, main: mainPane()?.scrollTop ?? 0 })
    const panes = [tree.current, mainPane()].filter((pane): pane is HTMLElement => pane !== null)
    for (const pane of panes) pane.addEventListener('scroll', record, { passive: true })
    return () => { for (const pane of panes) pane.removeEventListener('scroll', record) }
  }, [key])
  useLayoutEffect(() => {
    const saved = offsets.get(key)
    if (!ready || !returning || !saved) return
    if (tree.current) tree.current.scrollTop = saved.tree
    const main = mainPane()
    if (main) main.scrollTop = saved.main
  }, [key, ready, returning])
  return tree
}
