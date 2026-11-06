import { cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { TaskListItems, TaskListScrollAnchor } from './task-list-items'

// Keep all items mounted to isolate the before-mutation anchor from virtua's own sizing.
vi.mock('virtua', () => ({ Virtualizer: ({ data, children }: { data: string[]; children: (item: string, index: number) => ReactNode }) => <div>{data.map(children)}</div> }))
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
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
