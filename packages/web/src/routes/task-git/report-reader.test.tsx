import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { REPORT_CSP, REPORT_SANDBOX } from '@/lib/html-report'

import { TaskReportRoute } from './report-reader'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const ID = '4c15e25b-a08c-438d-a32b-fd1a8c6c90e2'
const OTHER = '9d0a3f3e-58c4-4c0e-9d2b-0c1f4b2a7e11'
const artifact = (id: string, name: string) => ({ id, runId: 'r1', name, sourcePath: `/tmp/${name}`, createdAt: '2026-11-01T09:00:00.000Z', size: 40, sha256: 'a'.repeat(64) })
const file = (name: string, content: string, id = ID, extra: object = {}) => ({ type: 'file', source: 'artifact', path: name, size: content.length, binary: false, tooLarge: false, content, artifact: artifact(id, name), ...extra })

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function stubFetch(routes: Record<string, () => Response>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const route = routes[String(input)]
    return route ? route() : json({ error: `unstubbed: ${String(input)}` }, 500)
  }))
}

function Where() { const location = useLocation(); return <output>{location.pathname + location.search}</output> }
function Go({ to }: { to: string }) { const navigate = useNavigate(); return <button onClick={() => void navigate(to)}>Go {to}</button> }

function renderAt(entries: (string | { pathname: string; search: string; state: unknown })[], extra?: React.ReactNode) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        {extra}
        <Routes>
          <Route path="/p/:projectId/tasks/:id/report" element={<TaskReportRoute />} />
          <Route path="*" element={<Where />} />
        </Routes>
        <Routes><Route path="*" element={<span data-testid="at"><Where /></span>} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
const at = () => screen.getByTestId('at').textContent
const frame = () => document.querySelector<HTMLIFrameElement>('[data-slot="html-report-frame"]')

