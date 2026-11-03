import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONTROL_LOCATIONS } from '@open-mercato/cezar-api-client/contract/control-locations'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { NAV_ITEMS } from '@/components/nav-items'
import { AppRoutes } from '@/routes'
import { SettingsSidebar } from './settings-sidebar'
import { visibleSettingsSections } from './registry'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function settingsClient() {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { bootProject: 'boot', capabilities: { settingsAdmin: true } })
  client.setQueryData(workspaceQueryKeys.projects, {
    bootProject: 'boot', projectsDir: '~/projects',
    projects: [{ id: 'boot', name: 'Demo', root: '/demo', addedAt: '2026-01-01T00:00:00Z', source: 'local', status: 'ok' }],
  })
  client.setQueryData(workspaceQueryKeys.config, { resources: { maxParallel: 4 } })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const data = url.endsWith('/config')
      ? { baseBranch: null, defaultRunner: 'claude', systemPrompt: null, defaultModels: {}, maxParallel: 2 }
      : url.endsWith('/providers/status') ? { providers: [] }
        : url.includes('/models?') ? { models: [], source: 'unavailable', stale: false }
          : url.endsWith('/agent-profiles') ? { profiles: [] }
            : {}
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
  }))
  return client
}

describe('control locations match the rendered settings navigation', () => {
  it.each(Object.entries(CONTROL_LOCATIONS))('%s', async (_control, path) => {
    expect(NAV_ITEMS.find(({ to }) => to === '/settings')?.label).toBe(path[0])
    const sidebar = render(
      <MemoryRouter><SettingsSidebar projectId="boot" projectName="Demo" /></MemoryRouter>,
    )
    // General is a real sidebar row outside the section registry.
    const link = within(sidebar.container).getByRole('link', { name: path[1] })
    const href = link.getAttribute('href')
    expect(href).toBeTruthy()
    const sections = [...visibleSettingsSections('project'), ...visibleSettingsSections('global')]
    if (link.getAttribute('data-section') !== 'general') {
      expect(sections.some(({ title }) => title === path[1])).toBe(true)
    }
    sidebar.unmount()
    if (path.length < 3) return

    render(
      <QueryClientProvider client={settingsClient()}>
        <MemoryRouter initialEntries={[href!]}><AppRoutes /></MemoryRouter>
      </QueryClientProvider>,
    )
    // Query the section the real route renders, never a copied list of subsection labels.
    for (const label of path.slice(2)) {
      expect(await screen.findByRole('heading', { name: label })).toBeTruthy()
    }
  })
})
