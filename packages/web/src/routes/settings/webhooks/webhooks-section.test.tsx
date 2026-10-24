import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectListEntry, ProjectWebhook } from '@open-mercato/cezar-api-client'
import { WEBHOOK_TRIGGERS } from '@open-mercato/cezar-api-client/contract/attention'
import { useProjects, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { ProjectWebhooksField } from './webhooks-section'

/**
 * Settings → General → Webhooks (hearsay-tools/cezarion#1576): several webhooks per project,
 * one card and one form each. The fake server below keeps the list the way the real routes do,
 * so the registry refetch after each write answers with what was written.
 */

let webhooks: ProjectWebhook[] = []
let requests: Array<{ method: string; url: string; body?: unknown }> = []
/** When set, the next webhook write answers 409 with this error. */
let refuse: string | null = null

const entry = (): ProjectListEntry => ({
  id: 'demo',
  name: 'demo-project',
  root: '/Users/me/code/demo-project',
  addedAt: '2026-07-20T10:00:00.000Z',
  lastOpenedAt: '2026-08-01T10:00:00.000Z',
  source: 'local',
  status: 'ok',
  ...(webhooks.length > 0 ? { webhooks } : {}),
})

const hook = (id: string, extra: Partial<ProjectWebhook> = {}): ProjectWebhook => ({
  id,
  name: id === 'w1' ? 'Team bot' : 'Release notes',
  url: `https://bot.example/${id}?key=secret`,
  tokenSet: false,
  tasks: true,
  agent: false,
  ...extra,
})

function serve() {
  requests = []
  // Radix's switch measures its thumb with a ResizeObserver; jsdom has none.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      requests.push({ method, url, body })
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
      if (url === '/api/v1/projects' && method === 'GET') {
        return json({ projects: [entry()], bootProject: 'demo', projectsDir: '~/cezar/projects' })
      }
      const match = /^\/api\/v1\/projects\/demo\/webhooks(?:\/([^/]+))?(\/test)?$/.exec(url)
      if (!match) return new Promise<never>(() => {})
      const [, id, isTest] = match
      if (isTest) return json({ ok: true, status: 204 })
      if (refuse && method !== 'GET') {
        const error = refuse
        refuse = null
        return json({ error }, 409)
      }
      if (method === 'POST') {
        const { token, ...rest } = body as Record<string, unknown>
        const created = { id: 'w9', tokenSet: Boolean(token), tasks: false, agent: false, ...rest } as ProjectWebhook
        webhooks = [...webhooks, created]
        return json({ project: entry(), webhook: created }, 201)
      }
      if (method === 'PATCH') {
        const { token, ...rest } = body as Record<string, unknown>
        webhooks = webhooks.map((webhook) =>
          webhook.id === id
            ? ({ ...webhook, ...rest, tokenSet: token === undefined ? webhook.tokenSet : token !== '' } as ProjectWebhook)
            : webhook,
        )
        return json({ project: entry(), webhook: webhooks.find((webhook) => webhook.id === id) })
      }
      if (method === 'DELETE') {
        webhooks = webhooks.filter((webhook) => webhook.id !== id)
        return json({ project: entry() })
      }
      return new Promise<never>(() => {})
    }),
  )
}

/** Renders the section the way General does: from the registry query, so each write's answer
 *  and refetch reach the cards. */
function Live() {
  const project = useProjects().data?.projects[0]
  return project ? <ProjectWebhooksField project={project} /> : null
}

function renderSection() {
  const client = createQueryClient()
  client.setQueryData(workspaceQueryKeys.projects, { projects: [entry()], bootProject: 'demo', projectsDir: '~/cezar/projects' })
  return render(
    <QueryClientProvider client={client}>
      <Live />
    </QueryClientProvider>,
  )
}

const card = (name: string) => {
  const el = screen.getByText(name, { selector: '[data-slot="webhook-card-name"]' }).closest('[data-slot="webhook-card"]')
  expect(el).not.toBeNull()
  return within(el as HTMLElement)
}

const open = (name: string) => {
  fireEvent.click(card(name).getByRole('button', { name: new RegExp(`^${name}`) }))
  return card(name)
}

