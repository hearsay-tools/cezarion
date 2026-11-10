import { productCommand } from '@/lib/product-name'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REPORTS_QUERY_MAX } from '@open-mercato/cezar-api-client/contract/reports'
import { ReportsRoute } from './reports'

const mocks = vi.hoisted(() => ({ useReports: vi.fn() }))
vi.mock('@/api/reports', () => ({ useReports: mocks.useReports }))
const refetch = vi.fn()
const result = (overrides = {}) => ({ isPending: false, isError: false, data: { pages: [{ reports: [], total: 0, nextCursor: null }] }, refetch, ...overrides })
function Location() { const l = useLocation(); return <div data-testid="location">{l.pathname + l.search}</div> }
function mount(path = '/p/shop/reports') {
  return render(<MemoryRouter initialEntries={[path]}><Location /><Routes><Route path="/p/:projectId/reports" element={<ReportsRoute />} /><Route path="/p/:projectId/tasks/:id/report" element={<Location />} /><Route path="/p/:projectId/tasks/:id" element={<p>Source conversation</p>} /></Routes></MemoryRouter>)
}
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('Reports shelf', () => {
  it('explains loading, empty publication, and errors with Retry', () => {
    mocks.useReports.mockReturnValue(result({ isPending: true }))
    const view = mount()
    expect(screen.getByRole('status').textContent).toBe('Loading reports…')
    mocks.useReports.mockReturnValue(result()); view.rerender(<MemoryRouter><ReportsRoute /></MemoryRouter>)
    expect(screen.getByText('No published reports yet')).toBeTruthy()
    expect(screen.getByText(`${productCommand()} artifact publish`)).toBeTruthy()
    mocks.useReports.mockReturnValue(result({ isError: true, error: new Error('Storage unavailable') }))
    view.rerender(<MemoryRouter><ReportsRoute /></MemoryRouter>)
    expect(screen.getByRole('alert').textContent).toContain('Storage unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(refetch).toHaveBeenCalledOnce()
  })

  it('reads search from the URL, writes composed query updates, and clears a search with no match', async () => {
    mocks.useReports.mockReturnValue(result())
    mount('/p/shop/reports?q=budget')
    expect((screen.getByRole('textbox', { name: 'Search reports' }) as HTMLInputElement).value).toBe('budget')
    expect(mocks.useReports).toHaveBeenLastCalledWith('budget')
    expect(screen.getByText('No matching reports')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'forecast' } })
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('q=forecast'))
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/p/shop/reports'))
  })

  it('caps typed search and URL search at the shared contract maximum', async () => {
    mocks.useReports.mockReturnValue(result())
    mount('/p/shop/reports?q=' + 'a'.repeat(REPORTS_QUERY_MAX + 1))
    const input = screen.getByRole('textbox', { name: 'Search reports' }) as HTMLInputElement
    expect(input.maxLength).toBe(REPORTS_QUERY_MAX)
    expect(input.value).toBe('a'.repeat(REPORTS_QUERY_MAX))
    expect(mocks.useReports).toHaveBeenLastCalledWith('a'.repeat(REPORTS_QUERY_MAX))
    fireEvent.change(input, { target: { value: 'b'.repeat(REPORTS_QUERY_MAX + 1) } })
    await waitFor(() => expect(input.value).toBe('b'.repeat(REPORTS_QUERY_MAX)))
    expect(mocks.useReports).toHaveBeenLastCalledWith('b'.repeat(REPORTS_QUERY_MAX))
  })

  it('uses server titles and source-task links, and records the shelf as the reader source', async () => {
    mocks.useReports.mockReturnValue(result({ data: { pages: [{ reports: [{ id: 'abc', runId: 'source', title: 'Income', name: 'budget.html', taskTitle: 'Prepare budget', createdAt: '2026-11-01T12:00:00Z' }] }] } }))
    mount('/p/shop/reports?q=income')
    expect(screen.getByRole('link', { name: 'Prepare budget' }).getAttribute('href')).toBe('/p/shop/tasks/source')
    const report = screen.getByRole('link', { name: 'Income' })
    expect(report.getAttribute('href')).toBe('/p/shop/tasks/source/report?artifact=abc')
    fireEvent.click(report)
    await waitFor(() => expect(screen.getAllByTestId('location')[0]!.textContent).toContain('/tasks/source/report?artifact=abc'))
  })
})
