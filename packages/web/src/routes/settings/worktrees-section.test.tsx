import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { ConfigResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'

/**
 * Project settings → Worktrees: the "Keep last N worktrees" field (#483). Renders the
 * current value, saves the entered number (0 = unlimited, sent as a number so it
 * is never mistaken for "clear"), and rejects out-of-range / non-integer input.
 * The API contract itself is pinned server-side in src/server/config-api.test.ts.
 *
 * The field moved out of Resources into its own PROJECT section in step 3.5 (retention sizes
 * one repo's worktree pool). Its store did not move: every save below is a PUT to the
 * project-scoped `/api/v1/config`, which is exactly the half of the split this pins.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

function serve(config: Partial<ConfigResponse> = {}) {
  requests = []
  const state: ConfigResponse = {
    baseBranch: null,
    defaultRunner: 'claude',
    systemPrompt: null,
    defaultModels: {},
    modelsLocked: false,
    maxParallel: 2,
    memoryLimitMb: null,
    worktreeRetention: 10,
    liveTitleUpdates: null,
    reviewGate: null,
    worktreeSetup: null,
    worktreeSetupIssue: null,
    ...config,
  }
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/config' && method === 'GET') return json(state)
      if (url === '/api/v1/config' && method === 'PUT') {
        if (body?.worktreeRetention !== undefined) {
          state.worktreeRetention = body.worktreeRetention as number
        }
        if (body && 'worktreeSetup' in body) {
          const setup = body.worktreeSetup as { commands: string[]; timeoutSeconds?: number } | null
          state.worktreeSetup = setup && setup.commands.length > 0
            ? { commands: setup.commands, timeoutSeconds: setup.timeoutSeconds ?? 900 }
            : null
          state.worktreeSetupIssue = null
        }
        return json(state)
      }
      return new Promise<never>(() => {})
    }),
  )
}

/** Seeds the step-3.2 route gates — boot id (legacy redirect) + registry (known-check) — so a
 *  flat entry URL lands scoped immediately. The boot project mounts UNSCOPED, so the exact
 *  `/api/v1/*` paths this file's fetch stub matches stay byte-identical. */
function gateSeededClient(capabilities?: { localHandoff: boolean }) {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { bootProject: 'boot', ...(capabilities ? { capabilities } : {}) })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [],
    bootProject: 'boot',
    projectsDir: '~/cezar/projects',
  })
  return client
}

function renderAt(entry: string, capabilities?: { localHandoff: boolean }) {
  render(
    <QueryClientProvider client={gateSeededClient(capabilities)}>
      <MemoryRouter initialEntries={[entry]}>
        <AppRoutes />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const retentionInput = () =>
  document.querySelector<HTMLInputElement>('[data-slot="resources-worktree-retention"]')
const saveButton = () =>
  document.querySelector<HTMLButtonElement>('[data-action="resources-save-retention"]')
const puts = () =>
  requests.filter(
    (r) => r.method === 'PUT' && r.url === '/api/v1/config' && (r.body as { worktreeRetention?: unknown })?.worktreeRetention !== undefined,
  )

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('Project settings → Worktrees: keep-last-N-worktrees (#483)', () => {
  it('keeps only configuration: the retention count and a link to Git → Cleanup, never the disk panel', async () => {
    serve({ worktreeRetention: 7 })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(retentionInput()).not.toBeNull())
    expect(screen.getByText('Keep N finished worktrees')).toBeTruthy()
    const link = document.querySelector('[data-slot="worktrees-manage-link"]')
    expect(link?.textContent).toBe('Manage worktrees on Git')
    expect(link?.getAttribute('href')).toBe('/p/boot/git/cleanup')
    // Issue 06 §3: the panel is listed once, on Git.
    expect(document.querySelector('[data-slot="worktrees-panel"]')).toBeNull()
    expect(requests.some((request) => request.url.endsWith('/worktrees'))).toBe(false)
  })

  it('renders the configured value and disables Save until it changes', async () => {
    serve({ worktreeRetention: 7 })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(retentionInput()).not.toBeNull())
    expect(retentionInput()!.value).toBe('7')
    expect(saveButton()!.disabled).toBe(true)
  })

  it('saves the entered count through PUT /api/v1/config', async () => {
    serve({ worktreeRetention: 10 })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(retentionInput()).not.toBeNull())

    fireEvent.change(retentionInput()!, { target: { value: '3' } })
    expect(saveButton()!.disabled).toBe(false)
    fireEvent.click(saveButton()!)

    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ worktreeRetention: 3 })
  })

  it('saves 0 as a real value (unlimited), not as a clear', async () => {
    serve({ worktreeRetention: 5 })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(retentionInput()).not.toBeNull())

    fireEvent.change(retentionInput()!, { target: { value: '0' } })
    fireEvent.click(saveButton()!)

    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ worktreeRetention: 0 })
  })

  it('rejects a negative, over-limit, or non-integer count (Save stays disabled, no PUT)', async () => {
    serve({ worktreeRetention: 10 })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(retentionInput()).not.toBeNull())

    for (const bad of ['-1', '1001', '2.5', '']) {
      fireEvent.change(retentionInput()!, { target: { value: bad } })
      expect(saveButton()!.disabled).toBe(true)
      expect(document.querySelector('[data-slot="resources-retention-invalid"]')).not.toBeNull()
    }
    expect(puts()).toHaveLength(0)
  })
})

/**
 * Project settings → Worktrees: "Prepare new worktrees" (#917, spec
 * `.ai/specs/2026-10-07-worktree-setup.md`). One command per line; the default timeout is never
 * sent; a hosted cockpit shows the setting read-only because the host runs these commands.
 */
