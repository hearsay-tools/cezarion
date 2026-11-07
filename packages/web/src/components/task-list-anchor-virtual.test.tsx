import { act, cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { Component } from 'react'
import { TaskListItems, TaskListScrollAnchor } from './task-list-items'

const observers = new Map<ResizeObserverCallback, Set<HTMLElement>>()
function size(element: HTMLElement) {
  if (element.dataset.slot === 'main') return 300
  const button = element.querySelector<HTMLElement>('button[data-size]')
  return button ? Number(button.dataset.size) : Number.parseFloat(element.style.height) || 60
}
function resize() {
  for (const [callback, elements] of observers) callback([...elements].filter(element => element.isConnected).map(target => { return { target, contentRect: { width: 1000, height: size(target) } } as unknown as ResizeObserverEntry }), {} as ResizeObserver)
}
function setupGeometry({ events = true } = {}) {
  const offsets = new WeakMap<Element, number>()
  vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (this: Element) { return offsets.get(this) ?? 0 })
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (this: Element, value) {
    offsets.set(this, value)
    if (events) queueMicrotask(() => this.dispatchEvent(new Event('scroll')))
  })
  vi.stubGlobal('ResizeObserver', class {
    private elements = new Set<HTMLElement>()
    constructor(private callback: ResizeObserverCallback) { observers.set(callback, this.elements) }
    observe(element: HTMLElement) {
      Object.defineProperty(element, 'offsetParent', { configurable: true, get: () => { return document.body } })
      this.elements.add(element)
      queueMicrotask(() => { if (element.isConnected) this.callback([{ target: element, contentRect: { width: 1000, height: size(element) } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver) })
    }
    unobserve(element: HTMLElement) { this.elements.delete(element) }
    disconnect() { observers.delete(this.callback) }
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const owner = this.closest<HTMLElement>('[data-slot="main"]')
    const group = this.closest<HTMLElement>('[data-group]')
    const first = owner?.querySelector<HTMLElement>('[data-group="first"] [style*="position: relative"]')
    const margin = group?.dataset.group === 'second' ? Number.parseFloat(first?.style.height ?? '0') + Number(owner?.dataset.extra ?? 0) : 0
    const positioned = this.closest<HTMLElement>('[style*="position: absolute"]')
    const top = this === owner ? 0 : margin + Number.parseFloat(positioned?.style.top ?? '0') - (owner?.scrollTop ?? 0)
    return { x: 0, y: top, top, bottom: top + size(this), height: size(this), width: 1000, left: 0, right: 1000, toJSON() {} }
  })
}
afterEach(() => { cleanup(); observers.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const initial = Array.from({ length: 120 }, (_, index) => `run-${index}`)
class NativeAnchoring extends Component<{ shift: number }> {
  // Models native overflow-anchor: content above grows and the browser moves scrollTop with no scroll event yet.
  override componentDidUpdate() {
    const owner = document.querySelector<HTMLElement>('[data-slot="main"]')!
    owner.dataset.extra = String(this.props.shift)
    owner.scrollTop += this.props.shift
  }
  override render() { return null }
}
function Lists({ first, second = initial, tall = false, shift = 0, narrow = false }: { first: string[]; second?: string[]; tall?: boolean; shift?: number; narrow?: boolean }) {
  return <MemoryRouter><div data-slot="main"><TaskListScrollAnchor revision={first}><NativeAnchoring shift={shift} />
    {([['first', first], ['second', second]] as const).map(([group, items]) => <section key={group} data-group={group}>
      <TaskListItems items={items} itemKey={id => `${group}/${id}`}>{id => <button data-size={tall && (id === 'inserted' || (group === 'first' && id === 'run-119')) ? 120 : narrow && group === 'first' && id === 'run-119' ? 59 : 60}>{id}</button>}</TaskListItems>
    </section>)}
  </TaskListScrollAnchor></div></MemoryRouter>
}
async function scrollTo(offset: number) {
  const owner = document.querySelector<HTMLElement>('[data-slot="main"]')!
  act(() => { owner.scrollTop = offset; owner.dispatchEvent(new Event('scroll')) })
  await act(async () => {})
  return owner
}
// An earlier group's growth moves the later list itself: native overflow-anchor owns it (browser matrix).
it.each(['prepend', 'middle'])('anchors real virtua lists after %s insertion and async row sizing', async mode => {
  setupGeometry()
  const view = render(<Lists first={initial} />)
  await act(async () => { resize() })
  await act(async () => { resize() })
  const owner = await scrollTo(600)
  const selector = '[data-group="first"]'
  const visible = () => [...document.querySelectorAll<HTMLElement>(`${selector} [data-task-item]`)].find(element => element.getBoundingClientRect().top >= 0 && element.getBoundingClientRect().top < 300)
  await waitFor(() => expect(visible()).toBeDefined())
  const before = visible()!, key = before.dataset.taskItem!, top = before.getBoundingClientRect().top
  expect(document.querySelectorAll('button').length).toBeLessThan(240)
  const at = mode === 'prepend' ? 0 : 8
  view.rerender(<Lists first={[...initial.slice(0, at), 'inserted', ...initial.slice(at)]} tall />)
  await act(async () => { resize() })
  await act(async () => { resize() })
  act(() => owner.dispatchEvent(new Event('scroll')))
  await waitFor(() => {
    const anchor = [...document.querySelectorAll<HTMLElement>('[data-task-item]')].find(element => element.dataset.taskItem === key)
    expect(anchor).toBeDefined()
    expect(Math.abs(anchor!.getBoundingClientRect().top - top)).toBeLessThanOrEqual(1)
  })
})

it('keeps a native adjustment when virtua later compensates an earlier row resize', async () => {
  setupGeometry({ events: false })
  const view = render(<Lists first={initial} />)
  await act(async () => { resize() })
  await act(async () => { resize() })
  const owner = await scrollTo(7800)
  const visible = () => [...document.querySelectorAll<HTMLElement>('[data-group="second"] [data-task-item]')].find(element => element.getBoundingClientRect().top >= 0 && element.getBoundingClientRect().top < 300)
  await waitFor(() => expect(visible()).toBeDefined())
  const before = visible()!, key = before.dataset.taskItem!, top = before.getBoundingClientRect().top
  // The browser has moved the list by 115px; virtua's stored offset is still 7800.
  await act(async () => { view.rerender(<Lists first={[...initial]} shift={115} />) })
  expect(owner.scrollTop).toBe(7915)
  // An earlier row shrinks by 1px above virtua's viewport: virtua compensates from its stored offset.
  view.rerender(<Lists first={[...initial]} shift={115} narrow />)
  await act(async () => { resize() })
  const anchor = [...document.querySelectorAll<HTMLElement>('[data-task-item]')].find(element => element.dataset.taskItem === key)!
  expect(owner.scrollTop).toBe(7914)
  expect(Math.abs(anchor.getBoundingClientRect().top - top)).toBeLessThanOrEqual(1)
})
