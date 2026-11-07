import { act, cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { Component, type ReactNode } from 'react'
import { TaskListItems, TaskListScrollAnchor, TaskListFocusBoundary } from './task-list-items'

// Keep all items mounted to isolate the before-mutation anchor from virtua's own sizing.
const virtualState = vi.hoisted(() => ({ hidden: null as string | null, scheduled: [] as string[], margins: [] as number[] }))
vi.mock('virtua', async () => {
  const React = await import('react')
  return { Virtualizer: React.forwardRef(function Virtualizer({ data, children, startMargin = 0 }: { data: string[]; startMargin?: number; children: (item: string, index: number) => ReactNode }, ref) {
    virtualState.margins.push(startMargin)
    const root = React.useRef<HTMLDivElement>(null)
    React.useImperativeHandle(ref, () => ({ getItemOffset: (index: number) => index * 60, scrollBy() { virtualState.scheduled.push('scrollBy') }, scrollTo(offset: number) { virtualState.scheduled.push('scrollTo'); root.current!.closest<HTMLElement>('[data-slot="main"]')!.scrollTop = offset } }))
    return <div ref={root}>{data.flatMap((item, index) => item === virtualState.hidden ? [] : [children(item, index)])}</div>
  }) }
})
afterEach(() => { virtualState.hidden = null; virtualState.scheduled = []; virtualState.margins = []; cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('keeps the first visible run in place after an insertion in the middle above it', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const owner = this.closest<HTMLElement>('[data-slot="main"]')
    const items = [...(owner?.querySelectorAll('[data-task-item]') ?? [])]
    const index = items.indexOf(this)
    const top = index >= 0 ? index * 60 - (owner?.scrollTop ?? 0) : 0
    return { top, bottom: top + (index >= 0 ? 60 : 300), height: index >= 0 ? 60 : 300, width: 1000, x: 0, y: top, left: 0, right: 1000, toJSON() {} }
  })
  const items = Array.from({ length: 120 }, (_, index) => `run-${index}`)
  const list = (data: string[]) => <MemoryRouter><div data-slot="main"><TaskListFocusBoundary layout="same" revision={data}><TaskListItems items={data} itemKey={(item) => item}>{(item) => <button>{item}</button>}</TaskListItems></TaskListFocusBoundary></div></MemoryRouter>
  const view = render(list(items))
  const owner = document.querySelector<HTMLElement>('[data-slot="main"]')!
  owner.scrollTop = 300
  view.rerender(list([...items.slice(0, 2), 'inserted', ...items.slice(2)]))
  expect(owner.scrollTop).toBe(360)
  expect(document.querySelector<HTMLElement>('[data-task-item="run-5"]')!.getBoundingClientRect().top).toBe(0)
})

it('anchors a later group when an earlier group grows and the visible group keys stay unchanged', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const owner = this.closest<HTMLElement>('[data-slot="main"]')
    const index = [...(owner?.querySelectorAll('[data-task-item]') ?? [])].indexOf(this)
    const top = index >= 0 ? index * 60 - (owner?.scrollTop ?? 0) : 0
    return { top, bottom: top + (index >= 0 ? 60 : 300), height: 60, width: 1000, x: 0, y: top, left: 0, right: 1000, toJSON() {} }
  })
  const first = ['a', 'b', 'c', 'd', 'e']
  const list = (earlier: string[]) => <div data-slot="main"><TaskListScrollAnchor revision={earlier}>
    <section>{earlier.map(key => <div key={key} data-task-item={key}>{key}</div>)}</section>
    <section>{['visible', 'next'].map(key => <div key={key} data-task-item={key}>{key}</div>)}</section>
  </TaskListScrollAnchor></div>
  const view = render(list(first))
  const owner = document.querySelector<HTMLElement>('[data-slot="main"]')!
  owner.scrollTop = 300
  view.rerender(list([...first.slice(0, 2), 'inserted', ...first.slice(2)]))
  expect(owner.scrollTop).toBe(360)
  expect(document.querySelector<HTMLElement>('[data-task-item="visible"]')!.getBoundingClientRect().top).toBe(0)
})

