import { Component, useContext, useLayoutEffect, useRef, useState, type ReactNode, type ReactElement, type ComponentProps } from 'react'
import { useSearchParams } from 'react-router'
import { Virtualizer, type VirtualizerHandle } from 'virtua'
import { useTaskEditingRunId } from '@/lib/task-title-editor'
import { TaskListFocusContext, useTaskListFocus, useTaskListFocusState } from '@/lib/use-task-list-focus'
import { taskListKeepMounted, virtualizeTaskList } from '@/lib/task-list-render'

const logicalLists = new WeakMap<HTMLElement, { keys: readonly string[]; handle: React.RefObject<VirtualizerHandle | null>; margin: number }>()

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
  useLayoutEffect(() => {
    pageFocus?.registerList?.(listId.current, keys)
    const element = root.current
    if (element) logicalLists.set(element, { keys, handle, margin: geometry.margin })
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
  revision: unknown; visibilityRevision?: string; keys?: readonly string[]; scroll?: React.RefObject<HTMLElement | null>; shifting?: boolean; handle?: React.RefObject<VirtualizerHandle | null>; children: ReactNode
}, object, { key: string; top: number; offset: number } | null> {
  private root = { current: null as HTMLDivElement | null }
  private anchor: { key: string; top: number; offset: number } | null = null
  private pendingAnchor = false
  private pendingRestores = 0
  private pendingSince = 0
  private lastRetryOffset: number | undefined
  private finishUpdate: (() => void) | undefined
  private stopObserving: (() => void) | undefined
  override componentDidMount() {
    // Only the page boundary owns cross-group corrections. Inner anchors handle item changes.
    if (this.props.keys) return
    const root = this.root.current
    const owner = root?.closest<HTMLElement>('[data-slot="main"]')
    if (!root || !owner) return
    let capturedScrollTop = owner.scrollTop
    const capture = () => { this.anchor = this.capture(); capturedScrollTop = owner.scrollTop }
    let frame = 0
    const settle = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => {
        if (this.pendingAnchor && this.anchor && !this.anchorSettled(owner, this.anchor) && owner.scrollTop !== this.lastRetryOffset) {
          this.lastRetryOffset = owner.scrollTop
          if (this.restore(this.anchor)) { settle(); return }
        }
        this.pendingAnchor = false
        capture()
      }) })
    }
    this.finishUpdate = settle
    const observer = new ResizeObserver(() => {
      if (this.pendingAnchor || owner.scrollTop === capturedScrollTop) this.restore(this.anchor)
      if (!this.pendingAnchor) capture()
      settle()
    })
    const observed = new Set<Element>()
    const observe = () => {
      for (const node of observed) if (!node.isConnected) { observer.unobserve(node); observed.delete(node) }
      for (const list of root.querySelectorAll('[data-slot="task-list-items"]')) {
        for (let node: Element | null = list; node && node !== root; node = node.parentElement) {
          if (!observed.has(node)) { observed.add(node); observer.observe(node) }
        }
      }
    }
    const mutations = new MutationObserver(observe)
    mutations.observe(root, { childList: true, subtree: true })
    observe()
    capture()
    const scrolled = () => { if (this.pendingAnchor) { this.restore(this.anchor); settle() } else capture() }
    const intent = () => { this.pendingAnchor = false; cancelAnimationFrame(frame) }
    owner.addEventListener('scroll', scrolled, { passive: true })
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) owner.addEventListener(event, intent, { passive: true })
    this.stopObserving = () => {
      observer.disconnect(); mutations.disconnect(); cancelAnimationFrame(frame)
      owner.removeEventListener('scroll', scrolled)
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) owner.removeEventListener(event, intent)
    }
  }
  override componentWillUnmount() { this.stopObserving?.() }
  private capture(keys = this.props.keys) {
    const owner = this.props.scroll?.current ?? this.root.current?.closest<HTMLElement>('[data-slot="main"]')
    if (!owner) return null
    const viewport = owner.getBoundingClientRect()
    const first = [...(this.root.current?.querySelectorAll<HTMLElement>('[data-task-item]') ?? [])]
      .find((element) => { const rect = element.getBoundingClientRect(); return rect.bottom > viewport.top && rect.top < viewport.bottom })
    if (!first) return null
    const key = first.dataset.taskItem!
    return { key, top: first.getBoundingClientRect().top, offset: this.props.handle?.current?.getItemOffset(keys?.indexOf(key) ?? -1) ?? 0 }
  }
  override getSnapshotBeforeUpdate(previous: Readonly<typeof this.props>) {
    if (this.props.shifting) return null
    if (previous.revision === this.props.revision && previous.visibilityRevision === this.props.visibilityRevision) return null
    const snapshot = this.capture(previous.keys)
    if (!this.props.keys) {
      this.anchor = snapshot; this.pendingAnchor = true
      this.pendingRestores = 0; this.pendingSince = performance.now(); this.lastRetryOffset = undefined
    }
    return snapshot
  }
  override componentDidUpdate(_previous: Readonly<typeof this.props>, _state: object, snapshot: { key: string; top: number; offset: number } | null) {
    const owner = this.root.current?.closest<HTMLElement>('[data-slot="main"]')
    if (!this.props.keys && snapshot && owner && this.anchorSettled(owner, snapshot)) this.pendingAnchor = false
    this.restore(snapshot)
    if (!this.props.keys && this.pendingAnchor) this.finishUpdate?.()
  }
  private restore(snapshot: { key: string; top: number; offset: number } | null) {
    // Async virtualizer corrections may need a retry, but an unreachable target must release.
    if (this.pendingAnchor && (this.pendingRestores++ >= 10 || performance.now() - this.pendingSince >= 1000)) {
      this.pendingAnchor = false
      return false
    }
    return this.restorePosition(snapshot)
  }
  private restorePosition(snapshot: { key: string; top: number; offset: number } | null) {
    if (!snapshot) return false
    const owner = this.props.scroll?.current ?? this.root.current?.closest<HTMLElement>('[data-slot="main"]')
    const next = [...(this.root.current?.querySelectorAll<HTMLElement>('[data-task-item]') ?? [])].find((element) => element.dataset.taskItem === snapshot.key)
    if (!this.props.keys && this.pendingAnchor && owner && (!next || Math.abs(next.getBoundingClientRect().top - snapshot.top) > 1) && this.restoreLogical(owner, snapshot)) return true
    if (owner && next) { owner.scrollTop += next.getBoundingClientRect().top - snapshot.top; return true }
    else {
      const index = this.props.keys?.indexOf(snapshot.key) ?? -1
      const handle = this.props.handle?.current
      if (index >= 0 && handle) { handle.scrollBy(handle.getItemOffset(index) - snapshot.offset); return true }
    }
    return false
  }
  private anchorSettled(owner: HTMLElement, snapshot: { key: string; top: number }) {
    const next = [...(this.root.current?.querySelectorAll<HTMLElement>('[data-task-item]') ?? [])].find(element => element.dataset.taskItem === snapshot.key)
    if (!next || Math.abs(next.getBoundingClientRect().top - snapshot.top) > 1) return false
    const element = next.closest<HTMLElement>('[data-slot="task-list-items"]')
    const list = element && logicalLists.get(element)
    const handle = list?.handle.current
    if (!element || !handle || !list) return true
    const margin = element.getBoundingClientRect().top - owner.getBoundingClientRect().top + owner.scrollTop
    return Math.abs(handle.scrollOffset - owner.scrollTop) <= 1 && Math.abs(list.margin - margin) <= 1
  }
  private restoreLogical(owner: HTMLElement, snapshot: { key: string; top: number }) {
    // A fold can clamp scrolling and unmount the anchor before its new range renders.
    for (const element of this.root.current?.querySelectorAll<HTMLElement>('[data-slot="task-list-items"]') ?? []) {
      const list = logicalLists.get(element)
      const index = list?.keys.indexOf(snapshot.key) ?? -1
      const handle = list?.handle.current
      if (index < 0 || !handle) continue
      handle.scrollTo(owner.scrollTop + element.getBoundingClientRect().top + handle.getItemOffset(index) - snapshot.top)
      return true
    }
    return false
  }
  override render() { return <div ref={this.root} style={{ display: 'contents' }}>{this.props.children}</div> }
}
