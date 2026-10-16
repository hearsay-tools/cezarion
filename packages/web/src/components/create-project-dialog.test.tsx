import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { CreateProjectDialog } from '@/components/create-project-dialog'

/**
 * The New project dialog (spec 2026-10-15-create-new-project), driven through a stubbed `fetch`
 * like the clone dialog's suite: the body it puts on the wire is half of what it is.
 */

const fetchMock = vi.fn<typeof fetch>()

vi.mock('@/api/live-coordinator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/live-coordinator')>()),
  onLiveReconcile: () => () => {},
}))

let emitWorkspaceEvent: ((name: string, payload: unknown) => void) | null = null
vi.mock('@/api/global-events', () => ({
  onWorkspaceEvent: (listener: (name: string, payload: unknown) => void) => {
    emitWorkspaceEvent = listener
    return () => {
      emitWorkspaceEvent = null
    }
  },
}))

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  emitWorkspaceEvent = null
  vi.unstubAllGlobals()
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const PROJECT: ProjectListEntry = {
  id: 'fresh-2',
  name: 'fresh',
  root: '/home/me/cezar/projects/fresh',
  addedAt: '2026-10-15T00:00:00.000Z',
  lastOpenedAt: '2026-10-15T00:00:00.000Z',
  source: 'local',
  status: 'ok',
}

const OWNERS = {
  available: true,
  owners: [
    { login: 'octo', personal: true },
    { login: 'acme', personal: false, description: 'Builds rockets' },
  ],
}

const posted: Record<string, unknown>[] = []

function serve({
  owners = async () => json(OWNERS),
  create = async () => json({ project: PROJECT }),
}: { owners?: () => Promise<Response>; create?: () => Promise<Response> } = {}): void {
  posted.length = 0
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/v1/projects/create') {
      posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return create()
    }
    if (url.pathname === '/api/v1/projects/github-owners') return owners()
    if (url.pathname === '/api/v1/projects') {
      return json({ projects: [], bootProject: 'cezar', projectsDir: '~/cezar/projects' })
    }
    return json({ error: `unexpected ${String(init?.method ?? 'GET')} ${url.pathname}` }, 404)
  })
}

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

function renderDialog() {
  const onOpenChange = vi.fn()
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/p/cezar/']}>
        <CreateProjectDialog open onOpenChange={onOpenChange} />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { onOpenChange }
}

const slot = (name: string) => document.querySelector(`[data-slot="${name}"]`) as HTMLElement | null
const slots = (name: string) => [...document.querySelectorAll(`[data-slot="${name}"]`)] as HTMLElement[]
const nameInput = () => slot('create-project-name') as HTMLInputElement
const submit = () => slot('create-project-submit') as HTMLButtonElement
const githubSwitch = () => slot('create-project-github') as HTMLButtonElement
const location = () => document.querySelector('[data-testid="location"]')?.textContent
const ownerRadio = (login: string) =>
  slots('create-project-owner')
    .find((card) => card.textContent?.includes(login))
    ?.querySelector('input[type="radio"]') as HTMLInputElement

async function githubReady() {
  await waitFor(() => expect(githubSwitch().hasAttribute('disabled')).toBe(false))
}