beforeEach(() => {
  webhooks = []
  refuse = null
  serve()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Webhooks', () => {
  it('starts empty, and Add webhook opens a draft that Create posts', async () => {
    renderSection()
    expect(screen.getByText(/^No webhooks yet\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add webhook' }))
    expect(screen.queryByText(/^No webhooks yet\./)).toBeNull()
    const draft = within(screen.getByRole('form', { name: 'New webhook' }))
    const create = draft.getByRole('button', { name: 'Create' })
    expect(create.hasAttribute('disabled')).toBe(true)
    fireEvent.change(draft.getByLabelText('Name'), { target: { value: ' Team bot ' } })
    fireEvent.change(draft.getByLabelText('URL'), { target: { value: 'https://bot.example/hooks/cez' } })
    fireEvent.change(draft.getByLabelText('Token'), { target: { value: 'secret-token' } })
    fireEvent.click(draft.getByRole('switch', { name: 'Let agents send reports' }))
    fireEvent.click(create)

    await waitFor(() => {
      expect(requests.find((r) => r.method === 'POST')).toMatchObject({
        url: '/api/v1/projects/demo/webhooks',
        body: { name: 'Team bot', url: 'https://bot.example/hooks/cez', token: 'secret-token', tasks: true, agent: true },
      })
    })
    // The draft becomes a normal card, opened, with the token write-only.
    await waitFor(() => expect(screen.queryByRole('form', { name: 'New webhook' })).toBeNull())
    const saved = card('Team bot')
    expect(saved.getByLabelText('Token').getAttribute('placeholder')).toContain('Token set')
    expect((saved.getByLabelText('Token') as HTMLInputElement).value).toBe('')
  })

  it('Cancel drops the draft and brings the empty state back', () => {
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Add webhook' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form', { name: 'New webhook' })).toBeNull()
    expect(screen.getByText(/^No webhooks yet\./)).toBeTruthy()
  })

  it('names each webhook with host and path and badges what it is for', () => {
    webhooks = [hook('w1'), hook('w2', { tasks: false, agent: true })]
    renderSection()
    const first = card('Team bot')
    expect(first.getByText('bot.example/w1')).toBeTruthy()
    expect(first.getByText('Task notifications')).toBeTruthy()
    expect(first.queryByText('Agents')).toBeNull()
    const second = card('Release notes')
    expect(second.getByText('Agents')).toBeTruthy()
    expect(second.queryByText('Task notifications')).toBeNull()
    // The query string may carry a secret; it never reaches the screen.
    expect(document.body.textContent).not.toContain('secret')
  })

  it('saving one webhook leaves the other card’s unsaved edits alone', async () => {
    webhooks = [hook('w1'), hook('w2')]
    renderSection()
    const first = open('Team bot')
    const second = open('Release notes')
    fireEvent.change(second.getByLabelText('Description'), { target: { value: 'Not saved yet' } })
    fireEvent.change(first.getByLabelText('URL'), { target: { value: 'https://bot.example/moved' } })
    fireEvent.click(first.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PATCH')).toMatchObject({
        url: '/api/v1/projects/demo/webhooks/w1',
        body: { url: 'https://bot.example/moved' },
      })
    })
    await waitFor(() => expect(card('Team bot').getByText('bot.example/moved')).toBeTruthy())
    expect((card('Release notes').getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Not saved yet')
    expect(card('Release notes').getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false)
  })

  it('keeps every value and says how to recover when the save is refused', async () => {
    webhooks = [hook('w1'), hook('w2')]
    renderSection()
    const first = open('Team bot')
    fireEvent.change(first.getByLabelText('Name'), { target: { value: 'release notes' } })
    fireEvent.change(first.getByLabelText('Token'), { target: { value: 'typed-token' } })
    refuse = 'a webhook named "release notes" already exists'
    fireEvent.click(first.getByRole('button', { name: 'Save' }))

    const alert = await first.findByRole('alert')
    expect(alert.textContent).toBe('Not saved: a webhook named "release notes" already exists. Fix the field and select Save again.')
    expect((first.getByLabelText('Name') as HTMLInputElement).value).toBe('release notes')
    expect((first.getByLabelText('Token') as HTMLInputElement).value).toBe('typed-token')
  })

  it('starts from the stored state selection, shows it only with task notifications on, and saves it in order', async () => {
    webhooks = [hook('w1')]
    renderSection()
    const first = open('Team bot')
    const boxes = () => Array.from(document.querySelectorAll<HTMLInputElement>('[data-slot="webhook-triggers"] input[type="checkbox"]'))
    expect(boxes().map((box) => box.dataset.trigger)).toEqual([...WEBHOOK_TRIGGERS])
    expect(boxes().filter((box) => box.checked).map((box) => box.dataset.trigger)).toEqual(['needs-you', 'failed', 'done', 'cancelled'])
    expect(first.getByText('Handing a task off and Send test always deliver.')).toBeTruthy()
    fireEvent.click(first.getByRole('checkbox', { name: /Waiting on CI/ }))
    fireEvent.click(first.getByRole('checkbox', { name: /^Done/ }))
    fireEvent.click(first.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({ triggers: ['needs-you', 'failed', 'cancelled', 'waiting-ci'] })
    })

    fireEvent.click(first.getByRole('switch', { name: 'Task notifications' }))
    expect(boxes()).toEqual([])
  })

  it('sends a test, clears the token and removes one webhook', async () => {
    webhooks = [hook('w1', { tokenSet: true }), hook('w2')]
    renderSection()
    const first = open('Team bot')
    fireEvent.click(first.getByRole('button', { name: 'Send test' }))
    expect((await first.findByRole('status')).textContent).toBe('Delivered (HTTP 204).')
    expect(requests.some((r) => r.method === 'POST' && r.url === '/api/v1/projects/demo/webhooks/w1/test')).toBe(true)

    fireEvent.click(first.getByRole('button', { name: 'Clear token' }))
    await waitFor(() => expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({ token: '' }))

    await waitFor(() => expect(card('Team bot').getByRole('button', { name: 'Remove Team bot' }).hasAttribute('disabled')).toBe(false))
    fireEvent.click(card('Team bot').getByRole('button', { name: 'Remove Team bot' }))
    await waitFor(() => expect(screen.queryByText('Team bot')).toBeNull())
    expect(requests.some((r) => r.method === 'DELETE' && r.url === '/api/v1/projects/demo/webhooks/w1')).toBe(true)
    expect(card('Release notes')).toBeTruthy()
  })
})
