import { useEffect, useRef, useState } from 'react'
import { readStoredCollapsed, SIDEBAR_SECTIONS_STORAGE_KEY, writeStoredCollapsed, type SidebarCollapsed } from './sidebar-collapse'
import type { BucketLabel } from './task-groups'

const CHANGED = 'cez-sidebar-sections-changed'

/** Browser-local section state, separate from project folding. The canonical project id also
 * lets the flat desktop list and mobile project tree share the same answer. */
export function useSidebarSections(projectId: string | null) {
  const [collapsed, setCollapsed] = useState(() => readStoredCollapsed(SIDEBAR_SECTIONS_STORAGE_KEY))
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
  // A tuple avoids ambiguous delimiters in project ids. Null is a transient, unpersisted list
  // while health resolves the boot project's canonical id; never write the `default` alias.
  const keyOf = (section: BucketLabel) => JSON.stringify([projectId, section])
  const isCollapsed = (section: BucketLabel) => section !== 'Archived' && collapsed[keyOf(section)] === true
  const toggle = (section: Exclude<BucketLabel, 'Archived'>) => {
    const key = keyOf(section)
    const next = { ...latest.current, [key]: latest.current[key] !== true }
    latest.current = next
    setCollapsed(next)
    if (projectId !== null) {
      writeStoredCollapsed(next, SIDEBAR_SECTIONS_STORAGE_KEY)
      // Synchronize mounted desktop/mobile copies, including when storage is unavailable.
      window.dispatchEvent(new CustomEvent(CHANGED, { detail: next }))
    }
  }
  return { isCollapsed, toggle }
}
