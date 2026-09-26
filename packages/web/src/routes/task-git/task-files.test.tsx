import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, HealthResponse, WorktreeEntry } from '@open-mercato/cezar-api-client'

import { highlight } from '@/lib/highlighter'

import { TaskFilesRoute } from './task-files'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// ---- fixtures --------------------------------------------------------------------------------

const RUN: ApiRun = {
  id: 'r1',
  title: 'do the thing plz',
  titleSummary: 'Do the thing',
  workflow: 'quick-task',
  task: 'Summarize what this project does.',
  status: 'review',
  createdAt: '2026-07-15T08:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  worktreePath: '/tmp/wt/r1',
  branch: 'cez/abc12345',
  baseBranch: 'main',
  steps: [
    { id: 'task', name: 'Do the task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, sessionId: 's-1' },
  ],
}

const HEALTH: HealthResponse = {
  version: '0.0.0-test',
  projects: [],
  bootProject: 'default',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main', remote: 'git@github.com:acme/demo.git' },
  checks: [],
  defaultRunner: 'claude',
  forge: { kind: 'github', available: true },
  capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false, automations: false },
}

/** The worktree the stub serves: a root with one lazy directory and every preview kind. */
const ROOT: WorktreeEntry = {
  type: 'dir',
  path: '',
  entries: [
    { name: 'src', type: 'dir' },
    { name: 'big.txt', type: 'file', size: 900_000 },
    { name: 'blob.dat', type: 'file', size: 4096 },
    { name: 'hello.ts', type: 'file', size: 27 },
    { name: 'logo.png', type: 'file', size: 2048 },
  ],
}

const FILES: Record<string, WorktreeEntry> = {
  src: { type: 'dir', path: 'src', entries: [{ name: 'nested.md', type: 'file', size: 8 }] },
  'src%2Fnested.md': { type: 'file', path: 'src/nested.md', size: 8, binary: false, tooLarge: false, content: '# hello\n' },
  'hello.ts': { type: 'file', path: 'hello.ts', size: 27, binary: false, tooLarge: false, content: "export const hi = 'world'\n" },
  'logo.png': { type: 'file', path: 'logo.png', size: 2048, binary: true, tooLarge: false },
  'big.txt': { type: 'file', path: 'big.txt', size: 900_000, binary: false, tooLarge: true },
  'blob.dat': { type: 'file', path: 'blob.dat', size: 4096, binary: true, tooLarge: false },
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Fetch stub in the house style (task-changes.test.tsx): records requests, serves the run,
 *  health and worktree fixtures, and lets a test override specific `METHOD path` keys. */
function stubFetch(overrides: Record<string, () => Response> = {}): string[] {
  const sent: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push(`${method} ${path}`)
      const override = overrides[`${method} ${path}`]
      if (override) return override()
      if (method === 'GET' && path === '/api/v1/runs/r1') return jsonResponse(RUN)
      if (method === 'GET' && path === '/api/v1/health') return jsonResponse(HEALTH)
      if (method === 'GET' && path === '/api/v1/runs/r1/files?path=') return jsonResponse(ROOT)
      if (method === 'GET' && path === '/api/v1/runs/r1/artifacts') return jsonResponse({ artifacts: [] })
      const linkedMatch = /^\/api\/v1\/runs\/r1\/file-link\?path=(.+)$/.exec(path)
      if (method === 'GET' && linkedMatch && FILES[linkedMatch[1]!]) {
        const entry = FILES[linkedMatch[1]!]!
        return jsonResponse(entry.type === 'dir' ? { type: 'unavailable', path: entry.path, reason: 'Choose a file inside this directory.' } : { ...entry, source: 'worktree' })
      }
      const filesMatch = /^\/api\/v1\/runs\/r1\/files\?path=(.+)$/.exec(path)
      if (method === 'GET' && filesMatch && FILES[filesMatch[1]!]) return jsonResponse(FILES[filesMatch[1]!])
      return jsonResponse({ error: `unstubbed: ${path}` }, 404)
    }),
  )
  return sent
}