describe('CreateProjectDialog', () => {
  it('opens with GitHub off even when gh is signed in, and creates a local project', async () => {
    serve()
    const { onOpenChange } = renderDialog()
    await githubReady()
    expect(githubSwitch().getAttribute('aria-checked')).toBe('false')

    fireEvent.change(nameInput(), { target: { value: 'fresh' } })
    expect(slot('create-project-path')?.textContent).toBe('~/cezar/projects/fresh')
    fireEvent.click(submit())

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toEqual({ name: 'fresh', checkoutId: expect.stringMatching(/^np-/) })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    await waitFor(() => expect(location()).toBe('/p/fresh-2/'))
  })

  it('turns a typed space into a dash', () => {
    serve()
    renderDialog()
    fireEvent.change(nameInput(), { target: { value: 'my app' } })
    expect(nameInput().value).toBe('my-app')
  })

  it('blocks an invalid name with a hint and sends nothing', () => {
    serve()
    renderDialog()
    for (const value of ['bad/name', '-dash', '..']) {
      fireEvent.change(nameInput(), { target: { value } })
      expect(slot('create-project-name-hint')?.textContent).toContain('letters, digits')
      expect(submit().disabled).toBe(true)
      fireEvent.keyDown(nameInput(), { key: 'Enter' })
    }
    expect(posted).toEqual([])
  })

  it('shows why GitHub is unavailable, disables the switch, and still creates locally', async () => {
    serve({ owners: async () => json({ available: false, reason: 'gh CLI not found — install it' }) })
    renderDialog()
    await waitFor(() => expect(slot('create-project-github-unavailable')?.textContent).toContain('gh CLI not found'))
    expect(githubSwitch().hasAttribute('disabled')).toBe(true)
    fireEvent.change(nameInput(), { target: { value: 'fresh' } })
    expect(submit().disabled).toBe(false)
  })

  it('treats a malformed owners answer as GitHub unavailable instead of crashing', async () => {
    serve({ owners: async () => json({ login: 'octo', orgs: [] }) })
    renderDialog()
    await waitFor(() => expect(slot('create-project-github-unavailable')?.textContent).toContain('unexpected body'))
    expect(githubSwitch().hasAttribute('disabled')).toBe(true)
    fireEvent.change(nameInput(), { target: { value: 'fresh' } })
    expect(submit().disabled).toBe(false)
  })

  it('offers a template only with GitHub on, selects the personal account first, and posts owner and template', async () => {
    serve()
    renderDialog()
    await githubReady()
    const templateMode = () => slot('create-project-start-template') as HTMLInputElement
    expect(templateMode().disabled).toBe(true)
    expect(ownerRadio('octo').disabled).toBe(true)

    fireEvent.click(githubSwitch())
    expect(templateMode().disabled).toBe(false)
    expect(ownerRadio('octo').checked).toBe(true)
    fireEvent.click(ownerRadio('acme'))
    expect(ownerRadio('acme').checked).toBe(true)

    fireEvent.change(nameInput(), { target: { value: 'fresh' } })
    fireEvent.click(templateMode())
    // Template mode waits for a template before Create.
    expect(submit().disabled).toBe(true)
    fireEvent.change(slot('create-project-template') as HTMLInputElement, { target: { value: 'hono' } })
    const suggestions = slots('create-project-template-option')
    expect(suggestions.map((s) => s.textContent)).toEqual([expect.stringContaining('w3cj/hono-open-api-starter')])
    fireEvent.click(suggestions[0]!)
    expect((slot('create-project-template') as HTMLInputElement).value).toBe('w3cj/hono-open-api-starter')
    fireEvent.click(submit())

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toEqual({
      name: 'fresh',
      github: { owner: 'acme', template: 'w3cj/hono-open-api-starter' },
      checkoutId: expect.stringMatching(/^np-/),
    })
  })

  it('picks a template suggestion from the keyboard', async () => {
    serve()
    renderDialog()
    await githubReady()
    fireEvent.click(githubSwitch())
    fireEvent.click(slot('create-project-start-template') as HTMLInputElement)
    const input = slot('create-project-template') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'vue' } })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.value).toBe('nuxt-ui-templates/starter-vue')
    expect(posted).toEqual([])
  })

  it('an empty GitHub repository posts the owner without a template', async () => {
    serve()
    renderDialog()
    await githubReady()
    fireEvent.click(githubSwitch())
    fireEvent.change(nameInput(), { target: { value: 'fresh' } })
    fireEvent.click(submit())
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toEqual({ name: 'fresh', github: { owner: 'octo' }, checkoutId: expect.stringMatching(/^np-/) })
  })

  it('sends one request when Enter is pressed twice', async () => {
    let finish: (r: Response) => void = () => {}
    serve({ create: () => new Promise<Response>((resolve) => (finish = resolve)) })
    renderDialog()
    fireEvent.change(nameInput(), { target: { value: 'fresh' } })
    fireEvent.keyDown(nameInput(), { key: 'Enter' })
    fireEvent.keyDown(nameInput(), { key: 'Enter' })
    fireEvent.click(submit())
    await waitFor(() => expect(posted).toHaveLength(1))
    await waitFor(() => expect(submit().disabled).toBe(true))
    finish(json({ project: PROJECT }))
    await waitFor(() => expect(location()).toBe('/p/fresh-2/'))
    expect(posted).toHaveLength(1)
  })

  it('shows progress for its own request only', async () => {
    let finish: (r: Response) => void = () => {}
    serve({ create: () => new Promise<Response>((resolve) => (finish = resolve)) })
    renderDialog()
    fireEvent.change(nameInput(), { target: { value: 'fresh' } })
    fireEvent.click(submit())
    await waitFor(() => expect(posted).toHaveLength(1))
    const id = posted[0]?.checkoutId
    emitWorkspaceEvent?.('checkout-progress', { checkoutId: 'other', name: 'x', phase: 'cloning', line: 'not mine' })
    emitWorkspaceEvent?.('checkout-progress', { checkoutId: id, name: 'fresh', phase: 'cloning', line: 'Initializing a git repository…' })
    await waitFor(() => expect(slot('create-project-progress')?.textContent).toBe('Initializing a git repository…'))
    finish(json({ project: PROJECT }))
  })

  it('keeps the dialog open on a warning, shows it, and goes to the project on request', async () => {
    const warning =
      'The private repository https://github.com/octo/fresh was created, but pushing main failed: fatal: x. Finish in /p/fresh with: git push -u origin main'
    serve({ create: async () => json({ project: { ...PROJECT, source: 'checkout' }, warning }) })
    const { onOpenChange } = renderDialog()
    await githubReady()
    fireEvent.click(githubSwitch())
    fireEvent.change(nameInput(), { target: { value: 'fresh' } })
    fireEvent.click(submit())

    await waitFor(() => expect(slot('create-project-warning')?.textContent).toContain('pushing main failed'))
    expect(slot('create-project-warning')?.textContent).toContain('git push -u origin main')
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(location()).toBe('/p/cezar/')
    fireEvent.click(slot('create-project-open') as HTMLButtonElement)
    await waitFor(() => expect(location()).toBe('/p/fresh-2/'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('renders a server error verbatim and allows a retry', async () => {
    serve({ create: async () => json({ error: 'a repository named octo/fresh already exists on GitHub' }, 409) })
    renderDialog()
    fireEvent.change(nameInput(), { target: { value: 'fresh' } })
    fireEvent.click(submit())
    await waitFor(() =>
      expect(slot('create-project-error')?.textContent).toBe('a repository named octo/fresh already exists on GitHub'),
    )
    expect(submit().disabled).toBe(false)
  })
})
