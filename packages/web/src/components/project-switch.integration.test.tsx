import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router'
import { act, waitFor } from '@testing-library/react'
import * as React from 'react'
import { useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as client from '@/api/client'
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

vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  getProjectRun: vi.fn(),
}))

const entry = (id: string) => ({
  id,
  name: id,
  root: `/work/${id}`,
  addedAt: '2026-07-29T10:00:00.000Z',
  lastOpenedAt: '2026-07-29T10:00:00.000Z',
  source: 'local' as const,
  status: 'ok' as const,
})
const REGISTRY: ProjectsResponse = { bootProject: 'boot', projectsDir: '/work', projects: [entry('boot'), entry('other'), entry('third')] }

function Rail() {
  const projectSwitch = useProjectSwitch()
  return (
    <ProjectRail
      projects={REGISTRY.projects}
      signals={new Map()}
      version="1"
      singleProject={false}
      projectTarget={projectSwitch.target}
      onSwitchProject={(id) => void projectSwitch.go(id)}
    />
  )
}

function Controls() {
  const navigate = useNavigate()
  const location = useLocation()
  const [palette, setPalette] = React.useState(true)
  return (
    <>
      <button onClick={() => navigate('/p/boot/git?view=repo#top')}>go git</button>
      <button onClick={() => navigate('/p/boot/skills?q=1')}>explicit</button>
      <button onClick={() => navigate(-1)}>back</button>
      <button onClick={() => setPalette(false)}>unmount palette</button>
      {palette ? <PaletteLike /> : null}
      <output data-testid="at">{location.pathname + location.search}</output>
    </>
  )
}

/** A second control with its own hook instance, like the palette's rows. */
function PaletteLike() {
  const projectSwitch = useProjectSwitch()
  return (
    <>
      <button onClick={() => void projectSwitch.go('other')}>palette other</button>
      <button onClick={() => void projectSwitch.go('third')}>palette third</button>
    </>
  )
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

describe('switch intent', () => {
  type Deferred = { resolve: () => void; reject: (error: unknown) => void }
  const pending = new Map<string, Deferred>()
  const at = () => screen.getByTestId('at').textContent
  const remember = (id: string, pathname: string) => ({ projectId: id, pathname })

  beforeEach(() => {
    pending.clear()
    vi.mocked(client.getProjectRun).mockImplementation(
      (_project, id) =>
        new Promise((resolve, reject) => {
          pending.set(id, { resolve: () => resolve({} as never), reject })
        }),
    )
    localStorage.setItem(
      PROJECT_LOCATIONS_STORAGE_KEY,
      JSON.stringify({
        other: remember('other', '/p/other/tasks/b'),
        third: remember('third', '/p/third/tasks/c'),
      }),
    )
  })

  const settle = (id: string) => act(async () => void pending.get(id)?.resolve())

  it('the expanded rail verifies a stale entity too', async () => {
    localStorage.setItem('cez-project-rail-expanded', '1')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 })
    mount('/p/boot/skills')
    expect(document.querySelector('[data-slot="project-rail"]')?.getAttribute('data-expanded')).toBe('true')

    fireEvent.click(document.querySelector('[data-slot="rail-project"][data-project-id="other"] a') as HTMLElement)
    await waitFor(() => expect(client.getProjectRun).toHaveBeenCalledWith('other', 'b', expect.anything()))
    expect(at()).toBe('/p/boot/skills')
    vi.mocked(client.getProjectRun).mockClear()
    pending.get('b')?.reject(new client.ApiError(404, 'gone'))
    await waitFor(() => expect(at()).toBe('/p/other/'))
  })

  it('the newest click wins across controls whatever order the answers arrive in', async () => {
    mount('/p/boot/skills')
    fireEvent.click(document.querySelector('[data-slot="rail-project"][data-project-id="other"] a') as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'palette third' }))
    await waitFor(() => expect(pending.size).toBe(2))

    await settle('c')
    await waitFor(() => expect(at()).toBe('/p/third/tasks/c'))
    await settle('b')
    expect(at()).toBe('/p/third/tasks/c')
  })

  it('a later query-only navigation cancels a pending switch', async () => {
    mount('/p/boot/skills')
    fireEvent.click(screen.getByRole('button', { name: 'palette other' }))
    await waitFor(() => expect(pending.has('b')).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'explicit' }))
    await settle('b')
    expect(at()).toBe('/p/boot/skills?q=1')
  })

  it('going away and back to the same history entry still cancels a pending switch', async () => {
    mount('/p/boot/git')
    fireEvent.click(screen.getByRole('button', { name: 'palette other' }))
    await waitFor(() => expect(pending.has('b')).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'explicit' }))
    fireEvent.click(screen.getByRole('button', { name: 'back' }))
    await waitFor(() => expect(at()).toBe('/p/boot/git'))
    await settle('b')
    expect(at()).toBe('/p/boot/git')
  })

  it('a pending switch outlives the palette that started it, unless the user navigates', async () => {
    mount('/p/boot/skills')
    fireEvent.click(screen.getByRole('button', { name: 'palette other' }))
    await waitFor(() => expect(pending.has('b')).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'unmount palette' }))
    await settle('b')
    await waitFor(() => expect(at()).toBe('/p/other/tasks/b'))

    cleanup()
    mount('/p/boot/skills')
    fireEvent.click(screen.getByRole('button', { name: 'palette third' }))
    await waitFor(() => expect(pending.has('c')).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'unmount palette' }))
    fireEvent.click(screen.getByRole('button', { name: 'explicit' }))
    await settle('c')
    expect(at()).toBe('/p/boot/skills?q=1')
  })
})
