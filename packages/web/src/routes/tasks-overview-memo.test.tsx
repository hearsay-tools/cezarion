import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import * as events from '@/api/global-events'
import { createQueryClient } from '@/api/query-client'
import { TasksOverview } from './tasks-overview'
import { NOW, run, setOverviewDesktop } from './tasks-overview.testkit'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('skips unchanged detailed rows when another run updates', () => {
  setOverviewDesktop(true)
  const usage = vi.spyOn(events, 'useRunUsage').mockReturnValue(undefined)
  const stable = run({ id: 'stable' }), changing = run({ id: 'changing' })
  const client = createQueryClient(), onRename = vi.fn(), onViewChange = vi.fn(), onArchiveFinished = vi.fn(), onMarkAllRead = vi.fn()
  const expandedColumns = {}, automationName = () => undefined
  const page = (runs: typeof stable[]) => <QueryClientProvider client={client}><MemoryRouter><TasksOverview runs={runs} view="active" now={NOW} onRename={onRename} onViewChange={onViewChange} onArchiveFinished={onArchiveFinished} onMarkAllRead={onMarkAllRead} expandedColumns={expandedColumns} automationName={automationName} /></MemoryRouter></QueryClientProvider>
  const view = render(page([stable, changing]))
  fireEvent.click(screen.getByRole('button', { name: 'Columns' }))
  fireEvent.click(screen.getByRole('button', { name: 'Resource columns' }))
  const stableCount = usage.mock.calls.filter(([id]) => id === 'stable').length
  const changingCount = usage.mock.calls.filter(([id]) => id === 'changing').length
  expect(stableCount).toBeGreaterThan(0)
  view.rerender(page([stable, { ...changing, title: 'New title' }]))
  expect(usage.mock.calls.filter(([id]) => id === 'stable')).toHaveLength(stableCount)
  expect(usage.mock.calls.filter(([id]) => id === 'changing').length).toBeGreaterThan(changingCount)
})