it.each(['fold', 'preview'])('captures before an earlier %s collapses, including browser scroll clamping', (mode) => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const owner = this.closest<HTMLElement>('[data-slot="main"]')
    const earlierHeight = Number(owner?.querySelector<HTMLElement>('[data-earlier-height]')?.dataset.earlierHeight ?? 0)
    const top = this.dataset.taskItem ? earlierHeight + 500 - (owner?.scrollTop ?? 0) : 0
    return { top, bottom: top + 60, height: 60, width: 1000 } as DOMRect
  })
  class FoldedGroups extends Component<{ folded: boolean }> {
    override componentDidUpdate() {
      const owner = document.querySelector<HTMLElement>('[data-slot="main"]')!
      // Model the browser's synchronous clamp before ResizeObserver or parent layout work.
      owner.scrollTop = Math.min(owner.scrollTop, 1800)
      owner.dispatchEvent(new Event('scroll'))
    }
    override render() { return <><section data-slot="task-list-items" data-earlier-height={this.props.folded ? (mode === 'fold' ? 100 : 0) : (mode === 'fold' ? 2000 : 300)} />
      <section data-slot="task-list-items"><div data-task-item="visible">Working run</div></section></> }
  }
  const list = (folded: boolean) => <div data-slot="main"><TaskListFocusBoundary layout="summary" revision="same-data" visibilityRevision={String(folded)}><FoldedGroups folded={folded} /></TaskListFocusBoundary></div>
  const view = render(list(false))
  const owner = document.querySelector<HTMLElement>('[data-slot="main"]')!
  owner.scrollTop = mode === 'fold' ? 2500 : 800
  owner.dispatchEvent(new Event('scroll'))
  view.rerender(list(true))
  expect(owner.scrollTop).toBe(mode === 'fold' ? 600 : 500)
  expect(document.querySelector<HTMLElement>('[data-task-item="visible"]')!.getBoundingClientRect().top).toBe(0)
})

it.each([
  ['survives', true, 1000, 240], ['removed', false, 1000, 300], ['removed-clamped', false, 260, 260],
] as const)('keeps query scroll rules when the anchor is %s', (_name, survives, maximum, expected) => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const owner = this.closest<HTMLElement>('[data-slot="main"]')
    const height = Number(owner?.querySelector<HTMLElement>('[data-height]')?.dataset.height ?? 0)
    const top = this.dataset.taskItem ? height - (owner?.scrollTop ?? 0) : 0
    return { top, bottom: top + 60, height: 60, width: 1000 } as DOMRect
  })
  class QueryRows extends Component<{ changed: boolean }> {
    override componentDidUpdate() {
      const owner = document.querySelector<HTMLElement>('[data-slot="main"]')!
      owner.scrollTop = Math.min(owner.scrollTop, maximum)
      owner.dispatchEvent(new Event('scroll'))
    }
    override render() { return <section data-slot="task-list-items" data-height={this.props.changed ? 240 : 300}>
      {(!this.props.changed || survives) && <div data-task-item="anchor">Anchor</div>}<div data-task-item="other">Other row</div>
    </section> }
  }
  const list = (changed: boolean) => <div data-slot="main"><TaskListFocusBoundary layout="same" revision={changed}><QueryRows changed={changed} /></TaskListFocusBoundary></div>
  const view = render(list(false))
  const owner = document.querySelector<HTMLElement>('[data-slot="main"]')!
  owner.scrollTop = 300
  owner.dispatchEvent(new Event('scroll'))
  view.rerender(list(true))
  expect(owner.scrollTop).toBe(expected)
})

