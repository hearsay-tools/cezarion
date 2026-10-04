import { useEffect, useRef, useState } from 'react'
import { readStoredCollapsed, SIDEBAR_SECTIONS_STORAGE_KEY, writeStoredCollapsed, type SidebarCollapsed } from './sidebar-collapse'
import type { BucketLabel } from './task-groups'

const CHANGED = 'cez-sidebar-sections-changed'

/** Browser-local section state, separate from project folding. The canonical project id also
 * lets the flat desktop list and mobile project tree share the same answer. */
export function useSidebarSections(projectId: string | null) {
  const [collapsed, setCollapsed] = useState(() => readStoredCollapsed(SIDEBAR_SECTIONS_STORAGE_KEY))
  // Only user-touched sections wait for discovery. Keep them out of the shared/persisted map
  // so another copy or tab cannot erase them, and no null-project key can leak into storage.
  const [pending, setPending] = useState<Partial<Record<BucketLabel, boolean>>>({})
  const latest = useRef(collapsed)
  useEffect(() => {
    const receive = (event: Event) => {
      if (event instanceof StorageEvent && event.key !== null && event.key !== SIDEBAR_SECTIONS_STORAGE_KEY) return
      const next = event instanceof CustomEvent
        ? event.detail as SidebarCollapsed
        : readStoredCollapsed(SIDEBAR_SECTIONS_STORAGE_KEY)
      latest.current = next
      setCollapsed(next)
    }
    window.addEventListener('storage', receive)
    window.addEventListener(CHANGED, receive)
    return () => {
      window.removeEventListener('storage', receive)
      window.removeEventListener(CHANGED, receive)
    }
  }, [])
  useEffect(() => {
    if (projectId === null || Object.keys(pending).length === 0) return
    const next = { ...latest.current }
    for (const [section, value] of Object.entries(pending)) {
      next[JSON.stringify([projectId, section])] = value
    }
    // Consume once: later switches between known projects must not carry these choices along.
    setPending({})
    latest.current = next
    setCollapsed(next)
    writeStoredCollapsed(next, SIDEBAR_SECTIONS_STORAGE_KEY)
    window.dispatchEvent(new CustomEvent(CHANGED, { detail: next }))
  }, [projectId, pending])
  // A tuple avoids ambiguous delimiters in canonical project ids. Callers resolve the `default`
  // alias to null until health identifies the boot project.
  const keyOf = (section: BucketLabel) => JSON.stringify([projectId, section])
  const isCollapsed = (section: BucketLabel) => section !== 'Archived' && (pending[section] ?? collapsed[keyOf(section)]) === true
  const toggle = (section: Exclude<BucketLabel, 'Archived'>) => {
    if (projectId === null) {
      setPending(current => ({ ...current, [section]: current[section] !== true }))
      return
    }
    const key = keyOf(section)
    const next = { ...latest.current, [key]: latest.current[key] !== true }
    latest.current = next
    setCollapsed(next)
    writeStoredCollapsed(next, SIDEBAR_SECTIONS_STORAGE_KEY)
    // Synchronize mounted desktop/mobile copies, including when storage is unavailable.
    window.dispatchEvent(new CustomEvent(CHANGED, { detail: next }))
  }
  return { isCollapsed, toggle }
}
