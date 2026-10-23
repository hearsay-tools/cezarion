import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export interface SummaryItem {
  id: string
  /** Smaller values disappear first. Equal priorities disappear together. */
  priority: number
  content: ReactNode
}

/** Keep whole values in the available space, independent of viewport or text length.
 * CSS provides a single clipped line while measurements are unavailable. Hidden items keep
 * their intrinsic width for measurement, but leave both the flow and the accessibility tree.
 * `lead` (CSS px) is space the first shown value needs before it. It belongs to the summary,
 * so the width it measures never depends on what it shows: a parent margin that appeared
 * with the first value let one value show, shrink the room, hide and repeat on every frame
 * (hearsay-tools/cezarion#1537). */
export function ActivitySummary({ items, lead = 0 }: { items: SummaryItem[]; lead?: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [cutoff, setCutoff] = useState(-Infinity)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const width = element.getBoundingClientRect().width
      // No layout box means no measurement yet. A laid-out zero width is real: the folded
      // Activity header leaves the summary no room on a phone, and then every value hides.
      if (!width && element.getClientRects().length === 0) return
      const style = getComputedStyle(element)
      // Rectangles include ancestor zoom and transforms; computed gaps use CSS pixels.
      const cssWidth = Number.parseFloat(style.width)
      const scale = cssWidth > 0 ? width / cssWidth : 1
      const gap = (Number.parseFloat(style.columnGap) || 0) * scale
      const widths = Array.from(element.children, child => child.getBoundingClientRect().width)
      let remaining = items.map((item, index) => ({ ...item, width: widths[index] ?? 0 }))
      let next = -Infinity
      const total = () => remaining.reduce((sum, item) => sum + item.width, 0) + Math.max(0, remaining.length - 1) * gap + (remaining.length > 0 ? lead * scale : 0)
      for (const priority of [...new Set(items.map(item => item.priority))].sort((a, b) => a - b)) {
        if (total() <= width) break
        next = priority
        remaining = remaining.filter(item => item.priority > priority)
      }
      setCutoff(previous => previous === next ? previous : next)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const child of element.children) observer.observe(child)
    return () => observer.disconnect()
  }, [items, lead])
  return (
    <span ref={ref} data-slot="activity-summary" className="relative flex h-[max(1.5em,22px)] min-w-0 flex-1 items-center gap-2.5 overflow-clip whitespace-nowrap text-[13px] font-normal text-muted-foreground tabular-nums">
      {items.map(item => {
        const hidden = item.priority <= cutoff
        const first = item === items.find(candidate => candidate.priority > cutoff)
        return (
          <span key={item.id} data-summary-item={item.id} data-hidden={hidden} aria-hidden={hidden || undefined} inert={hidden || undefined}
            style={first && lead ? { marginInlineStart: lead } : undefined}
            className="inline-flex w-max shrink-0 items-center gap-1.5 data-[hidden=true]:invisible data-[hidden=true]:absolute">
            {item.content}
          </span>
        )
      })}
    </span>
  )
}
