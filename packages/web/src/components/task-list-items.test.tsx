import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskListFocusBoundary, TaskListItems } from './task-list-items'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const items = Array.from({ length: 120 }, (_, index) => `run-${index}`)
function List({ owner = true, search = '', data = items }: { owner?: boolean; search?: string; data?: string[] }) {
  return <MemoryRouter initialEntries={[`/${search}`]}><div data-slot={owner ? 'main' : 'standalone'}>
    <TaskListItems items={data} itemKey={(id) => id}>{(id) => <button>{id}</button>}</TaskListItems>
  </div></MemoryRouter>
}
it('falls back to a complete flat list without a main scroll owner', () => {
  render(<List owner={false} search="?tasks=virtual" />)
  expect(screen.getAllByRole('button')).toHaveLength(120)
  expect(document.querySelector('[data-virtualized="false"]')).not.toBeNull()
  expect(document.querySelector('[data-first="true"]')?.textContent).toBe('run-0')
  expect(document.querySelector('[data-last="true"]')?.textContent).toBe('run-119')
})
it('honours flat mode even with a scroll owner and large group', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  render(<List search="?tasks=flat" />)
  expect(screen.getAllByRole('button')).toHaveLength(120)
})
it('bounds mounted rows with the real virtualizer and keeps a focused row when scrolled', async () => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(element: HTMLElement) {
      Object.defineProperty(element, 'offsetParent', { configurable: true, get: () => document.body })
      queueMicrotask(() => this.callback([{ target: element, contentRect: { width: 1000, height: element.dataset.slot === 'main' ? 300 : 60 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver))
    }
    unobserve() {} disconnect() {}
  })
  render(<List />)
  await act(async () => {})
  expect(document.querySelector('[data-virtualized="true"]')).not.toBeNull()
  expect(screen.getAllByRole('button').length).toBeLessThan(120)
  const first = screen.getByRole('button', { name: 'run-0' })
  act(() => first.focus())
  const owner = document.querySelector<HTMLElement>('[data-slot="main"]')!
  act(() => { owner.scrollTop = 4000; owner.dispatchEvent(new Event('scroll')) })
  await act(async () => {})
  expect(first.isConnected).toBe(true)
  expect(document.activeElement).toBe(first)
})

it('never renders the full virtual-eligible group during owner lookup', async () => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(element: HTMLElement) {
      Object.defineProperty(element, 'offsetParent', { configurable: true, get: () => document.body })
      queueMicrotask(() => this.callback([{ target: element, contentRect: { width: 1000, height: element.dataset.slot === 'main' ? 300 : 60 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver))
    }
    unobserve() {} disconnect() {}
  })
  const rendered = new Set<string>()
  render(<MemoryRouter><div data-slot="main"><TaskListItems items={items} itemKey={(id) => id}>{(id) => {
    rendered.add(id)
    return <button>{id}</button>
  }}</TaskListItems></div></MemoryRouter>)
  expect(rendered.size).toBeLessThan(items.length)
  // Virtua attaches its scroll owner in a microtask; those and layout effects finish before paint.
  await act(async () => {})
  expect(screen.getAllByRole('button').length).toBeGreaterThan(0)
})
it('skips unchanged observed margins but applies an earlier group size change', () => {
  const callbacks: (() => void)[] = []
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { callbacks.push(callback) }
    observe() {} unobserve() {} disconnect() {}
  })
  const child = vi.fn((id: string) => <button>{id}</button>)
  render(<MemoryRouter><div data-slot="main"><TaskListItems items={['one']} itemKey={(id) => id}>{child}</TaskListItems></div></MemoryRouter>)
  child.mockClear()
  act(() => { callbacks.forEach((callback) => callback()) })
  expect(child).not.toHaveBeenCalled()
  const root = document.querySelector<HTMLElement>('[data-slot="task-list-items"]')!
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect)
  act(() => { callbacks.forEach((callback) => callback()) })
  expect(child).toHaveBeenCalledOnce()
})
it('keeps focus updates below route derivations', () => {
  const derive = vi.fn(() => ['one', 'two'])
  function Route() {
    const rows = derive()
    return <TaskListFocusBoundary layout="summary" revision={rows}>{rows.map((id) =>
      <div key={id} data-run-id={id}><button>{id}</button></div>)}</TaskListFocusBoundary>
  }
  render(<Route />)
  act(() => { screen.getByRole('button', { name: 'one' }).focus() })
  act(() => { screen.getByRole('button', { name: 'two' }).focus() })
  expect(derive).toHaveBeenCalledOnce()
})
it.each([[undefined, 'title'], ['boot', 'title'], [undefined, 'resources'], ['boot', 'resources']] as const)('restores a virtual row control through both layout flips (project %s, control %s)', async (project, control) => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(element: HTMLElement) {
      Object.defineProperty(element, 'offsetParent', { configurable: true, get: () => document.body })
      queueMicrotask(() => this.callback([{ target: element, contentRect: { width: 1000, height: element.dataset.slot === 'main' ? 300 : 60 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver))
    }
    unobserve() {} disconnect() {}
  })
  function Page({ layout }: { layout: string }) {
    return <MemoryRouter><div data-slot="main"><TaskListFocusBoundary layout={layout} revision={items}>
      <TaskListItems key={layout} items={items} itemKey={(id) => project ? `${project}/${id}` : id}>{(id) =>
        <div data-run-id={id} data-project={project}><a href={`#${id}`} data-task-control="title">{id}</a><button data-task-control="resources">Resources {id}</button></div>}
      </TaskListItems>
    </TaskListFocusBoundary></div></MemoryRouter>
  }
  const view = render(<Page layout="desktop" />)
  await act(async () => {})
  const focusedControl = () => control === 'title' ? screen.getByRole('link', { name: 'run-0' }) : screen.getByRole('button', { name: 'Resources run-0' })
  act(() => focusedControl().focus())
  for (const layout of ['phone', 'desktop']) {
    view.rerender(<Page layout={layout} />)
    await act(async () => {})
    expect(document.activeElement).toBe(focusedControl())
  }
})
