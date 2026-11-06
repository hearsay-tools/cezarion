import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskListItems } from './task-list-items'

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
