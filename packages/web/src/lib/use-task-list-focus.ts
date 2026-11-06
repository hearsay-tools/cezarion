import { createContext, useLayoutEffect, useMemo, useRef, useState, type FocusEvent } from 'react'

/** A layout swap replaces row controls. Restore focus only if that swap removed its owner. */
export const TaskListFocusContext = createContext<{ focused: string | null; revision: unknown } | null>(null)

export function useTaskListFocusState(layout: string, revision: unknown) {
  const [focused, setFocused] = useState<string | null>(null)
  const props = useTaskListFocus(layout, revision, setFocused)
  const value = useMemo(() => ({ focused, revision }), [focused, revision])
  return { props, value }
}

export function useTaskListFocus(layout: string, revision?: unknown, onFocused?: (key: string | null) => void) {
  const ref = useRef<HTMLDivElement>(null)
  const focused = useRef<{ element: HTMLElement; runId: string; project: string | undefined; control: string | null; label: string | null; tag: string } | null>(null)
  const onFocusCapture = (event: FocusEvent<HTMLDivElement>) => {
    const element = event.target as HTMLElement
    const row = element.closest<HTMLElement>('[data-run-id]')
    focused.current = row ? {
      element, runId: row.dataset.runId!, project: row.dataset.project, control: element.dataset.taskControl ?? null,
      label: element.getAttribute('aria-label'), tag: element.tagName,
    } : null
    onFocused?.(row ? row.dataset.project ? `${row.dataset.project}/${row.dataset.runId}` : row.dataset.runId! : null)
  }
  const onBlurCapture = (event: FocusEvent<HTMLDivElement>) => {
    const element = event.target as HTMLElement
    const container = event.currentTarget
    // Removal can emit blur before React detaches the old control. Check after the swap.
    queueMicrotask(() => {
      if (focused.current?.element === element && element.isConnected && !container.contains(document.activeElement)) {
        focused.current = null
        onFocused?.(null)
      }
    })
  }
  useLayoutEffect(() => {
    const previous = focused.current
    if (!previous || previous.element.isConnected || document.activeElement !== document.body) return
    const restore = () => {
      // A user focus move takes precedence over a pending layout restoration.
      if (document.activeElement !== document.body || previous.element.isConnected) return true
      const rows = [...(ref.current?.querySelectorAll<HTMLElement>('[data-run-id]') ?? [])]
        .filter((element) => element.dataset.runId === previous.runId && element.dataset.project === previous.project)
      const controls = rows.flatMap((row) => [...row.querySelectorAll<HTMLElement>('a,button,input')])
      const same = controls.find((element) => previous.control
        ? element.dataset.taskControl === previous.control
        : element.tagName === previous.tag && element.getAttribute('aria-label') === previous.label)
      // Phone cards have no inline rename control; their task link remains the way into editing.
      const next = same ?? controls.find((element) => element.tagName === 'A')
      next?.focus({ preventScroll: true })
      return !!next && document.activeElement === next
    }
    if (restore() || !ref.current) return
    // Virtual rows mount after their owner geometry resolves, in a child-only update.
    // Retry only during that gap; do not make route derivations depend on row mounts.
    const observer = new MutationObserver(() => { if (restore()) observer.disconnect() })
    observer.observe(ref.current, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
    return () => observer.disconnect()
  }, [layout, revision])
  return { ref, onFocusCapture, onBlurCapture }
}
