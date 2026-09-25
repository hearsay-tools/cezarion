import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { ListViewProvider } from '@/components/list-view'
import { AppRoutes } from '@/routes'

/**
 * Project settings → General (project-general.tsx): the dashboard the settings index became.
 *
 * What it must answer about the project you are inside — where it is, what state its folder is
 * in, how many of its tasks may run at once — and the action that used to exist only as a row in
 * the GLOBAL registry table: Remove. The removal path is the one worth pinning hardest, because
 * it deregisters the project whose URL the page is rendered at.
 */

const ROOT = '/Users/me/code/demo-project'
const BOOT_ROOT = '/Users/me/code/cezar'

let requests: Array<{ method: string; url: string; body?: unknown }> = []
/** When set, `GET /api/v1/projects` answers it and a webhook PATCH updates it — the refetch the
 *  registry mutation awaits on settle would otherwise never answer. */
let liveRegistry: ProjectListEntry[] | null = null

function serve() {
  requests = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
      requests.push({ method, url, body })
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.endsWith('/open-targets')) return json({ targets: [] })
      if (url.startsWith('/api/v1/projects/') && method === 'DELETE') {
        return json({ removed: true, id: url.split('/').pop() })
      }
      if (url.endsWith('/webhook/test') && method === 'POST') return json({ ok: true, status: 204 })
      if (liveRegistry && url === '/api/v1/projects' && method === 'GET') {
        return json({ projects: liveRegistry, bootProject: 'boot', projectsDir: '~/cezar/projects' })
      }
      if (liveRegistry && url.startsWith('/api/v1/projects/') && method === 'PATCH') {
        const webhook = (body as { webhook: { url: string; token?: string } | null }).webhook
        const current = liveRegistry.find((entry) => entry.id === 'demo')!
        const { webhook: previous, ...rest } = current
        const tokenSet = webhook ? (webhook.token === undefined ? previous?.tokenSet ?? false : webhook.token !== '') : false
        const next: ProjectListEntry = { ...rest, ...(webhook ? { webhook: { url: webhook.url, tokenSet } } : {}) }
        liveRegistry = liveRegistry.map((entry) => (entry.id === 'demo' ? next : entry))
        return json({ project: next })
      }
      if (url.startsWith('/api/v1/projects/') && method === 'PATCH') {
        return json({ project: { ...project('demo'), maxParallel: 3 } })
      }
      return new Promise<never>(() => {})
    }),
  )
}

function project(id: 'boot' | 'demo') {
  return id === 'boot'
    ? {
        id: 'boot',
        name: 'cezar',
        root: BOOT_ROOT,
        addedAt: '2026-01-05T10:00:00.000Z',
        lastOpenedAt: '2026-07-31T10:00:00.000Z',
        source: 'local' as const,
        status: 'ok' as const,
        branch: 'main',
      }
    : {
        id: 'demo',
        name: 'demo-project',
        root: ROOT,
        addedAt: '2026-07-20T10:00:00.000Z',
        lastOpenedAt: '2026-08-01T10:00:00.000Z',
        source: 'checkout' as const,
        status: 'ok' as const,
        branch: 'feature/x',
      }
}

/** Seeds everything the page reads: the route gates, the registry, and the workspace cap the
 *  concurrency select names in its "Inherit workspace (N)" option.
 *
 *  `singleProject` flips the capability the registry half of the page is gated on, and
 *  `registry` overrides the seeded entries — a folder that has gone missing, or a workspace
 *  holding only the boot project. */
function seededClient({
  singleProject = false,
  registry,
}: { singleProject?: boolean; registry?: ProjectListEntry[] } = {}) {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, {
    bootProject: 'boot',
    capabilities: { localHandoff: true, followups: true, singleProject },
  })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: registry ?? [project('boot'), project('demo')],
    bootProject: 'boot',
    projectsDir: '~/cezar/projects',
  })
  client.setQueryData(workspaceQueryKeys.config, {
    browseRoot: '~/',
    projectsDir: '~/cezar/projects',
    skillsAutoUpdate: null,
    effectiveSkillsAutoUpdate: true,
    composerDefaults: {
      autonomous: null,
      worktree: null,
      inheritedAutonomous: 'source-dependent',
      inheritedWorktree: true,
    },
    resources: {
      maxParallel: 4,
      maxMonitoringSessions: 2,
      monitoringWakeIntervalMinutes: null,
      memoryLimitMb: null,
      worktreeRetentionDefault: 10,
    },
  })
  return client
}

