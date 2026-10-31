import { QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import type { DeleteBranchesResponse, RepoBranchEntry } from '@open-mercato/cezar-api-client'
import { resetToasts, Toaster } from '@/components/ui/toaster'
import { DeleteBranchDialog, RepoNotLandedSection, notLandedGroups, retainedFinishedTasks } from './repo-not-landed'

const BRANCH: RepoBranchEntry = {
  name: 'cez/12345678', class: 'not-landed', runId: 'r1', title: 'Useful work',
  runStatus: 'done', ahead: 2, pr: null, diffStat: { additions: 12, deletions: 3 },
  lastCommit: { sha: 'abcdef123456', subject: 'Save useful work', at: '2026-10-30T12:00:00Z' },
}
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function serveDelete(reply: () => Response | Promise<Response>) {
  const sent: { path: string; body: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    sent.push({ path: String(input), body: JSON.parse(String(init.body)) })
    return reply()
  }))
  return sent
}

let repoReads = 0
let unrelatedReads = 0

function DialogHarness({ entry, onClose }: { entry: RepoBranchEntry; onClose: () => void }) {
  const [open, setOpen] = useState(true)
  const repo = useQuery({ queryKey: queryKeys.repo, queryFn: () => Promise.resolve(++repoReads) })
  const unrelated = useQuery({ queryKey: ['unrelated-dialog-data'], queryFn: () => Promise.resolve(++unrelatedReads) })
  return <>
    <output aria-label="Repository reads">{repo.data}</output>
    <output aria-label="Unrelated reads">{unrelated.data}</output>
    <button onClick={() => setOpen(true)}>Reopen</button>
    <DeleteBranchDialog entry={open ? entry : null} onClose={() => { onClose(); setOpen(false) }} />
    <Toaster />
  </>
}

function showDialog(entry = BRANCH) {
  repoReads = 0
  unrelatedReads = 0
  const onClose = vi.fn()
  render(<QueryClientProvider client={createQueryClient()}><DialogHarness entry={entry} onClose={onClose} /></QueryClientProvider>)
  return onClose
}

function typeName(value = BRANCH.name) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value } })
}
function submitName() {
  const event = new Event('submit', { bubbles: true, cancelable: true })
  fireEvent(screen.getByRole('textbox').closest('form')!, event)
  expect(event.defaultPrevented).toBe(true)
}

afterEach(() => {
  cleanup()
  resetToasts()
  vi.unstubAllGlobals()
})

