import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { RunHeader } from './run-header'

/** The thread header's "Hand off" (#589): offered only where the project has a webhook, sends
 *  the optional note to `POST /runs/:id/notify`, and turns into a "Notifying" chip once on. */

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

const run = (extra: Partial<ApiRun> = {}): ApiRun => ({
  id: 'r1',
  title: 'Fix flaky e2e shard',
  workflow: 'quick-task',
  task: 'Fix it',
  status: 'running',
  createdAt: '2026-09-25T12:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
  ...extra,
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function serve(webhook?: { url: string; tokenSet: boolean }, notifyAnswer: (body: unknown) => Response = (body) => json({ ...run(), notify: (body as { notify: boolean }).notify })) {
  const sent: Array<{ path: string; method: string; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input)
    const method = init.method ?? 'GET'
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    sent.push({ path, method, body })
    if (path === '/api/v1/projects') {
      return json({
        projects: [{ id: 'demo', name: 'demo', root: '/repo', addedAt: '', lastOpenedAt: '', source: 'local', status: 'ok', ...(webhook ? { webhook } : {}) }],
        bootProject: 'demo',
        projectsDir: '~/cezar/projects',
      })
    }
    if (path === '/api/v1/runs') return json([])
    if (path.endsWith('/notify') && method === 'POST') return notifyAnswer(body)
    return json({})
  }))
  return sent
}

function renderHeader(record: ApiRun) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[`/tasks/${record.id}`]}>
        <Routes>
          <Route path="/tasks/:id" element={<RunHeader run={record} />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const WEBHOOK = { url: 'https://bot.example/hooks/cez?key=secret', tokenSet: true }

describe('Hand off', () => {
  it('is not offered when the project has no webhook', async () => {
    const sent = serve()
    renderHeader(run())
    await waitFor(() => expect(sent.some((r) => r.path === '/api/v1/projects')).toBe(true))
    expect(screen.queryByRole('button', { name: 'Hand off to webhook' })).toBeNull()
  })

  it('opens the dialog, says where the note goes, and sends it with notify:true', async () => {
    const sent = serve(WEBHOOK)
    renderHeader(run())
    const button = await screen.findByRole('button', { name: 'Hand off to webhook' })
    // A 44px target on a phone; the label is visible from `md` up.
    expect(button.className).toContain('size-11')
    fireEvent.click(button)

    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText('Hand off to webhook')).toBeTruthy()
    // The webhook is named by host and path — never the query string that may hold a secret.
    expect(document.querySelector('[data-slot="handoff-dialog"]')?.textContent).toContain('bot.example/hooks/cez')
    expect(document.querySelector('[data-slot="handoff-dialog"]')?.textContent).not.toContain('secret')
    expect(dialog.getByText('The note goes to the webhook only, not to the agent.')).toBeTruthy()

    fireEvent.change(dialog.getByLabelText('Note'), { target: { value: '  Take over from here  ' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Hand off' }))

    await waitFor(() => {
      expect(sent.find((r) => r.method === 'POST' && r.path.endsWith('/runs/r1/notify'))?.body).toEqual({
        notify: true,
        message: 'Take over from here',
      })
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await screen.findByText('Handed off to the webhook')).toBeTruthy()
  })

  it('hands off without a note', async () => {
    const sent = serve(WEBHOOK)
    renderHeader(run())
    fireEvent.click(await screen.findByRole('button', { name: 'Hand off to webhook' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Hand off' }))
    await waitFor(() => {
      expect(sent.find((r) => r.method === 'POST' && r.path.endsWith('/notify'))?.body).toEqual({ notify: true })
    })
  })

  it('keeps the dialog open and toasts the refusal when the server says no', async () => {
    serve(WEBHOOK, () => json({ error: 'this project has no task webhook' }, 400))
    renderHeader(run())
    fireEvent.click(await screen.findByRole('button', { name: 'Hand off to webhook' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Hand off' }))
    expect(await screen.findByText(/Could not hand off/)).toBeTruthy()
    expect(screen.queryByRole('dialog')).not.toBeNull()
  })
})

describe('Notifying chip', () => {
  const openMenu = async () => {
    fireEvent.pointerDown(await screen.findByRole('button', { name: /^Notifying bot\.example\/hooks\/cez/ }), { button: 0 })
    return within(await screen.findByRole('menu'))
  }

  it('replaces Hand off once the run notifies, and names the webhook', async () => {
    serve(WEBHOOK)
    renderHeader(run({ notify: true }))
    const menu = await openMenu()
    expect(screen.queryByRole('button', { name: 'Hand off to webhook' })).toBeNull()
    expect(menu.getByText('bot.example/hooks/cez')).toBeTruthy()
  })

  it('sends another note from "Send a note…"', async () => {
    const sent = serve(WEBHOOK)
    renderHeader(run({ notify: true }))
    fireEvent.click((await openMenu()).getByRole('menuitem', { name: /Send a note/ }))
    const dialog = within(await screen.findByRole('dialog'))
    const send = dialog.getByRole('button', { name: 'Send note' })
    // A note dialog with no note has nothing to send.
    expect(send.hasAttribute('disabled')).toBe(true)
    fireEvent.change(dialog.getByLabelText('Note'), { target: { value: 'PR is green' } })
    fireEvent.click(send)
    await waitFor(() => {
      expect(sent.find((r) => r.method === 'POST' && r.path.endsWith('/notify'))?.body).toEqual({ notify: true, message: 'PR is green' })
    })
  })

  it('stops notifying', async () => {
    const sent = serve(WEBHOOK)
    renderHeader(run({ notify: true }))
    fireEvent.click((await openMenu()).getByRole('menuitem', { name: /Stop notifying/ }))
    await waitFor(() => {
      expect(sent.find((r) => r.method === 'POST' && r.path.endsWith('/notify'))?.body).toEqual({ notify: false })
    })
  })

  it('still lets a run stop notifying after the project webhook was removed', async () => {
    const sent = serve()
    renderHeader(run({ notify: true }))
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Notifying — webhook actions' }), { button: 0 })
    const menu = within(await screen.findByRole('menu'))
    expect(menu.queryByRole('menuitem', { name: /Send a note/ })).toBeNull()
    fireEvent.click(menu.getByRole('menuitem', { name: /Stop notifying/ }))
    await waitFor(() => expect(sent.some((r) => r.path.endsWith('/notify'))).toBe(true))
  })
})