function renderFilesRoute(search = '') {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[`/tasks/r1/files${search}`]}>
        <Routes>
          <Route path="/tasks/:id/files" element={<TaskFilesRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const treeButton = (slot: string, path: string) =>
  document.querySelector(`[data-slot="${slot}"][data-path="${path}"]`) as HTMLButtonElement | null

async function openFile(path: string) {
  await waitFor(() => expect(treeButton('files-file', path)).not.toBeNull())
  fireEvent.click(treeButton('files-file', path)!)
}

// ---- the route -------------------------------------------------------------------------------

describe('the Files tab route', () => {
  // #601: previewing hello.ts starts an un-awaited Shiki grammar load that runs on past
  // cleanup into the next case, delaying its FilesView mount (223ms vs 62ms warm) inside
  // RTL's 1000ms waitFor. Warm every grammar the fixtures render so no case pays for it.
  beforeAll(async () => {
    await Promise.all([highlight('', 'typescript'), highlight('', 'markdown')])
  })

  it('opens a bookmarked file selection without searching the tree', async () => {
    stubFetch()
    renderFilesRoute('?path=hello.ts')
    await waitFor(() => expect(document.querySelector('[data-slot="file-preview-code"]')?.textContent).toContain("export const hi = 'world'"))
  })

  it('opens a published snapshot even after the worktree is gone', async () => {
    stubFetch({
      'GET /api/v1/runs/r1/files?path=': () => jsonResponse({ error: 'Worktree removed' }, 409),
      'GET /api/v1/runs/r1/artifacts/report': () => jsonResponse({ type: 'file', path: 'decision.txt', source: 'artifact', size: 8, binary: false, tooLarge: false, content: 'snapshot', artifact: { id: 'report', name: 'decision.txt', createdAt: '2026-09-23T00:00:00Z', size: 8 } }),
    })
    renderFilesRoute('?artifact=report')
    await waitFor(() => expect(document.querySelector('[data-slot="file-preview-code"]')?.textContent).toContain('snapshot'))
    expect(screen.getByRole('link', { name: 'Download' })).toBeTruthy()
  })

  it('renders the header with Files active, the root listing, and the select-a-file prompt', async () => {
    stubFetch()
    renderFilesRoute()

    await waitFor(() => expect(document.querySelector('[data-slot="files-tree"]')).not.toBeNull())
    expect(
      document.querySelector('[data-slot="run-tabs"] a[aria-current="page"]')?.textContent,
    ).toBe('Files')
    // Dirs first (the server's order, rendered verbatim), then files.
    const rows = [...document.querySelectorAll('[data-slot="files-dir"], [data-slot="files-file"]')].map(
      (el) => (el as HTMLElement).dataset.path,
    )
    expect(rows).toEqual(['src', 'big.txt', 'blob.dat', 'hello.ts', 'logo.png'])
    // Nothing selected yet — the pane says so instead of pretending.
    expect(screen.getByRole('heading', { level: 2, name: 'Select a file' })).toBeTruthy()
    // Desktop only: the tree owns its scroller so a deep tree never drags the preview along.
    // Below md the columns stack and the page IS the pane, so none of it applies there.
    await waitFor(() => expect(document.querySelector('[data-slot="files-tree-pane"]')).not.toBeNull())
    const pane = document.querySelector('[data-slot="files-tree-pane"]') as HTMLElement
    // Pin and cap both read the one var the parent declares, so they cannot drift apart.
    expect(pane.parentElement?.className).toContain('[--diff-sticky-top:1rem]')
    expect(pane.className).toContain('md:top-[var(--diff-sticky-top)]')
    expect(pane.className).toContain('md:max-h-[calc(100dvh_-_64px_-_var(--diff-sticky-top)_-_1rem)]')
    expect(pane.className).toContain('md:overflow-y-auto')
    expect(pane.className).toContain('md:overscroll-contain')
    expect(pane.className.split(' ')).not.toContain('overflow-y-auto')
  })

  it('directories are lazy: closed by default, fetched only on first expand', async () => {
    const sent = stubFetch()
    renderFilesRoute()
    await waitFor(() => expect(treeButton('files-dir', 'src')).not.toBeNull())

    // Closed, and its listing was NOT fetched.
    expect(treeButton('files-dir', 'src')?.dataset.state).toBe('closed')
    expect(sent.some((r) => r.includes('path=src'))).toBe(false)

    fireEvent.click(treeButton('files-dir', 'src')!)
    await waitFor(() => expect(treeButton('files-file', 'src/nested.md')).not.toBeNull())
    expect(sent.some((r) => r === 'GET /api/v1/runs/r1/files?path=src')).toBe(true)
    expect(treeButton('files-dir', 'src')?.dataset.state).toBe('open')

    // Collapsing folds the rows again.
    fireEvent.click(treeButton('files-dir', 'src')!)
    expect(treeButton('files-file', 'src/nested.md')).toBeNull()
  })

  it('a text file previews with line numbers and Shiki tokens by extension', async () => {
    stubFetch()
    renderFilesRoute()
    await openFile('hello.ts')

    await waitFor(() => expect(document.querySelector('[data-slot="file-preview-code"]')).not.toBeNull())
    const code = document.querySelector('[data-slot="file-preview-code"]') as HTMLElement
    expect(code.dataset.lang).toBe('typescript')
    expect(code.textContent).toContain("export const hi = 'world'")
    // The header names the file and its honest size.
    expect(document.querySelector('[data-slot="file-preview-head"]')?.textContent).toContain('hello.ts')
    expect(document.querySelector('[data-slot="file-preview-head"]')?.textContent).toContain('27 B')
    // The singleton's tokens land: at least one span carries a --syn-* color.
    await waitFor(
      () => {
        const colored = [...code.querySelectorAll('span[style]')].some((el) =>
          (el.getAttribute('style') ?? '').includes('var(--syn'),
        )
        expect(colored).toBe(true)
      },
      { timeout: 5000 },
    )
  })

  it('an image renders inline through the raw URL (binary flag notwithstanding)', async () => {
    stubFetch()
    renderFilesRoute()
    await openFile('logo.png')

    await waitFor(() => expect(document.querySelector('[data-slot="file-preview-image"]')).not.toBeNull())
    const img = document.querySelector('[data-slot="file-preview-image"]') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/api/v1/runs/r1/file-link?path=logo.png&raw=1')
    expect(img.getAttribute('alt')).toBe('logo.png')
  })

  it('previews a bounded raster larger than the text preview cap', async () => {
    stubFetch({ 'GET /api/v1/runs/r1/file-link?path=logo.png': () => jsonResponse({ type: 'file', path: 'logo.png', source: 'worktree', size: 1024 * 1024, binary: true, tooLarge: true }) })
    renderFilesRoute('?path=logo.png')
    await waitFor(() => expect(document.querySelector('[data-slot="file-preview-image"]')).not.toBeNull())
  })
  it('keeps the path field synchronized with URL selection changes', async () => {
    stubFetch()
    renderFilesRoute('?path=hello.ts')
    await openFile('logo.png')
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('logo.png'))
  })
  it('a size-capped file gets the honest too-large state, never a fake preview', async () => {
    stubFetch()
    renderFilesRoute()
    await openFile('big.txt')

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'Too large to preview' })).toBeTruthy(),
    )
    expect(document.querySelector('[data-slot="file-preview"]')?.textContent).toContain('878.9 kB')
  })

  it('a binary non-image gets the binary state', async () => {
    stubFetch()
    renderFilesRoute()
    await openFile('blob.dat')

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'Binary file' })).toBeTruthy(),
    )
  })

  it('a per-file 409 shows the server words as a refusal, not an outage', async () => {
    stubFetch({
      'GET /api/v1/runs/r1/file-link?path=hello.ts': () =>
        jsonResponse({ type: 'unavailable', path: 'hello.ts', reason: 'symlinks are not served: hello.ts' }),
    })
    renderFilesRoute()
    await openFile('hello.ts')

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'Cannot preview this file' })).toBeTruthy(),
    )
    expect(document.querySelector('[data-slot="file-preview"]')?.textContent).toContain('symlinks are not served')
  })

  it('a root 409 ("no worktree") replaces the whole browser with the server reason', async () => {
    stubFetch({
      'GET /api/v1/runs/r1/files?path=': () =>
        jsonResponse({ error: 'no worktree — this task ran directly in the repo working tree' }, 409),
    })
    renderFilesRoute()

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'No files to browse' })).toBeTruthy(),
    )
    expect(document.body.textContent).toContain('no worktree')
    expect(document.querySelector('[data-slot="files-tree"]')).toBeNull()
  })

  it('a non-409 root failure is a danger state', async () => {
    stubFetch({
      'GET /api/v1/runs/r1/files?path=': () => jsonResponse({ error: 'boom' }, 500),
    })
    renderFilesRoute()

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'Could not load the files' })).toBeTruthy(),
    )
    expect(document.querySelector('[data-slot="centered-state"]')?.getAttribute('data-tone')).toBe('danger')
  })
})


it('opens a known worktree path without fetching unopened directories', async () => {
  const sent = stubFetch()
  renderFilesRoute()
  const input = await screen.findByRole('textbox', { name: 'File path in the worktree' })
  fireEvent.change(input, { target: { value: 'src/nested.md' } })
  fireEvent.click(screen.getByRole('button', { name: 'Open file' }))
  await waitFor(() => expect(sent).toContain('GET /api/v1/runs/r1/file-link?path=src%2Fnested.md'))
  expect(sent).not.toContain('GET /api/v1/runs/r1/files?path=src')
})


it('explains a directory entered in the file-path control instead of blanking the preview', async () => {
  stubFetch()
  renderFilesRoute()
  const input = await screen.findByRole('textbox', { name: 'File path in the worktree' })
  fireEvent.change(input, { target: { value: 'src' } })
  fireEvent.click(screen.getByRole('button', { name: 'Open file' }))
  expect(await screen.findByText('Choose a file inside this directory.')).toBeTruthy()
})