describe('Project settings → Worktrees: worktree setup commands (#917)', () => {
  const commandsBox = () => document.querySelector<HTMLTextAreaElement>('[data-slot="worktree-setup-commands"]')
  const timeoutInput = () => document.querySelector<HTMLInputElement>('[data-slot="worktree-setup-timeout"]')
  const saveSetup = () => document.querySelector<HTMLButtonElement>('[data-action="worktree-setup-save"]')
  const setupPuts = () =>
    requests.filter((r) => r.method === 'PUT' && r.url === '/api/v1/config' && r.body !== undefined && 'worktreeSetup' in (r.body as object))
  const LOCAL = { localHandoff: true }

  it('shows configured commands one per line and the timeout', async () => {
    serve({ worktreeSetup: { commands: ['npm ci', 'cp a b'], timeoutSeconds: 600 } })
    renderAt('/settings/worktrees', LOCAL)
    await waitFor(() => expect(commandsBox()).not.toBeNull())
    expect(screen.getByText('Prepare new worktrees')).toBeTruthy()
    expect(commandsBox()!.value).toBe('npm ci\ncp a b')
    expect(timeoutInput()!.value).toBe('600')
    expect(saveSetup()!.disabled).toBe(true)
  })

  it('saving sends trimmed commands and omits the default timeout', async () => {
    serve()
    renderAt('/settings/worktrees', LOCAL)
    await waitFor(() => expect(commandsBox()).not.toBeNull())
    expect(timeoutInput()!.value).toBe('900')
    fireEvent.change(commandsBox()!, { target: { value: '  npm ci  \n\n cp a b\n' } })
    fireEvent.click(saveSetup()!)
    await waitFor(() => expect(setupPuts()).toHaveLength(1))
    expect(setupPuts()[0]?.body).toEqual({ worktreeSetup: { commands: ['npm ci', 'cp a b'] } })
    await waitFor(() => expect(screen.getByText('Worktree setup saved')).toBeTruthy())
  })

  it('saving a non-default timeout sends it', async () => {
    serve({ worktreeSetup: { commands: ['npm ci'], timeoutSeconds: 900 } })
    renderAt('/settings/worktrees', LOCAL)
    await waitFor(() => expect(timeoutInput()).not.toBeNull())
    fireEvent.change(timeoutInput()!, { target: { value: '60' } })
    fireEvent.click(saveSetup()!)
    await waitFor(() => expect(setupPuts()).toHaveLength(1))
    expect(setupPuts()[0]?.body).toEqual({ worktreeSetup: { commands: ['npm ci'], timeoutSeconds: 60 } })
  })

  it('clearing every line sends null', async () => {
    serve({ worktreeSetup: { commands: ['npm ci'], timeoutSeconds: 900 } })
    renderAt('/settings/worktrees', LOCAL)
    await waitFor(() => expect(commandsBox()).not.toBeNull())
    fireEvent.change(commandsBox()!, { target: { value: '  \n' } })
    fireEvent.click(saveSetup()!)
    await waitFor(() => expect(setupPuts()).toHaveLength(1))
    expect(setupPuts()[0]?.body).toEqual({ worktreeSetup: null })
    await waitFor(() => expect(screen.getByText('Worktree setup cleared')).toBeTruthy())
  })

  it('a hosted cockpit shows the field read-only', async () => {
    serve({ worktreeSetup: { commands: ['npm ci'], timeoutSeconds: 900 } })
    renderAt('/settings/worktrees', { localHandoff: false })
    await waitFor(() => expect(commandsBox()).not.toBeNull())
    expect(commandsBox()!.readOnly).toBe(true)
    expect(timeoutInput()!.readOnly).toBe(true)
    expect(saveSetup()!.disabled).toBe(true)
    expect(document.querySelector('[data-slot="worktree-setup-readonly"]')?.textContent).toBe(
      'Setup commands can be edited only on the machine running Cezar.',
    )
  })

  it('an invalid config shows the issue', async () => {
    serve({ worktreeSetup: null, worktreeSetupIssue: 'commands: Invalid input' })
    renderAt('/settings/worktrees', LOCAL)
    await waitFor(() => expect(commandsBox()).not.toBeNull())
    expect(document.querySelector('[data-slot="worktree-setup-issue"]')?.textContent).toBe(
      'config.json has an invalid worktreeSetup (commands: Invalid input) — saving replaces it.',
    )
  })

  it('more than 20 commands disables Save', async () => {
    serve()
    renderAt('/settings/worktrees', LOCAL)
    await waitFor(() => expect(commandsBox()).not.toBeNull())
    fireEvent.change(commandsBox()!, { target: { value: Array.from({ length: 21 }, (_, i) => `echo ${i}`).join('\n') } })
    expect(saveSetup()!.disabled).toBe(true)
    expect(document.querySelector('[data-slot="worktree-setup-invalid"]')?.textContent).toContain('20')
  })

  it('a timeout outside 1–7200 disables Save', async () => {
    serve({ worktreeSetup: { commands: ['npm ci'], timeoutSeconds: 900 } })
    renderAt('/settings/worktrees', LOCAL)
    await waitFor(() => expect(timeoutInput()).not.toBeNull())
    fireEvent.change(timeoutInput()!, { target: { value: '7201' } })
    expect(saveSetup()!.disabled).toBe(true)
    expect(document.querySelector('[data-slot="worktree-setup-invalid"]')).not.toBeNull()
  })
})