describe('the HTML report reader', () => {
  it('renders a published report in an opaque-origin sandbox with the CSP first, plus Download', async () => {
    stubFetch({ [`/api/v1/runs/r1/artifacts/${ID}`]: () => json(file('report.html', '<h1>Quarterly</h1>')) })
    renderAt([`/p/a/tasks/r1/report?artifact=${ID}`])
    await waitFor(() => expect(frame()).not.toBeNull())
    expect(frame()!.getAttribute('sandbox')).toBe(REPORT_SANDBOX)
    expect(REPORT_SANDBOX).not.toMatch(/allow-scripts|allow-same-origin|allow-top-navigation|allow-forms/)
    expect(frame()!.getAttribute('srcdoc')).toContain(`content="${REPORT_CSP}"`)
    expect(frame()!.getAttribute('srcdoc')).toContain('<h1>Quarterly</h1>')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('report.html')
    expect(screen.getByText(/Published snapshot/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Download' }).getAttribute('href')).toBe(`/api/v1/runs/r1/artifacts/${ID}/download`)
    expect(document.querySelector('[data-slot="html-report-blocked"]')).toBeNull()
  })

  it.each([
    ['#s2', 'about:srcdoc#s2'],
    ['#section%202', 'about:srcdoc#section%202'],
    ['', null],
    ['#', null],
  ])('moves the loaded report to the route fragment %j without a history entry', async (hash, target) => {
    stubFetch({ [`/api/v1/runs/r1/artifacts/${ID}`]: () => json(file('report.html', '<h2 id="s2">S2</h2>')) })
    renderAt([`/p/a/tasks/r1/report?artifact=${ID}${hash}`])
    await waitFor(() => expect(frame()).not.toBeNull())
    const replace = vi.fn()
    Object.defineProperty(frame(), 'contentWindow', { configurable: true, value: { location: { replace } } })
    fireEvent.load(frame()!)
    if (target) expect(replace).toHaveBeenCalledExactlyOnceWith(target)
    else expect(replace).not.toHaveBeenCalled()
  })

  it('explains what it blocked', async () => {
    stubFetch({ [`/api/v1/runs/r1/artifacts/${ID}`]: () => json(file('r.html', '<script>x()</script><img src="https://x.test/a.png"><img src="b.png">')) })
    renderAt([`/p/a/tasks/r1/report?artifact=${ID}`])
    await waitFor(() => expect(document.querySelector('[data-slot="html-report-blocked"]')?.textContent).toBe(
      'Blocked for your safety: 1 script, 1 remote resource, 1 linked file next to the report. Reports show only what they carry inside the file.'))
  })

  it('sends a non-HTML publication to Files with the same query, replacing the history entry', async () => {
    stubFetch({ [`/api/v1/runs/r1/artifacts/${ID}`]: () => json(file('notes.md', '# Notes')) })
    renderAt([`/p/a/tasks/r1/report?artifact=${ID}`])
    await waitFor(() => expect(at()).toBe(`/p/a/tasks/r1/files?artifact=${ID}`))
  })

  it('opens an HTML path link from the live file-link route', async () => {
    stubFetch({ '/api/v1/runs/r1/file-link?path=out%2Fr.html': () => json({ type: 'file', source: 'worktree', path: '/wt/out/r.html', size: 9, binary: false, tooLarge: false, content: '<p>Live</p>' }) })
    renderAt(['/p/a/tasks/r1/report?path=out%2Fr.html'])
    await waitFor(() => expect(frame()?.getAttribute('srcdoc')).toContain('<p>Live</p>'))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('r.html')
    expect(screen.getByText(/Live file/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Download' })).toBeNull()
  })

  it.each([
    ['missing or deleted', () => json({ error: 'Published file is missing or unavailable.' }, 404), 'Report missing or deleted'],
    ['a server failure', () => json({ error: 'boom' }, 500), 'Could not load this report'],
  ])('names %s and offers Retry', async (_label, response, title) => {
    stubFetch({ [`/api/v1/runs/r1/artifacts/${ID}`]: response })
    renderAt([`/p/a/tasks/r1/report?artifact=${ID}`])
    expect((await screen.findByRole('heading', { level: 2 })).textContent).toBe(title)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('says a report is too large and still offers Download', async () => {
    stubFetch({ [`/api/v1/runs/r1/artifacts/${ID}`]: () => json({ ...file('big.html', ''), content: undefined, size: 900_000, tooLarge: true }) })
    renderAt([`/p/a/tasks/r1/report?artifact=${ID}`])
    expect((await screen.findByRole('heading', { level: 2 })).textContent).toBe('Too large to preview')
    expect(screen.getByRole('link', { name: 'Download' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Source' })).toBeNull()
  })

  it.each([
    ['too large', { size: 900_000, tooLarge: true }],
    ['binary', { size: 4096, binary: true }],
  ])('hands a live file that is %s to Files, which has its own state for it', async (_label, extra) => {
    stubFetch({ '/api/v1/runs/r1/file-link?path=big.html': () => json({ type: 'file', source: 'worktree', path: '/wt/big.html', binary: false, tooLarge: false, ...extra }) })
    renderAt(['/p/a/tasks/r1/report?path=big.html'])
    await waitFor(() => expect(at()).toBe('/p/a/tasks/r1/files?path=big.html'))
  })

  it('shows an unpublished path in the server\'s words', async () => {
    stubFetch({ '/api/v1/runs/r1/file-link?path=%2Fout%2Fr.html': () => json({ type: 'unpublished', path: '/out/r.html', reason: 'Ask the agent to publish it.' }) })
    renderAt(['/p/a/tasks/r1/report?path=%2Fout%2Fr.html'])
    expect((await screen.findByRole('heading', { level: 2 })).textContent).toBe('Report not published')
    expect(screen.getByText('Ask the agent to publish it.')).toBeTruthy()
  })

  it.each([
    ['/p/a/tasks/r1/report', 'No report selected'],
    [`/p/a/tasks/r1/report?artifact=${ID}&path=x.html`, 'Invalid report link'],
    ['/p/a/tasks/r1/report?artifact=', 'Invalid report link'],
    ['/p/a/tasks/r1/report?path=', 'Invalid report link'],
  ])('handles %s without a request', async (url, title) => {
    stubFetch({})
    renderAt([url])
    expect((await screen.findByRole('heading', { level: 2 })).textContent).toBe(title)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('toggles Source and back to Preview', async () => {
    stubFetch({ [`/api/v1/runs/r1/artifacts/${ID}`]: () => json(file('report.html', '<h1>Q</h1>')) })
    renderAt([`/p/a/tasks/r1/report?artifact=${ID}`])
    const toggle = await screen.findByRole('button', { name: 'Source' })
    // The label names the view the button switches to; a pressed state would contradict it.
    expect(toggle.hasAttribute('aria-pressed')).toBe(false)
    fireEvent.click(toggle)
    expect(document.querySelector('[data-slot="file-preview-code"]')?.textContent).toContain('<h1>Q</h1>')
    expect(frame()).toBeNull()
    expect(screen.getByRole('button', { name: 'Preview' }).hasAttribute('aria-pressed')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(frame()).not.toBeNull()
  })

  it('shows the newly selected report when the URL switches, never the previous one', async () => {
    stubFetch({
      [`/api/v1/runs/r1/artifacts/${ID}`]: () => json(file('one.html', '<p>One</p>')),
      [`/api/v1/runs/r1/artifacts/${OTHER}`]: () => json(file('two.html', '<p>Two</p>', OTHER)),
    })
    renderAt([`/p/a/tasks/r1/report?artifact=${ID}`], <Go to={`/p/a/tasks/r1/report?artifact=${OTHER}`} />)
    await waitFor(() => expect(frame()?.getAttribute('srcdoc')).toContain('<p>One</p>'))
    fireEvent.click(screen.getByRole('button', { name: /^Go / }))
    await waitFor(() => expect(frame()?.getAttribute('srcdoc')).toContain('<p>Two</p>'))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('two.html')
  })
})

describe('Back from the reader', () => {
  const report = () => stubFetch({ [`/api/v1/runs/r1/artifacts/${ID}`]: () => json(file('report.html', '<h1>Q</h1>')) })

  it('returns to the previous in-app view', async () => {
    report()
    renderAt(['/p/a/tasks/r1', `/p/a/tasks/r1/report?artifact=${ID}`])
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }))
    await waitFor(() => expect(at()).toBe('/p/a/tasks/r1'))
  })

  it('uses the Navigation API when present, which skips the frame\'s anchor entries', async () => {
    report()
    const back = vi.fn()
    vi.stubGlobal('navigation', { canGoBack: true, back })
    renderAt(['/p/a/tasks/r1', `/p/a/tasks/r1/report?artifact=${ID}`])
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }))
    expect(back).toHaveBeenCalledOnce()
  })

  it('without the Navigation API, returns to the source the link recorded, past any anchor entries', async () => {
    report()
    renderAt(['/p/a/tasks/r1', '/p/a/tasks/r1/files?x', { pathname: '/p/a/tasks/r1/report', search: `?artifact=${ID}`, state: { readerFrom: '/p/a/tasks/r1' } }])
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }))
    await waitFor(() => expect(at()).toBe('/p/a/tasks/r1'))
  })

  it.each([{ readerFrom: '//evil.test/x' }, { readerFrom: 'https://evil.test' }, { readerFrom: 3 }])('ignores a source that is not an in-app path: %o', async state => {
    report()
    renderAt(['/p/a/tasks/r1', { pathname: '/p/a/tasks/r1/report', search: `?artifact=${ID}`, state }])
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }))
    await waitFor(() => expect(at()).toBe('/p/a/tasks/r1'))
  })

  it.each([
    ['with', { canGoBack: true, back: vi.fn() }],
    ['without', undefined],
  ])('goes to the conversation from the first entry of the app session, %s the Navigation API', async (_label, navigation) => {
    report()
    vi.stubGlobal('navigation', navigation)
    // A cold flat link: the legacy redirect replaced the first entry, so its key is not 'default'.
    vi.spyOn(window.history, 'state', 'get').mockReturnValue({ idx: 0, key: 'k', usr: null })
    renderAt(['/elsewhere', `/p/a/tasks/r1/report?artifact=${ID}`])
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }))
    await waitFor(() => expect(at()).toBe('/p/a/tasks/r1'))
    if (navigation) expect(navigation.back).not.toHaveBeenCalled()
  })

  it('goes to the task\'s conversation without in-app history', async () => {
    report()
    renderAt([`/p/a/tasks/r1/report?artifact=${ID}`])
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }))
    await waitFor(() => expect(at()).toBe('/p/a/tasks/r1'))
  })
})