describe('DeleteBranchDialog', () => {
  it('refuses form submit and button deletion without the exact typed confirmation', async () => {
    const sent = serveDelete(() => response({ deleted: [BRANCH.name], refused: [] }))
    const onClose = showDialog()
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('')
    for (const typed of ['', 'cez/1234567', 'CEZ/12345678', 'cez/12345678 extra']) {
      typeName(typed)
      const button = screen.getByRole('button', { name: 'Delete branch' })
      expect((button as HTMLButtonElement).disabled).toBe(true)
      fireEvent.click(button)
      await act(async () => submitName())
      expect(sent).toEqual([])
      expect(onClose).not.toHaveBeenCalled()
      expect(screen.getByRole('alertdialog')).toBeTruthy()
    }
  })

  it.each(['button', 'form'])('deletes only the named branch through the %s with trimmed confirmation', async (via) => {
    const sent = serveDelete(() => response({ deleted: [BRANCH.name], refused: [] }))
    const onClose = showDialog()
    typeName(`  ${BRANCH.name}  `)
    expect((screen.getByRole('button', { name: 'Delete branch' }) as HTMLButtonElement).disabled).toBe(false)
    if (via === 'form') submitName()
    else fireEvent.click(screen.getByRole('button', { name: 'Delete branch' }))
    await screen.findByText(`Deleted ${BRANCH.name}`, { exact: true })
    expect(sent).toEqual([{ path: '/api/v1/repo/branches/delete', body: { names: [BRANCH.name], confirm: BRANCH.name } }])
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await waitFor(() => expect(screen.getByLabelText('Repository reads').textContent).toBe('2'))
    expect(screen.getByLabelText('Unrelated reads').textContent).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('')
  })

  it.each(['Keep it', 'Escape'])('clears confirmation when closed with %s', (action) => {
    const sent = serveDelete(() => response({ deleted: [], refused: [] }))
    const onClose = showDialog()
    typeName()
    if (action === 'Keep it') fireEvent.click(screen.getByRole('button', { name: action }))
    else fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('')
    expect((screen.getByRole('button', { name: 'Delete branch' }) as HTMLButtonElement).disabled).toBe(true)
    expect(sent).toEqual([])
  })

  it('keeps the pending deletion open and disables both actions until the response arrives', async () => {
    let finish!: (value: Response) => void
    const reply = new Promise<Response>((resolve) => { finish = resolve })
    const sent = serveDelete(() => reply)
    const onClose = showDialog()
    typeName()
    fireEvent.click(screen.getByRole('button', { name: 'Delete branch' }))
    const pending = await screen.findByRole('button', { name: 'Deleting…' })
    expect((pending as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Keep it' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(sent).toHaveLength(1)
    await act(async () => finish(response({ deleted: [BRANCH.name], refused: [] })))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it.each([
    { deleted: [BRANCH.name], refused: [], dropped: [{ sha: 'a', subject: 'First' }], message: `Deleted ${BRANCH.name} and 1 commit with it` },
    { deleted: [BRANCH.name], refused: [], dropped: [{ sha: 'a', subject: 'First' }, { sha: 'b', subject: 'Second' }], message: `Deleted ${BRANCH.name} and 2 commits with it` },
    { deleted: [BRANCH.name], refused: [], dropped: [], message: `Deleted ${BRANCH.name}` },
    { deleted: [], refused: [{ name: BRANCH.name, reason: 'Branch is checked out' }], message: 'Branch is checked out' },
    { deleted: [], refused: [], message: 'Nothing was deleted' },
  ])('reports the deletion result: $message', async ({ message, ...result }) => {
    serveDelete(() => response(result satisfies DeleteBranchesResponse))
    const onClose = showDialog()
    typeName()
    submitName()
    await screen.findByText(message, { exact: true })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('shows the server refusal and keeps the typed confirmation for a retry', async () => {
    serveDelete(() => response({ error: 'Branch now belongs to a running task' }, 409))
    const onClose = showDialog()
    typeName()
    submitName()
    await screen.findByText('Branch now belongs to a running task', { exact: true })
    expect(document.querySelector('[data-slot="toast"]')?.getAttribute('data-tone')).toBe('danger')
    expect(onClose).not.toHaveBeenCalled()
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(BRANCH.name)
    expect((screen.getByRole('button', { name: 'Delete branch' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it.each([
    { entry: BRANCH, text: 'This drops the work of Useful work. It is not on the base branch and no pull request carries it.', detail: '2 commits will be dropped (+12 −3), the latest “Save useful work” (abcdef1).' },
    { entry: { ...BRANCH, title: null, ahead: 1, diffStat: null, pr: { number: 1, url: 'https://github.com/acme/repo/pull/1', state: 'open' as const } }, text: `This drops the work of ${BRANCH.name}. It is not on the base branch.`, detail: '1 commit will be dropped, the latest “Save useful work” (abcdef1).' },
    { entry: { ...BRANCH, class: 'orphan' as const }, text: 'Its task was deleted, so this branch is the only copy of the work.', detail: '2 commits will be dropped (+12 −3), the latest “Save useful work” (abcdef1).' },
  ])('names the work at risk: $text', ({ entry, text, detail }) => {
    showDialog(entry)
    expect(screen.getByRole('heading', { name: `Delete ${BRANCH.name}?` })).toBeTruthy()
    expect(screen.getByRole('alertdialog').querySelector('p')?.textContent).toBe(text)
    expect(document.querySelector('[data-slot="delete-branch-dropped"]')?.textContent).toBe(detail)
    const input = screen.getByLabelText(`Type ${BRANCH.name} to confirm`) as HTMLInputElement
    expect(input.autocomplete).toBe('off')
    expect(input.getAttribute('spellcheck')).toBe('false')
  })
})

function showSection(entries: RepoBranchEntry[], reply?: () => Response | Promise<Response>) {
  const client = createQueryClient()
  client.setQueryData(queryKeys.repoBranches, { base: 'main', prStateKnown: true, branches: entries, counts: { notLanded: entries.length, cleanup: 0 } })
  client.setQueryData(queryKeys.runs.list(), [])
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (init.method === 'POST') return reply!()
    if (String(input).includes('run-summaries')) return response([])
    if (String(input).endsWith('/repo/branches')) return response({ base: 'main', prStateKnown: true, branches: entries, counts: { notLanded: entries.length, cleanup: 0 } })
    return response({})
  }))
  render(<QueryClientProvider client={client}><MemoryRouter><RepoNotLandedSection /><Toaster /></MemoryRouter></QueryClientProvider>)
}

async function openMenu(name = BRANCH.name) {
  fireEvent.pointerDown(screen.getByRole('button', { name: `More actions for ${name}` }), { button: 0, ctrlKey: false, pointerType: 'mouse' })
  return screen.findByRole('menuitem', { name: 'Delete branch…' })
}

describe('not-landed branch decisions', () => {
  it('groups only eligible branches and separates open or draft PRs from closed PRs', () => {
    const entries: RepoBranchEntry[] = [
      BRANCH,
      { ...BRANCH, name: 'draft', pr: { number: 1, url: 'https://github.com/acme/repo/pull/1', state: 'draft' } },
      { ...BRANCH, name: 'open', pr: { number: 2, url: 'https://github.com/acme/repo/pull/2', state: 'open' } },
      { ...BRANCH, name: 'closed', pr: { number: 3, url: 'https://github.com/acme/repo/pull/3', state: 'closed' } },
      { ...BRANCH, name: 'orphan', class: 'orphan' },
      { ...BRANCH, name: 'active', class: 'active' },
      { ...BRANCH, name: 'merged', class: 'merged' },
    ]
    expect(notLandedGroups(entries).map((group) => ({ key: group.key, names: group.rows.map((row) => row.name) }))).toEqual([
      { key: 'no-pr', names: [BRANCH.name, 'closed'] },
      { key: 'pr-open', names: ['draft', 'open'] },
      { key: 'deleted', names: ['orphan'] },
    ])
    expect(notLandedGroups([])).toEqual([])
  })

  it.each(['done', 'failed', 'cancelled'] as const)('counts only retained %s tasks that have commits', (runStatus) => {
    const active = { ...BRANCH, class: 'active' as const, runStatus }
    expect(retainedFinishedTasks([active])).toBe(1)
    expect(retainedFinishedTasks([
      { ...active, runId: null }, { ...active, ahead: 0 }, { ...active, ahead: -1 },
      { ...active, runStatus: 'review' }, { ...active, runStatus: null },
      { ...active, class: 'not-landed' },
    ])).toBe(0)
  })

  it.each([1, 2])('explains why %s retained finished tasks are not listed', (count) => {
    showSection(Array.from({ length: count }, (_, index) => ({ ...BRANCH, name: `kept-${index}`, class: 'active' })))
    expect(screen.getByRole('heading', { name: 'Nothing else waiting to land' })).toBeTruthy()
    expect(document.querySelector('[data-slot="not-landed-retained"]')?.textContent).toContain(count === 1
      ? '1 finished task still has its worktree and commits not on the base, so it is not listed here.'
      : '2 finished tasks still have their worktree and commits not on the base, so they are not listed here.')
    expect(screen.getByRole('link', { name: 'Cleanup' }).getAttribute('href')).toBe('/git/cleanup')
    expect(document.querySelectorAll('[data-slot="not-landed-row"]')).toHaveLength(0)
  })

  it('opens deletion from the row and closes it without deleting', async () => {
    showSection([BRANCH])
    fireEvent.click(await openMenu())
    expect(screen.getByRole('heading', { name: `Delete ${BRANCH.name}?` })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('link', { name: 'Useful work' }).getAttribute('href')).toBe('/tasks/r1')
  })

  it.each([
    { manual: 'Use gh pr create', message: 'Cannot create PR — Use gh pr create' },
    { manual: undefined, message: 'Cannot create PR' },
  ])('reports the PR refusal: $message', async ({ manual, message }) => {
    showSection([BRANCH], () => response({ error: 'Cannot create PR', manual }, 409))
    fireEvent.click(screen.getByRole('button', { name: 'Create draft PR' }))
    await screen.findByText(message, { exact: true })
    expect(document.querySelector('[data-slot="toast"]')?.getAttribute('data-tone')).toBe('danger')
  })

  it.each([true, false])('copies an orphan branch and reports clipboard success=%s', async (success) => {
    const copy = vi.fn(() => success ? Promise.resolve() : Promise.reject(new Error('Denied')))
    vi.stubGlobal('navigator', { clipboard: { writeText: copy } })
    showSection([{ ...BRANCH, class: 'orphan', runId: null }])
    expect(screen.queryByRole('button', { name: 'Create draft PR' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Open task' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy branch' }))
    await screen.findByText(success ? `Copied ${BRANCH.name}` : 'Could not copy the branch name', { exact: true })
    expect(copy).toHaveBeenCalledExactlyOnceWith(BRANCH.name)
  })

  it.each(['draft', 'closed', 'open'] as const)('shows the %s PR state and keeps open PRs from being recreated', async (state) => {
    showSection([{ ...BRANCH, title: null, pr: { number: 2, url: 'https://github.com/acme/repo/pull/2', state } }])
    expect(document.querySelector('[data-slot="not-landed-pr-state"]')?.textContent).toBe(`· ${state}`)
    expect(screen.getByRole('link', { name: BRANCH.name })).toBeTruthy()
    await openMenu()
    expect(screen.queryByRole('menuitem', { name: 'Create draft PR' }) !== null).toBe(state === 'closed')
  })
})

describe('not-landed asynchronous list actions', () => {
  it('keeps both PR actions disabled while creating, then refreshes the branch and task lists', async () => {
    let finish!: (value: Response) => void
    const reply = new Promise<Response>((resolve) => { finish = resolve })
    showSection([BRANCH], () => reply)
    fireEvent.click(screen.getByRole('button', { name: 'Create draft PR' }))
    const creating = await screen.findByRole('button', { name: 'Creating…' })
    expect((creating as HTMLButtonElement).disabled).toBe(true)
    await openMenu()
    expect(screen.getByRole('menuitem', { name: 'Create draft PR' }).getAttribute('aria-disabled')).toBe('true')
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await act(async () => finish(response({ url: 'https://github.com/acme/repo/pull/21' })))
    await screen.findByText('Draft PR created — https://github.com/acme/repo/pull/21', { exact: true })
    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls.map(([input]) => String(input))
      expect(calls).toContain('/api/v1/repo/branches')
      expect(calls).toContain('/api/v1/run-summaries?archived=recent')
    })
  })

  it('offers PR creation and copy through the row menu', async () => {
    const copy = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText: copy } })
    showSection([BRANCH], () => response({ url: 'https://github.com/acme/repo/pull/22' }))
    await openMenu()
    expect(screen.getByRole('menuitem', { name: 'Open task' }).getAttribute('href')).toBe('/tasks/r1')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy branch' }))
    await screen.findByText(`Copied ${BRANCH.name}`, { exact: true })
    expect(copy).toHaveBeenCalledExactlyOnceWith(BRANCH.name)
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create draft PR' }))
    await screen.findByText('Draft PR created — https://github.com/acme/repo/pull/22', { exact: true })
  })
})
