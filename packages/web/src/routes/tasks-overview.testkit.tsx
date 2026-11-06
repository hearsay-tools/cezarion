import { RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import { summaryOf } from '@/test/run-summary-fixture'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import type { RunRecord, RunSummary } from '@open-mercato/cezar-api-client'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { TasksOverview } from '@/routes/tasks-overview'

// Exercise the workspace reducers through their named-event adapter seam.
vi.mock('@/api/live-workspace-source', () => ({ LiveWorkspaceSource: class {
  constructor(url: string, options: EventSourceInit) {
    return typeof globalThis.EventSource === 'function' ? new globalThis.EventSource(url, options) : { readyState: 2, addEventListener() {}, close() {} }
  }
} }))

const desktopListeners = new Set<() => void>()
let desktop = true

/** Drive the real layout subscription; tests inspect one mounted presentation at a time. */
export function setOverviewDesktop(value: boolean) {
  desktop = value
  vi.stubGlobal('matchMedia', () => ({
    get matches() { return desktop },
    addEventListener: (_: string, listener: () => void) => desktopListeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => desktopListeners.delete(listener),
  }))
  act(() => { for (const listener of desktopListeners) listener() })
}

export const NOW = Date.parse('2026-07-14T12:00:00.000Z')

export const ago = (ms: number) => new Date(NOW - ms).toISOString()

export let seq = 0

export function run(over: Partial<RunRecord> = {}): RunSummary {
  seq += 1
  return summaryOf({
    id: `r${seq}`,
    title: `Task ${seq}`,
    workflow: 'default',
    task: `task ${seq}`,
    status: RUN_STATUS.done,
    createdAt: ago(60_000),
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  })
}

export function LocationProbe() {
  const { pathname } = useLocation()
  return <output data-testid="location">{pathname}</output>
}

export function renderOverview(
  props: Partial<ComponentProps<typeof TasksOverview>> = {},
  detailed = true,
  repo?: { projectId: string; repoBase: string },
) {
  if (typeof window.matchMedia !== 'function') setOverviewDesktop(true)
  const onViewChange = props.onViewChange ?? vi.fn()
  const onArchiveFinished = props.onArchiveFinished ?? vi.fn()
  const onMarkAllRead = props.onMarkAllRead ?? vi.fn()
  const onRename = props.onRename ?? vi.fn()
  const overview = (
            <TasksOverview
              runs={[]}
              view="active"
              now={NOW}
              expandedColumns={{ branch: true }}
              {...props}
              onViewChange={onViewChange}
              onArchiveFinished={onArchiveFinished}
              onMarkAllRead={onMarkAllRead}
              onRename={onRename}
            />
  )
  const utils = render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/']}>
        <LocationProbe />
        <Routes>
          <Route
            path="/"
            element={
              repo ? (
                <ReferenceStatusProvider projectId={repo.projectId} repoBase={repo.repoBase} requests={[]}>
                  {overview}
                </ReferenceStatusProvider>
              ) : (
                overview
              )
            }
          />
          {/* Row clicks land here; the probe above says where we ended up. */}
          <Route path="*" element={null} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
  if (detailed) { fireEvent.click(screen.getByRole("button", { name: "Columns" })); fireEvent.click(screen.getByRole("button", { name: "Resource columns" })); fireEvent.keyDown(document.activeElement!, { key: "Escape" }) }
  return { ...utils, onViewChange, onArchiveFinished, onMarkAllRead, onRename }
}

export const location = () => screen.getByTestId('location').textContent

export const tableRow = (id: string) => document.querySelector(`[data-slot="task-table-row"][data-run-id="${id}"]`)

export const card = (id: string) => document.querySelector(`[data-slot="task-card"][data-run-id="${id}"]`)

export const cellsOf = (id: string): string[] => [...(tableRow(id)?.querySelectorAll('td') ?? [])].map((td) => td.textContent ?? '')
