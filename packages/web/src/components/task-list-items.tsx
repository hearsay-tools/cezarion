import { Component, useContext, useLayoutEffect, useRef, useState, type ReactNode, type ReactElement, type ComponentProps } from 'react'
import { flushSync } from 'react-dom'
import { useSearchParams } from 'react-router'
import { Virtualizer, type VirtualizerHandle } from 'virtua'
import { useTaskEditingRunId } from '@/lib/task-title-editor'
import { TaskListFocusContext, useTaskListFocus, useTaskListFocusState } from '@/lib/use-task-list-focus'
import { taskListKeepMounted, virtualizeTaskList } from '@/lib/task-list-render'

/** Virtual lists by their element, so the page anchor can locate a run that is not mounted. */
const logicalLists = new WeakMap<HTMLElement, { keys: readonly string[]; handle: React.RefObject<VirtualizerHandle | null>; measure: () => void }>()

/** One item includes its expanded preview. The page remains the sole vertical scroll owner. */
export function TaskListItems<T>({ items, itemKey, children, itemSize }: {
  items: readonly T[]
  itemSize?: number
  itemKey: (item: T) => string
  children: (item: T, index: number) => ReactElement
}) {
  const [params] = useSearchParams()
  const scroll = useRef<HTMLElement | null>(null)
  const handle = useRef<VirtualizerHandle>(null)
  const [geometry, setGeometry] = useState<{ available: boolean | null; margin: number }>({ available: null, margin: 0 })
  const [focused, setFocused] = useState<string | null>(null)
  const editing = useTaskEditingRunId()
  const pageFocus = useContext(TaskListFocusContext)
  const keys = items.map(itemKey)
  const eligible = virtualizeTaskList(items.length, params.get('tasks'))
  const virtual = geometry.available === true && eligible
  const listId = useRef(Symbol('task-list'))
  const measureMargin = useRef(() => {})
  useLayoutEffect(() => {
    pageFocus?.registerList?.(listId.current, keys)
    const element = root.current
    if (element) logicalLists.set(element, { keys, handle, measure: () => measureMargin.current() })
    return () => {
      pageFocus?.registerList?.(listId.current, null)
      if (element) logicalLists.delete(element)
    }
  })
  const focus = useTaskListFocus(String(virtual), undefined, undefined, (key) => keys.includes(key))
  const root = focus.ref
  // Resolve the owner and mount visible rows before paint; no empty state is displayed.
  useLayoutEffect(() => {
    const element = root.current
    const owner = element?.closest<HTMLElement>('[data-slot="main"]')
    scroll.current = owner ?? null
    if (!element || !owner) {
      setGeometry((previous) => previous.available === false ? previous : { available: false, margin: 0 })
      return
    }
    let previousMargin: number | null = null
    const measure = () => {
      const margin = Math.max(0, element.getBoundingClientRect().top - owner.getBoundingClientRect().top + owner.scrollTop)
      if (margin === previousMargin) return
      previousMargin = margin
      setGeometry((previous) => previous.available === true && previous.margin === margin ? previous : { available: true, margin })
    }
    measure()
    measureMargin.current = measure
    const observer = new ResizeObserver(measure)
    // Earlier groups can resize without changing this group's own size.
    for (let node: Element | null = element; node && node !== owner; node = node.parentElement) {
      observer.observe(node)
      for (const sibling of node.parentElement?.children ?? []) observer.observe(sibling)
    }
    observer.observe(owner)
    return () => observer.disconnect()
  }, [])
  return <div ref={root} data-slot="task-list-items" data-virtualized={virtual}
    onFocusCapture={(event) => {
      focus.onFocusCapture(event)
      setFocused((event.target as HTMLElement).closest<HTMLElement>('[data-task-item]')?.dataset.taskItem ?? null)
    }}
    onBlurCapture={(event) => {
      focus.onBlurCapture(event)
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setFocused(null)
    }}>
    {virtual ? <VirtualTaskItems itemSize={itemSize} items={items} keys={keys} handle={handle} scroll={scroll} margin={geometry.margin} focused={pageFocus?.focused ?? focused} editing={editing}>{children}</VirtualTaskItems>
      : (geometry.available === null && eligible ? [] : items).map((item, index) => <div key={keys[index]} data-task-item={keys[index]} data-first={index === 0} data-last={index === items.length - 1} className="task-list-flat-item">{children(item, index)}</div>)}
  </div>
}

/** Keep focus updates below the route's filtering and grouping work. */
export function TaskListFocusBoundary({ layout, revision, visibilityRevision = '', children, ...props }: ComponentProps<'div'> & { layout: string; revision: unknown; visibilityRevision?: string }) {
  const focus = useTaskListFocusState(layout, revision, true)
  return <TaskListFocusContext value={focus.value}><TaskListScrollAnchor revision={revision} visibilityRevision={`${layout}:${visibilityRevision}`}>
    <div {...props} {...focus.props}>{children}</div>
  </TaskListScrollAnchor></TaskListFocusContext>
}

