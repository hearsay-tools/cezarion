import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'

/**
 * Global settings → Resources (step 3.5): `maxParallel` and `memoryLimitMb` moved out of the
 * per-repo config into `~/.cezar/config.json` (spec §"Resource governance" — they protect the
 * host, not a repo). What this pins is the store: every read and write goes to
 * `/api/v1/workspace/config`, and the per-repo `/api/v1/config` is never touched from here — a
 * regression there would silently re-introduce a value the engine no longer reads.
 *
 * The route contract itself (bounds, the semaphore refresh) is pinned server-side in
 * src/server/workspace-api.test.ts.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

function serve(resources: Partial<WorkspaceConfigResponse['resources']> = {}) {
  requests = []
  const state: WorkspaceConfigResponse = {
    agentDefaults: {},
    browseRoot: '~/',
    projectsDir: '~/cezar/projects',
    archiveOnMerge: null,
    effectiveArchiveOnMerge: false,
    archiveOnMergeSource: 'default',
    composerDefaults: {
      autonomous: null,
      worktree: null,
      inheritedAutonomous: 'source-dependent',
      inheritedWorktree: true,
    },
    resources: {
      maxParallel: 2,
      maxMonitoringSessions: 2,
      monitoringWakeIntervalMinutes: null,
      autoResumeOnUsageLimit: true,
      memoryLimitMb: null,
      worktreeRetentionDefault: 10,
      ...resources,
    },
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
      if (url === '/api/v1/workspace/config' && method === 'GET') return json(state)
      if (url === '/api/v1/workspace/config' && method === 'PUT') {
        Object.assign(state.resources, (body?.resources ?? {}) as object)
        Object.assign(state.composerDefaults!, (body?.composerDefaults ?? {}) as object)
        return json(state)
      }
      return new Promise<never>(() => {})
    }),
  )
  return state
}

/** Seeds the step-3.2 route gates so the shell renders immediately. The global settings area is
 *  unscoped, but the gates still answer for the chrome rendered around it. */
function gateSeededClient() {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { bootProject: 'boot' })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [],
    bootProject: 'boot',
    projectsDir: '~/cezar/projects',
  })
  return client
}