function renderAt(entry: string, seed?: Parameters<typeof seededClient>[0]) {
  render(
    <QueryClientProvider client={seededClient(seed)}>
      {/* The app shell normally provides it; the removal test navigates onto the tasks overview,
          which reads it. */}
      <ListViewProvider>
        <MemoryRouter initialEntries={[entry]}>
          <AppRoutes />
        </MemoryRouter>
      </ListViewProvider>
    </QueryClientProvider>,
  )
}

const general = () => document.querySelector('[data-slot="project-general"]')

beforeEach(() => serve())

afterEach(() => {
  liveRegistry = null
  cleanup()
  vi.unstubAllGlobals()
})

describe('the General page', () => {
  it('reads out the registry entry for the project you are inside', async () => {
    renderAt('/p/demo/settings')
    const facts = await waitFor(() => {
      const el = document.querySelector('[data-slot="project-facts"]')
      expect(el).not.toBeNull()
      return el!
    })
    const text = facts.textContent ?? ''
    expect(text).toContain('demo-project')
    expect(text).toContain('feature/x')
    // Source is stated in the reader's words, not the wire's enum.
    expect(text).toContain('cloned from GitHub')
    expect(facts.querySelector('[data-slot="project-general-status"]')?.textContent).toContain('ok')
    // The folder itself, in full.
    expect(general()?.querySelector('[data-slot="project-location-path"]')?.textContent).toBe(ROOT)
  })

  it('carries the per-project concurrency ceiling, named against the workspace cap', async () => {
    renderAt('/p/demo/settings')
    const select = await screen.findByLabelText('Max parallel tasks for demo-project')
    expect(select.textContent).toContain('Inherit workspace (4)')

    fireEvent.change(select, { target: { value: '3' } })

    await waitFor(() => {
      const patch = requests.find((r) => r.method === 'PATCH')
      expect(patch?.url).toBe('/api/v1/projects/demo')
      expect(patch?.body).toEqual({ maxParallel: 3 })
    })
  })

  it('saves the task webhook URL and token, then sends a test (#589)', async () => {
    liveRegistry = [project('boot'), project('demo')]
    renderAt('/p/demo/settings', { registry: liveRegistry })
    const url = await screen.findByLabelText('URL')
    fireEvent.change(url, { target: { value: 'https://bot.example/hooks/cez' } })
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'secret-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const patch = requests.find((r) => r.method === 'PATCH')
      expect(patch?.body).toEqual({ webhook: { url: 'https://bot.example/hooks/cez', token: 'secret-token' } })
    })
    // The token field empties once saved: it is write-only, and says so instead of echoing it.
    await waitFor(() => expect((screen.getByLabelText('Token') as HTMLInputElement).value).toBe(''))
    expect(screen.getByLabelText('Token').getAttribute('placeholder')).toContain('Token set')

    fireEvent.click(screen.getByRole('button', { name: 'Send test' }))
    await waitFor(() => expect(requests.some((r) => r.method === 'POST' && r.url === '/api/v1/projects/demo/webhook/test')).toBe(true))
    expect((await screen.findByRole('status')).textContent).toContain('Delivered (HTTP 204)')
  })

  it('keeps the stored token when only the URL changes, and removes the webhook', async () => {
    liveRegistry = [project('boot'), { ...project('demo'), webhook: { url: 'https://bot.example/a', tokenSet: true } }]
    renderAt('/p/demo/settings', { registry: liveRegistry })
    const url = await screen.findByLabelText('URL')
    expect((url as HTMLInputElement).value).toBe('https://bot.example/a')
    fireEvent.change(url, { target: { value: 'https://bot.example/b' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({ webhook: { url: 'https://bot.example/b' } })
    })
    const remove = screen.getByRole('button', { name: 'Remove' })
    await waitFor(() => expect(remove.hasAttribute('disabled')).toBe(false))
    fireEvent.click(remove)
    await waitFor(() => {
      expect(requests.filter((r) => r.method === 'PATCH').at(-1)?.body).toEqual({ webhook: null })
    })
  })

  it('removes the project after a confirm, then leaves the URL that just stopped resolving', async () => {
    renderAt('/p/demo/settings')
    const remove = await screen.findByRole('button', { name: /^Remove demo-project from the workspace/ })

    fireEvent.click(remove)

    // The confirm insists on what Remove does NOT do, and names the folder it will not delete.
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('nothing on disk is deleted')
    expect(dialog.textContent).toContain(ROOT)

    fireEvent.click(screen.getByRole('button', { name: 'Remove from list' }))

    await waitFor(() => {
      expect(requests.some((r) => r.method === 'DELETE' && r.url === '/api/v1/projects/demo')).toBe(true)
    })
    // Straight to the boot project — staying would render a settings page for a project the
    // registry no longer has.
    await waitFor(() => {
      expect(document.querySelector('[data-route="settings"]')).toBeNull()
    })
  })

  it('refuses to remove the boot project before the click, with the reason', async () => {
    renderAt('/p/boot/settings')
    const remove = await screen.findByRole('button', { name: /^Remove cezar from the workspace/ })
    expect(remove.hasAttribute('disabled')).toBe(true)
    expect(document.querySelector('[data-slot="project-general-remove-boot"]')?.textContent).toContain(
      're-registers itself',
    )
  })

  it('is the project area only — global settings has no project to describe', async () => {
    renderAt('/settings/global')
    await waitFor(() => {
      expect(document.querySelector('[data-slot="settings-index"]')).not.toBeNull()
    })
    expect(general()).toBeNull()
  })

  it('names a folder that is gone, and says what to do about it', async () => {
    renderAt('/p/demo/settings', {
      registry: [project('boot'), { ...project('demo'), status: 'missing' }],
    })
    const status = await waitFor(() => {
      const el = document.querySelector('[data-slot="project-general-status"]')
      expect(el).not.toBeNull()
      return el!
    })
    expect(status.textContent).toContain('folder not found')
    // "folder not found" alone does not say what to do about it; the hint points at the Remove
    // field rendered directly below.
    expect(status.textContent).toContain('remove it below')
  })

  it('single-project mode keeps what describes the project and drops what manages the registry', async () => {
    // `CEZ_SINGLE_PROJECT=1` makes PATCH and DELETE `/api/v1/projects/:id` answer 409 (server.ts)
    // and drops the whole global Projects section from the nav registry. Offering the same two
    // controls here would be a knob whose every change is refused; what the project IS stays true.
    renderAt('/settings', { singleProject: true, registry: [project('boot')] })
    await waitFor(() => {
      expect(general()).not.toBeNull()
    })
    expect(document.querySelector('[data-slot="project-facts"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="project-location-path"]')?.textContent).toBe(BOOT_ROOT)
    expect(screen.queryByLabelText('Max parallel tasks for cezar')).toBeNull()
    expect(document.querySelector('[data-action="project-general-remove"]')).toBeNull()
  })

  it('sends a missing folder to the path when there is no Remove button to point at', async () => {
    // The other half of the gate: single-project mode took the Remove field away, so the hint
    // must not send the reader "below" to a control that is not rendered.
    renderAt('/settings', {
      singleProject: true,
      registry: [{ ...project('boot'), status: 'missing' }],
    })
    const status = await waitFor(() => {
      const el = document.querySelector('[data-slot="project-general-status"]')
      expect(el).not.toBeNull()
      return el!
    })
    expect(status.textContent).toContain('folder not found')
    expect(status.textContent).toContain('restore the folder at the path above')
    expect(status.textContent).not.toContain('remove it below')
  })
})
