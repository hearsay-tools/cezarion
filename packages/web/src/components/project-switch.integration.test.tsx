import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'
import type { ProjectsResponse } from '@open-mercato/cezar-api-client'
import { LastLocationController } from '@/components/last-location-controller'
import { ProjectRail } from '@/components/project-rail'
import { ThemeProvider } from '@/components/theme-provider'
import { useProjectSwitch } from '@/components/use-project-switch'
import { PROJECT_LOCATIONS_STORAGE_KEY } from '@/lib/last-location'

/**
 * The real controller + the real rail + the real resolver, in one router: the seams the unit
 * tests mock. Storage is written one effect AFTER the render that shows a page, so a link built
 * from storage alone would lag the page you are standing on.
 */

const entry = (id: string) => ({
  id,
  name: id,
  root: `/work/${id}`,
  addedAt: '2026-07-29T10:00:00.000Z',
  lastOpenedAt: '2026-07-29T10:00:00.000Z',
  source: 'local' as const,
  status: 'ok' as const,
})
const REGISTRY: ProjectsResponse = { bootProject: 'boot', projectsDir: '/work', projects: [entry('boot'), entry('other')] }

function Rail() {
  const projectSwitch = useProjectSwitch()
  return (
    <ProjectRail
      projects={REGISTRY.projects}
      signals={new Map()}
      truncated={new Set()}
      version="1"
      singleProject={false}
      projectTarget={projectSwitch.target}
      onSwitchProject={(id) => void projectSwitch.go(id)}
    />
  )
}

function Controls() {
  const navigate = useNavigate()
  return <button onClick={() => navigate('/p/boot/git?view=repo#top')}>go git</button>
}

function mount(path: string) {
  const client = createQueryClient()
  client.setQueryData(workspaceQueryKeys.projects, REGISTRY)
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <LastLocationController />
          <Rail />
          <Controls />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

const href = (id: string) =>
  document.querySelector(`[data-slot="rail-project"][data-project-id="${id}"] a`)?.getAttribute('href')

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
  vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('rail + controller', () => {
  it('points the current project\'s mark at the page just navigated to, not the one before it', () => {
    mount('/p/boot/skills')
    expect(href('boot')).toBe('/p/boot/skills')

    fireEvent.click(screen.getByRole('button', { name: 'go git' }))

    expect(href('boot')).toBe('/p/boot/git?view=repo#top')
  })

  it('links an inactive project to its remembered page, fresh after A-B-A', () => {
    mount('/p/other/inbox')
    fireEvent.click(screen.getByRole('button', { name: 'go git' }))
    expect(href('other')).toBe('/p/other/inbox')
  })

  it.each(['/p/other/tasks/%', '/p/other/tasks/%E0%A4%A'])(
    'renders an explicit URL normally when the OTHER project remembered a malformed path (%s)',
    (bad) => {
      localStorage.setItem(
        PROJECT_LOCATIONS_STORAGE_KEY,
        JSON.stringify({ other: { projectId: 'other', pathname: bad } }),
      )
      expect(() => mount('/p/boot/skills')).not.toThrow()
      expect(href('other')).toBe('/p/other/')
      expect(href('boot')).toBe('/p/boot/skills')
    },
  )
})