function VirtualTaskItems<T>({ items, keys, handle, scroll, margin, focused, editing, children, itemSize }: {
  itemSize: number | undefined
  items: readonly T[]; keys: readonly string[]
  handle: React.RefObject<VirtualizerHandle | null>; scroll: React.RefObject<HTMLElement | null>
  margin: number; focused: string | null; editing: string | null
  children: (item: T, index: number) => ReactElement
}) {
  const [measured, setMeasured] = useState(false)
  useLayoutEffect(() => {
    const owner = scroll.current
    if (!owner) return
    const observer = new ResizeObserver((entries) => {
      if (entries.some((entry) => entry.contentRect.height > 0)) {
        setMeasured(true)
        observer.disconnect()
      }
    })
    observer.observe(owner)
    return () => observer.disconnect()
  }, [scroll])
  return <Virtualizer ref={handle} {...(itemSize === undefined ? {} : { itemSize })} scrollRef={scroll} startMargin={margin}
    keepMounted={[...new Set([...(!measured && items.length ? [0] : []), ...taskListKeepMounted(keys, focused), ...taskListKeepMounted(keys, editing)])]} data={items}>
    {(item, index) => <div key={keys[index]} data-task-item={keys[index]} data-first={index === 0} data-last={index === items.length - 1}>{children(item, index)}</div>}
  </Virtualizer>
}

type Snapshot = { key: string | null; top: number; scrollTop: number }

/**
 * Keeps the first visible run in place across a content commit (ADR 0034). Three parts share the work:
 * native `overflow-anchor` keeps the visible list in place when content above it changes, virtua keeps its own
 * rows in place when a row above its viewport resizes, and this boundary covers what both leave after a commit:
 * a count change above the anchor inside the anchor's own virtual list, and virtua's stored offset, which misses
 * a native adjustment until the next scroll event. It writes at most once per commit and never later, so user
 * input and other programmatic scrolls always win. It never uses virtua's scroll scheduler: that scheduler
 * re-applies its target on later size events and would undo virtua's own compensation.
 */
export class TaskListScrollAnchor extends Component<{ revision: unknown; visibilityRevision?: string; children: ReactNode }, object, Snapshot | null> {
  private root = { current: null as HTMLDivElement | null }
  private owner() { return this.root.current?.closest<HTMLElement>('[data-slot="main"]') ?? null }
  override getSnapshotBeforeUpdate(previous: Readonly<typeof this.props>): Snapshot | null {
    if (previous.revision === this.props.revision && previous.visibilityRevision === this.props.visibilityRevision) return null
    const owner = this.owner()
    if (!owner || !this.root.current) return null
    // Reads only, before React mutates the DOM: one layout for the whole snapshot.
    const viewport = owner.getBoundingClientRect()
    for (const element of this.root.current.querySelectorAll<HTMLElement>('[data-task-item]')) {
      const rect = element.getBoundingClientRect()
      if (rect.bottom > viewport.top && rect.top < viewport.bottom) return { key: element.dataset.taskItem!, top: rect.top, scrollTop: owner.scrollTop }
    }
    return { key: null, top: 0, scrollTop: owner.scrollTop }
  }
  override componentDidUpdate(_previous: Readonly<typeof this.props>, _state: object, snapshot: Snapshot | null) {
    const owner = this.owner()
    if (!snapshot || !owner) return
    // A filtered-out anchor keeps scrollTop; the browser clamps it to the new height.
    const top = snapshot.key === null ? null : this.currentTop(snapshot.key)
    if (top !== null && Math.abs(top - snapshot.top) > 0.5) owner.scrollTop += top - snapshot.top
    // Before paint, give every virtualizer this commit's start margin and offset in one render: a stale margin with a
    // new offset renders the wrong range for a frame. After the commit, so virtua's re-render is outside a lifecycle.
    queueMicrotask(() => {
      if (!owner.isConnected) return
      flushSync(() => {
        for (const element of this.root.current?.querySelectorAll<HTMLElement>('[data-slot="task-list-items"]') ?? []) logicalLists.get(element)?.measure()
        // Virtua's next resize compensation adds to its stored offset, which misses this commit's native adjustment.
        if (owner.scrollTop !== snapshot.scrollTop) owner.dispatchEvent(new Event('scroll'))
      })
    })
  }
  /** The run's current top: its row, or the position virtua will render it at. */
  private currentTop(key: string) {
    for (const element of this.root.current?.querySelectorAll<HTMLElement>('[data-task-item]') ?? []) {
      if (element.dataset.taskItem === key) return element.getBoundingClientRect().top
    }
    for (const element of this.root.current?.querySelectorAll<HTMLElement>('[data-slot="task-list-items"]') ?? []) {
      const list = logicalLists.get(element)
      const index = list?.keys.indexOf(key) ?? -1
      const handle = list?.handle.current
      if (index >= 0 && handle) return element.getBoundingClientRect().top + handle.getItemOffset(index)
    }
    return null
  }
  override render() { return <div ref={this.root} style={{ display: 'contents' }}>{this.props.children}</div> }
}
