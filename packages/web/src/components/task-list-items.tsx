import { Component, useContext, useLayoutEffect, useRef, useState, type ReactNode, type ReactElement } from 'react'
import { useSearchParams } from 'react-router'
import { Virtualizer, type VirtualizerHandle } from 'virtua'
import { useTaskEditingRunId } from '@/lib/task-title-editor'
import { TaskListFocusContext, useTaskListFocus } from '@/lib/use-task-list-focus'
import { taskListKeepMounted, virtualizeTaskList } from '@/lib/task-list-render'

/** One item includes its expanded preview. The page remains the sole vertical scroll owner. */
export function TaskListItems<T>({ items, itemKey, children }: {
  items: readonly T[]
  itemKey: (item: T) => string
  children: (item: T, index: number) => ReactElement
}) {
  const [params] = useSearchParams()
  const scroll = useRef<HTMLElement | null>(null)
  const handle = useRef<VirtualizerHandle>(null)
  const [geometry, setGeometry] = useState({ available: false, margin: 0 })
  const [focused, setFocused] = useState<string | null>(null)
  const editing = useTaskEditingRunId()
  const pageFocus = useContext(TaskListFocusContext)
  const keys = items.map(itemKey)
  const virtual = geometry.available && virtualizeTaskList(items.length, params.get('tasks'))
  const focus = useTaskListFocus(String(virtual))
  const root = focus.ref
  useLayoutEffect(() => {
    const element = root.current
    const owner = element?.closest<HTMLElement>('[data-slot="main"]')
    scroll.current = owner ?? null
    if (!element || !owner) return
    const measure = () => setGeometry({ available: true, margin: Math.max(0,
      element.getBoundingClientRect().top - owner.getBoundingClientRect().top + owner.scrollTop) })
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
    {virtual ? <VirtualTaskItems items={items} keys={keys} handle={handle} scroll={scroll} margin={geometry.margin} focused={pageFocus?.focused ?? focused} editing={editing}>{children}</VirtualTaskItems>
      : items.map((item, index) => <div key={keys[index]} data-task-item={keys[index]} data-first={index === 0} data-last={index === items.length - 1} className="task-list-flat-item">{children(item, index)}</div>)}
  </div>
}

function VirtualTaskItems<T>({ items, keys, handle, scroll, margin, focused, editing, children }: {
  items: readonly T[]; keys: readonly string[]
  handle: React.RefObject<VirtualizerHandle | null>; scroll: React.RefObject<HTMLElement | null>
  margin: number; focused: string | null; editing: string | null
  children: (item: T, index: number) => ReactElement
}) {
  const previous = useRef(keys)
  // Virtua's shift path preserves the visible anchor for prepends, including size corrections.
  const added = keys.length - previous.current.length
  const shift = added > 0 && previous.current.every((key, index) => keys[index + added] === key)
  useLayoutEffect(() => { previous.current = keys })
  return <TaskListScrollAnchor revision={keys} keys={keys} scroll={scroll} handle={handle} shifting={shift}><Virtualizer ref={handle} scrollRef={scroll} startMargin={margin} shift={shift}
    keepMounted={[...new Set([...taskListKeepMounted(keys, focused), ...taskListKeepMounted(keys, editing)])]} data={items}>
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
