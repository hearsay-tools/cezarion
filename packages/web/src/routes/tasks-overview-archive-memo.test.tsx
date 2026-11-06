import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import * as queries from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { TasksOverviewRoute } from './tasks-overview'
import { run, setOverviewDesktop } from './tasks-overview.testkit'

const revisions = vi.hoisted(() => [] as unknown[])
vi.mock('@/components/task-list-items', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/task-list-items')>()
  return { ...actual, TaskListFocusBoundary(props: ComponentProps<typeof actual.TaskListFocusBoundary>) {
    revisions.push(props.revision)
    return <actual.TaskListFocusBoundary {...props} />
  } }
})
afterEach(() => { cleanup(); revisions.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('keeps archived groups identity when route rerenders with unchanged query fields', async () => {
  setOverviewDesktop(true)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })))
  const archived = run({ id: 'archived-stable', title: 'Archived stable row', archived: true })
  const queryFields = {
    data: { pages: [{ runs: [archived], total: 1, nextCursor: null }], pageParams: [null] },
    isError: false, isPlaceholderData: false, hasNextPage: false, isFetchingNextPage: false,
    fetchNextPage: vi.fn(), refetch: vi.fn(),
  }
  // TanStack returns a fresh result wrapper on render; its data and methods stay stable.
  vi.spyOn(queries, 'useArchivedRuns').mockImplementation(() => ({ ...queryFields }) as unknown as ReturnType<typeof queries.useArchivedRuns>)
  const client = createQueryClient()
  const tree = () => <QueryClientProvider client={client}><MemoryRouter initialEntries={['/?archived=1']}><TasksOverviewRoute /></MemoryRouter></QueryClientProvider>
  const view = render(tree())
  await screen.findByText('Archived stable row')
  await waitFor(() => expect(client.isFetching()).toBe(0))
  const previous = revisions.at(-1)
  revisions.length = 0
  view.rerender(tree())
  expect(revisions.length).toBeGreaterThan(0)
  expect(revisions.every(revision => revision === previous)).toBe(true)
})
