import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { REPORT_SANDBOX } from '@/lib/html-report'
import { ReportReader, TaskReportRoute } from './report-reader'

const ID = '4c15e25b-a08c-438d-a32b-fd1a8c6c90e2'
const result = {
  type: 'file', source: 'artifact', path: 'report.html', size: 40, binary: false, tooLarge: false,
  content: '<h1>Shared reader</h1><script>unsafe()</script>',
  artifact: { id: ID, runId: 'r1', name: 'report.html', size: 40, sourcePath: '/tmp/report.html', createdAt: '2026-11-01T09:00:00.000Z', sha256: 'a'.repeat(64) },
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mount(route: boolean, onBack = vi.fn(), data = result, runId = 'r1') {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })))
  render(<QueryClientProvider client={createQueryClient()}>
    <MemoryRouter initialEntries={[`/p/a/tasks/r1/report?artifact=${ID}`]}>
      <Routes><Route path="/p/:projectId/tasks/:id/report" element={route ? <TaskReportRoute /> : <ReportReader runId={runId} selection={{ artifactId: ID }} fragment="" onBack={onBack} variant="pane" />} /></Routes>
    </MemoryRouter>
  </QueryClientProvider>)
}

const frame = () => document.querySelector<HTMLIFrameElement>('[data-slot="html-report-frame"]')

describe('the extracted report reader', () => {
  it('sends a non-HTML publication opened before metadata loads to its source task Files', async () => {
    mount(false, vi.fn(), { ...result, path: 'notes.md', artifact: { ...result.artifact, name: 'notes.md', runId: 'worker' } }, 'worker')
    expect((await screen.findByRole('heading', { name: 'Not an HTML report' })).textContent).toBe('Not an HTML report')
    expect(frame()).toBeNull()
    expect(screen.getByRole('link', { name: 'Open in Files' }).getAttribute('href')).toBe(`/p/a/tasks/worker/files?artifact=${ID}`)
  })

  it('focuses Back on pane entry without taking focus again when content or Source changes', async () => {
    mount(false)
    const back = screen.getByRole('button', { name: 'Back' })
    expect(document.activeElement).toBe(back)
    const source = await screen.findByRole('button', { name: 'Source' })
    expect(document.activeElement).toBe(back)
    source.focus()
    fireEvent.click(source)
    expect(screen.getByRole('button', { name: 'Preview' })).toBe(document.activeElement)
  })

  it('closes the pane with Escape from its keyboard controls', async () => {
    const onBack = vi.fn()
    mount(false, onBack)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Back' }), { key: 'Escape' })
    expect(onBack).toHaveBeenCalledOnce()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Back' }), { key: 'Enter' })
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('preserves route focus and does not close the route with Escape', async () => {
    mount(true)
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(frame()).not.toBeNull())
    fireEvent.keyDown(screen.getByRole('button', { name: 'Back' }), { key: 'Escape' })
    expect(frame()).not.toBeNull()
  })

  it('uses the same content, sandbox, sanitizing and source view in the route and pane', async () => {
    mount(true)
    await waitFor(() => expect(frame()).not.toBeNull())
    const srcdoc = frame()!.getAttribute('srcdoc')
    expect(frame()!.getAttribute('sandbox')).toBe(REPORT_SANDBOX)
    expect(srcdoc).not.toContain('<script>')
    const heading = screen.getByRole('heading', { level: 1 }).textContent
    cleanup()
    mount(false)
    await waitFor(() => expect(frame()).not.toBeNull())
    expect(frame()!.getAttribute('srcdoc')).toBe(srcdoc)
    expect(frame()!.getAttribute('sandbox')).toBe(REPORT_SANDBOX)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(heading)
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    expect(document.querySelector('[data-slot="file-preview-code"]')?.textContent).toContain(result.content)
    expect(frame()).toBeNull()
  })

  it.each([
    [1440, 'Back', true],
    [900, 'Conversation', true],
    [360, 'Back', false],
  ])('at %i px uses the pane close callback and expected controls', async (width, label, download) => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query.includes('min-width') ? width >= 1180 : width <= 767,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })))
    const onBack = vi.fn()
    mount(false, onBack)
    await waitFor(() => expect(frame()).not.toBeNull())
    expect(Boolean(screen.queryByRole('link', { name: 'Download' }))).toBe(download)
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(onBack).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-slot="report-body"]')?.classList.contains('overflow-clip')).toBe(true)
  })
})