it('restores the same logical virtual key when browser clamping unmounts its DOM row', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const keys = ['before-0', 'before-1', 'before-2', 'before-3', 'before-4', 'anchor', 'after']
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const owner = this.closest<HTMLElement>('[data-slot="main"]')
    const height = Number(owner?.querySelector<HTMLElement>('[data-height]')?.dataset.height ?? 0)
    const index = keys.indexOf(this.dataset.taskItem ?? '')
    const top = this.dataset.slot === 'task-list-items' ? height - (owner?.scrollTop ?? 0) : index >= 0 ? height + index * 60 - (owner?.scrollTop ?? 0) : 0
    return { top, bottom: top + (index >= 0 ? 60 : 300), height: 60, width: 1000 } as DOMRect
  })
  class Groups extends Component<{ folded: boolean }> {
    override componentDidUpdate() {
      const owner = document.querySelector<HTMLElement>('[data-slot="main"]')!
      owner.scrollTop = Math.min(owner.scrollTop, 1800)
      owner.dispatchEvent(new Event('scroll'))
    }
    override render() { return <><span data-height={this.props.folded ? 100 : 2000} /><TaskListItems items={keys} itemKey={key => key}>{key => <button>{key}</button>}</TaskListItems></> }
  }
  const list = (folded: boolean) => <MemoryRouter initialEntries={['/?tasks=virtual']}><div data-slot="main"><TaskListFocusBoundary layout="same" revision="same" visibilityRevision={String(folded)}><Groups folded={folded} /></TaskListFocusBoundary></div></MemoryRouter>
  const view = render(list(false))
  const owner = document.querySelector<HTMLElement>('[data-slot="main"]')!
  owner.scrollTop = 2300
  owner.dispatchEvent(new Event('scroll'))
  virtualState.hidden = 'anchor'
  view.rerender(list(true))
  expect(document.querySelector('[data-task-item="anchor"]')).toBeNull()
  expect(owner.scrollTop).toBe(400)
  // Virtua's scheduler re-applies a target on later size events; the anchor writes scrollTop itself.
  expect(virtualState.scheduled).toEqual([])
})

it.each((['flat', 'virtual'] as const).flatMap(rendering =>
  (['top', 'bottom'] as const).flatMap(edge => (['clamped', 'oscillating'] as const).map(mode => [rendering, edge, mode] as const)),
))('stops unreachable %s anchor retries at the %s when corrections are %s', (rendering, edge, mode) => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const owner = this.closest<HTMLElement>('[data-slot="main"]')
    const height = Number(owner?.querySelector<HTMLElement>('[data-height]')?.dataset.height ?? 0)
    const inList = this.dataset.taskItem || this.dataset.slot === 'task-list-items'
    const top = inList ? height - (owner?.scrollTop ?? 0) : 0
    return { top, bottom: top + 60, height: 60, width: 1000 } as DOMRect
  })
  const list = (folded: boolean) => <MemoryRouter initialEntries={['/?tasks=virtual']}><div data-slot="main"><TaskListFocusBoundary layout="same" revision="same" visibilityRevision={String(folded)}>
    <span data-height={folded ? (edge === 'top' ? 0 : 1000) : (edge === 'top' ? 2420 : 2400)} />
    {rendering === 'virtual' ? <TaskListItems items={['anchor']} itemKey={key => key}>{key => <button>{key}</button>}</TaskListItems>
      : <section data-slot="task-list-items"><div data-task-item="anchor">Anchor run</div></section>}
  </TaskListFocusBoundary></div></MemoryRouter>
  const view = render(list(false))
  const owner = document.querySelector<HTMLElement>('[data-slot="main"]')!
  let offset = 2400
  let maximum = 2500
  let corrections = 0
  const writes = vi.fn((value: number) => {
    offset = Math.min(maximum, Math.max(0, value))
    if (mode === 'oscillating') offset += (corrections++ % 2) * (edge === 'top' ? 1 : -1)
  })
  Object.defineProperty(owner, 'scrollTop', { configurable: true, get: () => offset, set: writes })
  owner.dispatchEvent(new Event('scroll'))
  maximum = 900
  view.rerender(list(true))
  // Flush frames deterministically: unreachable targets must not create an endless retry loop.
  for (let tick = 0; tick < 40 && frames.size; tick++) {
    const batch = [...frames.values()]
    frames.clear()
    batch.forEach(callback => callback(tick * 16))
  }
  expect(owner.scrollTop).toBeGreaterThanOrEqual(edge === 'top' ? 0 : 899)
  expect(owner.scrollTop).toBeLessThanOrEqual(edge === 'top' ? 1 : 900)
  expect(frames.size).toBe(0)
  expect(writes.mock.calls.length).toBeLessThanOrEqual(1)
})

