import { cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { Component, type ReactNode } from 'react'
import { TaskListItems, TaskListScrollAnchor, TaskListFocusBoundary } from './task-list-items'

// Keep all items mounted to isolate the before-mutation anchor from virtua's own sizing.
const virtualState = vi.hoisted(() => ({ hidden: null as string | null }))
vi.mock('virtua', async () => {
  const React = await import('react')
  return { Virtualizer: React.forwardRef(function Virtualizer({ data, children }: { data: string[]; children: (item: string, index: number) => ReactNode }, ref) {
    const root = React.useRef<HTMLDivElement>(null)
    React.useImperativeHandle(ref, () => ({ getItemOffset: (index: number) => index * 60, scrollBy() {}, scrollTo(offset: number) { root.current!.closest<HTMLElement>('[data-slot="main"]')!.scrollTop = offset } }))
    return <div ref={root}>{data.flatMap((item, index) => item === virtualState.hidden ? [] : [children(item, index)])}</div>
  }) }
})
afterEach(() => { virtualState.hidden = null; cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
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
  const list = (data: string[]) => <MemoryRouter><div data-slot="main"><TaskListItems items={data} itemKey={(item) => item}>{(item) => <button>{item}</button>}</TaskListItems></div></MemoryRouter>
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

it.each([114, -114, -300])('keeps the anchor through a delayed earlier-group height correction of %s px without another route render', (delta) => {
  const callbacks: (() => void)[] = []
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { callbacks.push(callback) }
    observe() {} unobserve() {} disconnect() {}
  })
  let earlierHeight = 300
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const owner = this.closest<HTMLElement>('[data-slot="main"]')
    const top = this.dataset.taskItem ? earlierHeight - (owner?.scrollTop ?? 0) : 0
    return { top, bottom: top + 60, height: 60, width: 1000 } as DOMRect
  })
  render(<div data-slot="main"><TaskListScrollAnchor revision="same">
    <section data-slot="task-list-items">Earlier group</section>
    <section data-slot="task-list-items"><div data-task-item="visible">Visible run</div></section>
  </TaskListScrollAnchor></div>)
  const owner = document.querySelector<HTMLElement>('[data-slot="main"]')!
  owner.scrollTop = 300
  owner.dispatchEvent(new Event('scroll'))
  earlierHeight += delta
  callbacks.forEach(callback => callback())
  expect(owner.scrollTop).toBe(300 + delta)
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
})