function renderResources() {
  render(
    <QueryClientProvider client={gateSeededClient()}>
      <MemoryRouter initialEntries={['/settings/global/resources']}>
        <AppRoutes />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const parallelSelect = () =>
  document.querySelector<HTMLSelectElement>('[data-slot="resources-max-parallel"]')
const memoryInput = () =>
  document.querySelector<HTMLInputElement>('[data-slot="resources-memory-limit"]')
const saveMemory = () =>
  document.querySelector<HTMLButtonElement>('[data-action="resources-save-memory"]')
const puts = () => requests.filter((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/config')
const monitoringSelect = () => document.querySelector<HTMLSelectElement>('[data-slot="resources-max-monitoring"]')
const wakeMode = () => document.querySelector<HTMLButtonElement>('[data-slot="resources-monitoring-wake-mode"]')
const wakeInterval = () => document.querySelector<HTMLInputElement>('[data-slot="resources-monitoring-wake-interval"]')
const saveWake = () => document.querySelector<HTMLButtonElement>('[data-action="resources-save-monitoring-wake"]')

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('Global settings → Resources', () => {
  it('shows loading while the workspace config is pending', () => {
    serve()
    vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>(() => {}))
    renderResources()

    expect(screen.getByText('Loading resource settings…')).toBeTruthy()
    expect(parallelSelect()).toBeNull()
  })

  it('shows the server error when the workspace config cannot load', async () => {
    serve()
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Config is unreadable' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }))
    renderResources()

    expect(await screen.findByRole('heading', { name: 'Resource settings did not load' })).toBeTruthy()
    expect(screen.getByText('Config is unreadable')).toBeTruthy()
    expect(parallelSelect()).toBeNull()
  })

  it('renders the workspace values, read from /api/v1/workspace/config', async () => {
    serve({ maxParallel: 5, memoryLimitMb: 4096 })
    renderResources()

    await waitFor(() => expect(parallelSelect()).not.toBeNull())
    expect(parallelSelect()!.value).toBe('5')
    expect(memoryInput()!.value).toBe('4096')
    // The per-repo config is not even read by this pane.
    expect(requests.some((r) => r.url === '/api/v1/config')).toBe(false)
  })

  it('saves maxParallel to the WORKSPACE config, never the per-repo one', async () => {
    serve({ maxParallel: 2 })
    renderResources()
    await waitFor(() => expect(parallelSelect()).not.toBeNull())

    fireEvent.change(parallelSelect()!, { target: { value: '6' } })

    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ resources: { maxParallel: 6 } })
    expect(requests.some((r) => r.method === 'PUT' && r.url === '/api/v1/config')).toBe(false)
  })

  it('links workspace limits to the per-project controls', async () => {
    serve()
    renderResources()

    const link = await screen.findByRole('link', { name: 'Configure per-project limits' })
    expect(link.getAttribute('href')).toBe('/settings/global/projects')
  })

  it('saves the extra monitoring capacity and explains the two pools', async () => {
    serve({ maxParallel: 4, maxMonitoringSessions: 2 })
    renderResources()
    await waitFor(() => expect(monitoringSelect()).not.toBeNull())
    expect(screen.getByText(/Capacity: 4 active \+ 2 monitoring/)).not.toBeNull()
    fireEvent.change(monitoringSelect()!, { target: { value: '3' } })
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ resources: { maxMonitoringSessions: 3 } })
  })

  it('offers every parallel and monitoring capacity, including zero extra sessions', async () => {
    serve({ maxMonitoringSessions: 0 })
    renderResources()
    await waitFor(() => expect(monitoringSelect()).not.toBeNull())

    expect(Array.from(parallelSelect()!.options, (option) => option.value))
      .toEqual(Array.from({ length: 16 }, (_, i) => String(i + 1)))
    expect(Array.from(monitoringSelect()!.options, (option) => option.value))
      .toEqual(Array.from({ length: 17 }, (_, i) => String(i)))
    expect(monitoringSelect()!.value).toBe('0')
    expect(screen.getByText(/Capacity: 2 active \+ 0 monitoring/)).toBeTruthy()
  })

  it('defaults auto-resume to on for servers from before the usage-limit feature', async () => {
    const state = serve()
    // d3aff0aaf added this field to the v1 contract and workspaceConfigBody response.
    Reflect.deleteProperty(state.resources, 'autoResumeOnUsageLimit')
    renderResources()

    const toggle = await screen.findByRole('switch', { name: 'Auto-resume after a usage limit' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })

  it('keeps wake-ups parked by default and saves an explicit interval', async () => {
    serve({ monitoringWakeIntervalMinutes: null })
    renderResources()
    await waitFor(() => expect(wakeMode()).not.toBeNull())
    expect(wakeMode()!.getAttribute('aria-checked')).toBe('false')
    expect(wakeInterval()).toBeNull()
    expect(saveWake()!.disabled).toBe(true)
    fireEvent.click(wakeMode()!)
    expect(wakeMode()!.getAttribute('aria-checked')).toBe('true')
    expect(wakeInterval()!.value).toBe('5')
    expect(saveWake()!.disabled).toBe(false)
    fireEvent.click(saveWake()!)
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ resources: { monitoringWakeIntervalMinutes: 5 } })
    expect(await screen.findByText('Monitoring will re-check every 5 minutes')).toBeTruthy()
    await waitFor(() => expect(saveWake()!.disabled).toBe(true))
  })

  it.each(['0', '1.5', '61'])('rejects a wake interval of %s minutes', async (value) => {
    serve({ monitoringWakeIntervalMinutes: 10 })
    renderResources()
    await waitFor(() => expect(wakeInterval()).not.toBeNull())

    fireEvent.change(wakeInterval()!, { target: { value } })
    expect(wakeInterval()!.value).toBe(value)
    expect(screen.getByText('Enter a whole number from 1 to 60 minutes.')).toBeTruthy()
    expect(saveWake()!.disabled).toBe(true)
    fireEvent.click(saveWake()!)
    expect(puts()).toHaveLength(0)
  })

  it.each([1, 60])('saves the inclusive wake interval boundary of %s minutes', async (minutes) => {
    serve({ monitoringWakeIntervalMinutes: 10 })
    renderResources()
    await waitFor(() => expect(wakeInterval()).not.toBeNull())
    expect(wakeMode()!.getAttribute('aria-checked')).toBe('true')
    expect(wakeInterval()!.value).toBe('10')
    expect(saveWake()!.disabled).toBe(true)

    fireEvent.change(wakeInterval()!, { target: { value: String(minutes) } })
    expect(saveWake()!.disabled).toBe(false)
    expect(screen.queryByText('Enter a whole number from 1 to 60 minutes.')).toBeNull()
    fireEvent.click(saveWake()!)
    expect(await screen.findByText(`Monitoring will re-check every ${minutes} minutes`)).toBeTruthy()
    expect(puts().at(-1)?.body).toEqual({ resources: { monitoringWakeIntervalMinutes: minutes } })
    await waitFor(() => expect(saveWake()!.disabled).toBe(true))
  })

  it('parks monitoring with an invalid draft interval, then restores the saved parked state', async () => {
    serve({ monitoringWakeIntervalMinutes: 10 })
    renderResources()
    await waitFor(() => expect(wakeInterval()).not.toBeNull())
    fireEvent.change(wakeInterval()!, { target: { value: '61' } })
    fireEvent.click(wakeMode()!)

    expect(wakeMode()!.getAttribute('aria-checked')).toBe('false')
    expect(wakeInterval()).toBeNull()
    expect(screen.queryByText('Enter a whole number from 1 to 60 minutes.')).toBeNull()
    expect(saveWake()!.disabled).toBe(false)
    fireEvent.click(saveWake()!)
    expect(await screen.findByText('Monitoring will stay parked')).toBeTruthy()
    expect(puts().at(-1)?.body).toEqual({ resources: { monitoringWakeIntervalMinutes: null } })
    await waitFor(() => expect(saveWake()!.disabled).toBe(true))

    fireEvent.click(wakeMode()!)
    expect(wakeInterval()!.value).toBe('61')
    expect(saveWake()!.disabled).toBe(true)
    fireEvent.click(wakeMode()!)
    expect(saveWake()!.disabled).toBe(true)
  })

  it('shows auto-resume on by default and saves the opt-out', async () => {
    serve()
    renderResources()
    const select = await screen.findByRole('switch', { name: 'Auto-resume after a usage limit' })
    // The shipped default (spec 2026-08-03-auto-resume-after-usage-limit) — a user who never
    // opens this pane still gets their limited tasks finished.
    expect(select.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(select)
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ resources: { autoResumeOnUsageLimit: false } })
    expect(await screen.findByText('Tasks stopped by a usage limit will stay failed')).toBeTruthy()
    await waitFor(() => expect(select.getAttribute('aria-checked')).toBe('false'))
  })

  it('saves the auto-resume opt-in from an explicit off value', async () => {
    serve({ autoResumeOnUsageLimit: false })
    renderResources()
    const toggle = await screen.findByRole('switch', { name: 'Auto-resume after a usage limit' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)

    expect(await screen.findByText('Tasks stopped by a usage limit will resume themselves')).toBeTruthy()
    expect(puts().at(-1)?.body).toEqual({ resources: { autoResumeOnUsageLimit: true } })
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
  })

  it('disables resource controls during a save and applies the returned config', async () => {
    const state = serve({ monitoringWakeIntervalMinutes: 10, memoryLimitMb: 1024 })
    renderResources()
    await waitFor(() => expect(wakeInterval()).not.toBeNull())
    fireEvent.change(wakeInterval()!, { target: { value: '20' } })
    fireEvent.change(memoryInput()!, { target: { value: '2048' } })
    let resolveSave!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { resolveSave = resolve })
    vi.mocked(fetch).mockReturnValueOnce(pending)
    fireEvent.change(parallelSelect()!, { target: { value: '6' } })

    const controls = document.querySelector('[data-slot="resources-section"]')!
      .querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button')
    await waitFor(() => expect(Array.from(controls).every((control) => control.disabled)).toBe(true))
    await act(async () => resolveSave(new Response(JSON.stringify({
      ...state,
      resources: { ...state.resources, maxParallel: 6 },
    }), { headers: { 'content-type': 'application/json' } })))

    await waitFor(() => expect(parallelSelect()!.disabled).toBe(false))
    expect(parallelSelect()!.value).toBe('6')
    expect(saveWake()!.disabled).toBe(false)
    expect(saveMemory()!.disabled).toBe(false)
  })

  it('shows a failed save as a danger toast and keeps the saved config', async () => {
    serve({ maxParallel: 2 })
    renderResources()
    await waitFor(() => expect(parallelSelect()).not.toBeNull())
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Cannot save resource settings' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }))
    fireEvent.change(parallelSelect()!, { target: { value: '6' } })

    const message = await screen.findByText('Cannot save resource settings')
    expect(message.closest('[role="status"]')?.getAttribute('data-tone')).toBe('danger')
    await waitFor(() => expect(parallelSelect()!.disabled).toBe(false))
    expect(parallelSelect()!.value).toBe('2')
  })

  it('saves a memory limit, and an empty field clears it back to "no limit"', async () => {
    serve({ memoryLimitMb: null })
    renderResources()
    await waitFor(() => expect(memoryInput()).not.toBeNull())
    expect(memoryInput()!.value).toBe('')
    expect(saveMemory()!.disabled).toBe(true)

    fireEvent.change(memoryInput()!, { target: { value: '2048' } })
    fireEvent.click(saveMemory()!)
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ resources: { memoryLimitMb: 2048 } })
    expect(await screen.findByText('Memory limit set to 2048 MiB')).toBeTruthy()
    await waitFor(() => expect(saveMemory()!.disabled).toBe(true))

    fireEvent.change(memoryInput()!, { target: { value: '' } })
    fireEvent.click(saveMemory()!)
    await waitFor(() => expect(puts()).toHaveLength(2))
    expect(puts()[1]?.body).toEqual({ resources: { memoryLimitMb: null } })
    expect(await screen.findByText('Memory limit cleared')).toBeTruthy()
    await waitFor(() => expect(saveMemory()!.disabled).toBe(true))
  })

  it('accepts the minimum memory limit and keeps an unchanged limit saved', async () => {
    serve({ memoryLimitMb: 1024 })
    renderResources()
    await waitFor(() => expect(memoryInput()).not.toBeNull())
    expect(saveMemory()!.disabled).toBe(true)

    fireEvent.change(memoryInput()!, { target: { value: '256' } })
    expect(saveMemory()!.disabled).toBe(false)
    expect(document.querySelector('[data-slot="resources-memory-invalid"]')).toBeNull()
    fireEvent.click(saveMemory()!)
    expect(await screen.findByText('Memory limit set to 256 MiB')).toBeTruthy()
    expect(puts().at(-1)?.body).toEqual({ resources: { memoryLimitMb: 256 } })
    await waitFor(() => expect(saveMemory()!.disabled).toBe(true))
  })

  it('rejects a memory limit below the floor — Save stays disabled and nothing is PUT', async () => {
    serve()
    renderResources()
    await waitFor(() => expect(memoryInput()).not.toBeNull())

    for (const bad of ['12', '1024.5', '-1']) {
      fireEvent.change(memoryInput()!, { target: { value: bad } })
      expect(saveMemory()!.disabled).toBe(true)
      expect(document.querySelector('[data-slot="resources-memory-invalid"]')).not.toBeNull()
    }
    expect(puts()).toHaveLength(0)
  })

  it('worktree retention is NOT here — it stayed with the project', async () => {
    serve()
    renderResources()
    await waitFor(() => expect(parallelSelect()).not.toBeNull())
    expect(document.querySelector('[data-slot="resources-worktree-retention"]')).toBeNull()
    expect(screen.queryByText('Keep last N worktrees')).toBeNull()
  })

  it('renders and saves New task On/Off/Inherit policy', async () => {
    serve()
    renderResources()
    const autonomous = await screen.findByLabelText('Autonomous by default')
    const worktree = screen.getByLabelText('Use a worktree by default')
    expect((autonomous as HTMLSelectElement).value).toBe('inherit')
    expect(screen.getByText(/Source-dependent — skills on, workflows off/)).toBeTruthy()

    fireEvent.change(autonomous, { target: { value: 'off' } })
    await waitFor(() => expect(puts().at(-1)?.body).toEqual({
      composerDefaults: { autonomous: false },
    }))
    fireEvent.change(worktree, { target: { value: 'on' } })
    await waitFor(() => expect(puts().at(-1)?.body).toEqual({
      composerDefaults: { worktree: true },
    }))
  })

  it.each([true, false])('renders explicit task defaults and inherited %s captions', async (value) => {
    const state = serve()
    state.composerDefaults = {
      autonomous: value,
      worktree: value,
      inheritedAutonomous: value,
      inheritedWorktree: value,
    }
    renderResources()

    const autonomous = await screen.findByLabelText('Autonomous by default')
    const worktree = screen.getByLabelText('Use a worktree by default')
    expect((autonomous as HTMLSelectElement).value).toBe(value ? 'on' : 'off')
    expect((worktree as HTMLSelectElement).value).toBe(value ? 'on' : 'off')
    expect(within(autonomous.closest('label')!).getByText(`Inherited: ${value ? 'On' : 'Off'}`)).toBeTruthy()
    expect(within(worktree.closest('label')!).getByText(`Inherited: ${value ? 'On' : 'Off'}`)).toBeTruthy()
  })

  it.each(['Autonomous by default', 'Use a worktree by default'])('saves on, off and inherit for %s', async (label) => {
    serve()
    renderResources()
    const select = await screen.findByLabelText<HTMLSelectElement>(label)
    const key = label === 'Autonomous by default' ? 'autonomous' : 'worktree'

    for (const [option, value] of [['on', true], ['off', false], ['inherit', null]] as const) {
      fireEvent.change(select, { target: { value: option } })
      await waitFor(() => expect(puts().at(-1)?.body).toEqual({ composerDefaults: { [key]: value } }))
      await waitFor(() => expect(select.disabled).toBe(false))
      expect(select.value).toBe(option)
    }
    expect(puts()).toHaveLength(3)
  })
})