it('accepts the clamp after a preview below the visible row collapses at the bottom', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const owner = this.closest<HTMLElement>('[data-slot="main"]')
    const top = this.dataset.taskItem ? 2400 - (owner?.scrollTop ?? 0) : 0
    return { top, bottom: top + (this.dataset.taskItem ? 60 : 300), height: 300, width: 1000 } as DOMRect
  })
  class Rows extends Component<{ expanded: boolean }> {
    override componentDidUpdate() {
      const owner = document.querySelector<HTMLElement>('[data-slot="main"]')!
      owner.scrollTop = Math.min(owner.scrollTop, owner.scrollHeight - owner.clientHeight)
      owner.dispatchEvent(new Event('scroll'))
    }
    override render() { return <section data-slot="task-list-items">
      <div data-task-item="anchor">Visible row near the bottom</div>
      <div data-preview-height={this.props.expanded ? 300 : 0}>Expanded preview below the anchor</div>
    </section> }
  }
  const list = (expanded: boolean) => <div data-slot="main"><TaskListFocusBoundary layout="same" revision="same" visibilityRevision={String(expanded)}><Rows expanded={expanded} /></TaskListFocusBoundary></div>
  const view = render(list(true))
  const owner = document.querySelector<HTMLElement>('[data-slot="main"]')!
  let offset = 2400
  Object.defineProperties(owner, {
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, get: () => 2500 + Number(owner.querySelector<HTMLElement>('[data-preview-height]')!.dataset.previewHeight) },
    scrollTop: { configurable: true, get: () => offset, set: (value: number) => { offset = Math.min(owner.scrollHeight - owner.clientHeight, Math.max(0, value)) } },
  })
  owner.dispatchEvent(new Event('scroll'))
  view.rerender(list(false))
  for (let tick = 0; tick < 40 && frames.size; tick++) {
    const batch = [...frames.values()]
    frames.clear()
    batch.forEach(callback => callback(tick * 16))
  }
  expect(owner.scrollTop).toBe(2200)
  expect(frames.size).toBe(0)
})

it('keeps a programmatic jump after a layout restore was clamped at zero', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const owner = this.closest<HTMLElement>('[data-slot="main"]')
    const height = Number(owner?.querySelector<HTMLElement>('[data-height]')?.dataset.height ?? 0)
    const top = this.dataset.taskItem ? height - (owner?.scrollTop ?? 0) : 0
    return { top, bottom: top + (this.dataset.taskItem ? 60 : 600), height: 600, width: 1000 } as DOMRect
  })
  const tree = (compact: boolean) => <div data-slot="main"><TaskListFocusBoundary layout={String(compact)} revision="same">
    <section data-slot="task-list-items" data-height={compact ? 508 : 540}><div data-task-item="anchor">Task card</div></section>
  </TaskListFocusBoundary></div>
  const view = render(tree(false))
  const owner = document.querySelector<HTMLElement>('[data-slot="main"]')!
  let offset = 0
  Object.defineProperty(owner, 'scrollTop', { configurable: true, get: () => offset, set: (value: number) => { offset = Math.max(0, value) } })
  view.rerender(tree(true))
  // scrollIntoView can run before the next frame; the impossible old anchor must be released.
  owner.scrollTop = 266
  owner.dispatchEvent(new Event('scroll'))
  expect(owner.scrollTop).toBe(266)
})

it.each(['flat', 'virtual'] as const)('keeps a programmatic scroll during pending %s restoration', (rendering) => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const owner = this.closest<HTMLElement>('[data-slot="main"]')
    const height = Number(owner?.querySelector<HTMLElement>('[data-height]')?.dataset.height ?? 0)
    const top = this.dataset.taskItem || this.dataset.slot === 'task-list-items' ? height - (owner?.scrollTop ?? 0) : 0
    return { top, bottom: top + 300, height: 300, width: 1000 } as DOMRect
  })
  const tree = (changed: boolean) => <MemoryRouter initialEntries={['/?tasks=virtual']}><div data-slot="main"><TaskListFocusBoundary layout="same" revision="same" visibilityRevision={String(changed)}>
    <span data-height={changed ? 2500 : 3000} />
    {rendering === 'virtual' ? <TaskListItems items={['anchor']} itemKey={key => key}>{key => <button>{key}</button>}</TaskListItems>
      : <section data-slot="task-list-items"><div data-task-item="anchor">Anchor</div></section>}
  </TaskListFocusBoundary></div></MemoryRouter>
  const view = render(tree(false))
  const owner = document.querySelector<HTMLElement>('[data-slot="main"]')!
  owner.scrollTop = 3000
  owner.dispatchEvent(new Event('scroll'))
  view.rerender(tree(true))
  // Model scrollIntoView/focus/hash restoration before the pending animation frames finish.
  owner.scrollTop = 500
  owner.dispatchEvent(new Event('scroll'))
  expect(owner.scrollTop).toBe(500)
})

