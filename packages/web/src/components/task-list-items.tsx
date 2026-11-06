import { Component, useContext, useLayoutEffect, useRef, useState, type ReactNode, type ReactElement, type ComponentProps } from 'react'
import { useSearchParams } from 'react-router'
import { Virtualizer, type VirtualizerHandle } from 'virtua'
import { useTaskEditingRunId } from '@/lib/task-title-editor'
import { TaskListFocusContext, useTaskListFocus, useTaskListFocusState } from '@/lib/use-task-list-focus'
import { taskListKeepMounted, virtualizeTaskList } from '@/lib/task-list-render'

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
  const focus = useTaskListFocus(String(virtual))
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
export function TaskListFocusBoundary({ layout, revision, children, ...props }: ComponentProps<'div'> & { layout: string; revision: unknown }) {
  const focus = useTaskListFocusState(layout, revision)
  return <TaskListFocusContext value={focus.value}><TaskListScrollAnchor revision={revision}>
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
  const previous = useRef(keys)
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
  // Virtua's shift path preserves the visible anchor for prepends, including size corrections.
  const added = keys.length - previous.current.length
  const shift = added > 0 && previous.current.every((key, index) => keys[index + added] === key)
  useLayoutEffect(() => { previous.current = keys })
  return <TaskListScrollAnchor revision={keys} keys={keys} scroll={scroll} handle={handle} shifting={shift}><Virtualizer ref={handle} {...(itemSize === undefined ? {} : { itemSize })} scrollRef={scroll} startMargin={margin} shift={shift}
    keepMounted={[...new Set([...(!measured && items.length ? [0] : []), ...taskListKeepMounted(keys, focused), ...taskListKeepMounted(keys, editing)])]} data={items}>
    {(item, index) => <div key={keys[index]} data-task-item={keys[index]} data-first={index === 0} data-last={index === items.length - 1}>{children(item, index)}</div>}
  </Virtualizer></TaskListScrollAnchor>
}

/** Capture before React mutates the item positions; keep the first visible run at its offset. */
export class TaskListScrollAnchor extends Component<{
  revision: unknown; keys?: readonly string[]; scroll?: React.RefObject<HTMLElement | null>; shifting?: boolean; handle?: React.RefObject<VirtualizerHandle | null>; children: ReactNode
}, object, { key: string; top: number; offset: number } | null> {
  private root = { current: null as HTMLDivElement | null }
  override getSnapshotBeforeUpdate(previous: Readonly<typeof this.props>) {
    if (this.props.shifting) return null
    if (previous.revision === this.props.revision) return null
    const owner = this.props.scroll?.current ?? this.root.current?.closest<HTMLElement>('[data-slot="main"]')
    if (!owner) return null
    const viewport = owner.getBoundingClientRect()
    const first = [...(this.root.current?.querySelectorAll<HTMLElement>('[data-task-item]') ?? [])]
      .find((element) => { const rect = element.getBoundingClientRect(); return rect.bottom > viewport.top && rect.top < viewport.bottom })
    if (!first) return null
    const key = first.dataset.taskItem!
    return { key, top: first.getBoundingClientRect().top, offset: this.props.handle?.current?.getItemOffset(previous.keys?.indexOf(key) ?? -1) ?? 0 }
  }
  override componentDidUpdate(_previous: Readonly<typeof this.props>, _state: object, snapshot: { key: string; top: number; offset: number } | null) {
    if (!snapshot) return
    const owner = this.props.scroll?.current ?? this.root.current?.closest<HTMLElement>('[data-slot="main"]')
    const next = [...(this.root.current?.querySelectorAll<HTMLElement>('[data-task-item]') ?? [])].find((element) => element.dataset.taskItem === snapshot.key)
    if (owner && next) owner.scrollTop += next.getBoundingClientRect().top - snapshot.top
    else {
      const index = this.props.keys?.indexOf(snapshot.key) ?? -1
      const handle = this.props.handle?.current
      if (index >= 0 && handle) handle.scrollBy(handle.getItemOffset(index) - snapshot.offset)
    }
  }
  override render() { return <div ref={this.root} style={{ display: 'contents' }}>{this.props.children}</div> }
}
