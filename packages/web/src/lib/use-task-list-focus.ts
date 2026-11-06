import { useLayoutEffect, useRef, type FocusEvent } from 'react'

/** A layout swap replaces row controls. Restore focus only if that swap removed its owner. */
export function useTaskListFocus(layout: string) {
  const ref = useRef<HTMLDivElement>(null)
  const focused = useRef<{ element: HTMLElement; runId: string; control: string | null; label: string | null; tag: string } | null>(null)
  const onFocusCapture = (event: FocusEvent<HTMLDivElement>) => {
    const element = event.target as HTMLElement
    const row = element.closest<HTMLElement>('[data-run-id]')
    focused.current = row ? {
      element, runId: row.dataset.runId!, control: element.dataset.taskControl ?? null,
      label: element.getAttribute('aria-label'), tag: element.tagName,
    } : null
  }
  useLayoutEffect(() => {
    const previous = focused.current
    if (!previous || previous.element.isConnected || document.activeElement !== document.body) return
    const row = [...(ref.current?.querySelectorAll<HTMLElement>('[data-run-id]') ?? [])]
      .find((element) => element.dataset.runId === previous.runId)
    const controls = [...(row?.querySelectorAll<HTMLElement>('a,button,input') ?? [])]
    const same = controls.find((element) => previous.control
      ? element.dataset.taskControl === previous.control
      : element.tagName === previous.tag && element.getAttribute('aria-label') === previous.label)
    // Phone cards have no inline rename control; their task link remains the way into editing.
    ;(same ?? controls.find((element) => element.tagName === 'A'))?.focus()
  }, [layout])
  return { ref, onFocusCapture }
}