it('adds no scroll, input, resize or frame work while the list rests', () => {
  const resize = vi.fn()
  vi.stubGlobal('ResizeObserver', class { constructor() { resize() } observe() {} unobserve() {} disconnect() {} })
  const frame = vi.fn(() => 1)
  vi.stubGlobal('requestAnimationFrame', frame)
  const listen = vi.spyOn(HTMLElement.prototype, 'addEventListener')
  const tree = (revision: string) => <div data-slot="main"><TaskListScrollAnchor revision={revision}>
    <section data-slot="task-list-items"><div data-task-item="anchor">Anchor</div></section>
  </TaskListScrollAnchor></div>
  const view = render(tree('first'))
  view.rerender(tree('second'))
  const owner = document.querySelector<HTMLElement>('[data-slot="main"]')!
  owner.scrollTop = 500
  owner.dispatchEvent(new Event('scroll'))
  // React's root listeners sit on the render container; the scroll owner gets none from the anchor.
  expect(listen.mock.contexts.filter(target => target === owner)).toEqual([])
  expect(resize).not.toHaveBeenCalled()
  expect(frame).not.toHaveBeenCalled()
  expect(owner.scrollTop).toBe(500)
})

it('tells the virtualizer about an offset change made during a content commit', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const owner = this.closest<HTMLElement>('[data-slot="main"]')
    const height = Number(owner?.querySelector<HTMLElement>('[data-height]')?.dataset.height ?? 0)
    const top = this.dataset.taskItem ? height - (owner?.scrollTop ?? 0) : 0
    return { top, bottom: top + 60, height: 60, width: 1000 } as DOMRect
  })
  class Native extends Component<{ grown: boolean }> {
    // Models the browser's native scroll anchoring during the commit's layout.
    override componentDidUpdate() { document.querySelector<HTMLElement>('[data-slot="main"]')!.scrollTop += 115 }
    override render() { return <><span data-height={this.props.grown ? 415 : 300} /><section data-slot="task-list-items"><div data-task-item="anchor">Anchor</div></section></> }
  }
  const tree = (grown: boolean) => <div data-slot="main"><TaskListScrollAnchor revision={grown}><Native grown={grown} /></TaskListScrollAnchor></div>
  const view = render(tree(false))
  const owner = document.querySelector<HTMLElement>('[data-slot="main"]')!
  owner.scrollTop = 300
  const seen: number[] = []
  owner.addEventListener('scroll', () => seen.push(owner.scrollTop))
  view.rerender(tree(true))
  expect(owner.scrollTop).toBe(415)
  await Promise.resolve()
  expect(seen).toEqual([415])
})

it('gives each virtual list its new start margin before paint after a content commit', async () => {
  // No ResizeObserver delivery: only the commit path can refresh the margin.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const owner = this.closest<HTMLElement>('[data-slot="main"]')
    const height = Number(owner?.querySelector<HTMLElement>('[data-height]')?.dataset.height ?? 0)
    const top = this === owner ? 0 : this.dataset.slot === 'task-list-items' || this.dataset.taskItem ? height - (owner?.scrollTop ?? 0) : 0
    return { top, bottom: top + 60, height: 60, width: 1000 } as DOMRect
  })
  const tree = (height: number) => <MemoryRouter initialEntries={['/?tasks=virtual']}><div data-slot="main"><TaskListFocusBoundary layout="same" revision="same" visibilityRevision={String(height)}>
    <span data-height={height} /><TaskListItems items={['anchor']} itemKey={key => key}>{key => <button>{key}</button>}</TaskListItems>
  </TaskListFocusBoundary></div></MemoryRouter>
  const view = render(tree(2000))
  expect(virtualState.margins.at(-1)).toBe(2000)
  view.rerender(tree(500))
  await act(async () => {})
  expect(virtualState.margins.at(-1)).toBe(500)
})
