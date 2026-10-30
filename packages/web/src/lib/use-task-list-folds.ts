import { useCallback, useEffect, useRef, useState } from 'react'

import { readStoredCollapsed, writeStoredCollapsed, type SidebarCollapsed } from './sidebar-collapse'
import { parseSectionParam, SECTION_PARAM, SIDEBAR_SECTIONS, type BucketLabel, type ListView } from './task-groups'
import { useSearchParamsWriter } from './use-search-params-writer'

/** Browser-local, like the sidebar's section folds, and in its own key: folding Finished on the
 *  Tasks page must not fold it in the sidebar (hearsay-tools/cezarion#1616). */
export const TASK_LIST_FOLDS_STORAGE_KEY = 'cez-task-list-folds'

const CHANGED = 'cez-task-list-folds-changed'

/**
 * The status groups' fold state for one task list. `scope` names the list (`project:<id>` or
 * `global`) and `view` the archive tab, so Active and Archived keep separate answers. Groups start
 * open: an absent entry is open.
 *
 * `revealed` is the search override: a folded group holding a match shows its rows while the
 * search lasts, and the saved choice is never written for it, so clearing the search folds it
 * again.
 */
export function useTaskListFolds(scope: string, view: ListView, revealed: ReadonlySet<BucketLabel> = new Set()) {
  const [stored, setStored] = useState<SidebarCollapsed>(() => readStoredCollapsed(TASK_LIST_FOLDS_STORAGE_KEY))
  useEffect(() => {
    const receive = (event: Event) => {
      if (event instanceof StorageEvent && event.key !== null && event.key !== TASK_LIST_FOLDS_STORAGE_KEY) return
      setStored(event instanceof CustomEvent ? event.detail as SidebarCollapsed : readStoredCollapsed(TASK_LIST_FOLDS_STORAGE_KEY))
    }
    window.addEventListener('storage', receive)
    window.addEventListener(CHANGED, receive)
    return () => {
      window.removeEventListener('storage', receive)
      window.removeEventListener(CHANGED, receive)
    }
  }, [])
  const keyOf = useCallback((label: BucketLabel) => JSON.stringify([scope, view, label]), [scope, view])
  const write = useCallback((change: (current: SidebarCollapsed) => SidebarCollapsed) => {
    setStored((current) => {
      const next = change(current)
      writeStoredCollapsed(next, TASK_LIST_FOLDS_STORAGE_KEY)
      // Keep the page's other mounted copies (desktop table and mobile cards) in step.
      queueMicrotask(() => window.dispatchEvent(new CustomEvent(CHANGED, { detail: next })))
      return next
    })
  }, [])
  /** The saved choice, ignoring the search override: what the disclosure reports. */
  const isFolded = (label: BucketLabel) => stored[keyOf(label)] === true
  const isCollapsed = (label: BucketLabel) => isFolded(label) && !revealed.has(label)
  const toggle = (label: BucketLabel) => write((current) => ({ ...current, [keyOf(label)]: current[keyOf(label)] !== true }))
  /** Expand groups / Collapse groups: visibility only, never a filter. */
  const setAll = (labels: readonly BucketLabel[], collapsed: boolean) =>
    write((current) => ({ ...current, ...Object.fromEntries(labels.map((label) => [keyOf(label), collapsed])) }))
  /** Unfold `open` and fold the rest of `labels`, in one saved write. */
  const only = useCallback((open: BucketLabel, labels: readonly BucketLabel[]) =>
    write((current) => ({ ...current, ...Object.fromEntries(labels.map((label) => [keyOf(label), label !== open])) })), [write, keyOf])
  return { isFolded, isCollapsed, toggle, setAll, only }
}

/**
 * `useTaskListFolds`, plus the sidebar's "3 of 24" link (`?section=`). On arrival the named
 * section opens and the other status sections fold. The choice is saved, as if the reader had
 * clicked each disclosure, and the parameter leaves the URL so a reload keeps their later folds.
 *
 * `onSection` runs on arrival too. The page clears its search there: the link promises the whole
 * section, and a search typed just before the click would otherwise still filter it.
 */
export function useTaskListFoldsFromUrl(scope: string, view: ListView, revealed?: ReadonlySet<BucketLabel>, onSection?: () => void) {
  const folds = useTaskListFolds(scope, view, revealed)
  const arrived = useRef(onSection)
  arrived.current = onSection
  const [params, write] = useSearchParamsWriter()
  // The link carries no `archived`, so a reader on the Archived tab lands on Active first.
  const section = view === 'active' ? parseSectionParam(params.get(SECTION_PARAM)) : null
  const { only } = folds
  useEffect(() => {
    if (section === null) return
    only(section, SIDEBAR_SECTIONS)
    arrived.current?.()
    write((current) => {
      current.delete(SECTION_PARAM)
      return current
    })
  }, [section, only, write])
  return folds
}
