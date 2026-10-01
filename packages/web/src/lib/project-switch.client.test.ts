import type { ProjectsResponse } from '@open-mercato/cezar-api-client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveProjectSwitch } from './project-switch'

/** The same decisions through the REAL api client and a stubbed `fetch`, so the wire shapes and
 *  `ApiError` mapping are exercised rather than assumed. */

const registry = {
  bootProject: 'boot',
  projectsDir: '/work',
  projects: [
    { id: 'other', name: 'other', root: '/work/other', addedAt: 'x', lastOpenedAt: 'x', source: 'local', status: 'ok' },
  ],
} as ProjectsResponse
const go = (pathname: string) =>
  resolveProjectSwitch('other', { projectId: 'other', pathname }, { registry, capabilities: undefined })

function answer(routes: Record<string, { status?: number; body: unknown }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).split('?')[0] ?? ''
      const hit = routes[path]
      return new Response(JSON.stringify(hit?.body ?? { error: 'not found' }), {
        status: hit?.status ?? (hit ? 200 : 404),
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('resolveProjectSwitch through the real client', () => {
  it('keeps /workflows/deploy when the catalog reports an unreadable file', async () => {
    answer({
      '/api/v1/p/other/workflows': { body: { workflows: [], issues: [{ path: 'deploy.yaml', message: 'EACCES' }] } },
    })
    await expect(go('/p/other/workflows/deploy')).resolves.toBe('/p/other/workflows/deploy')
  })

  it('drops /workflows/deploy when a clean catalog lacks it', async () => {
    answer({ '/api/v1/p/other/workflows': { body: { workflows: [], issues: [] } } })
    await expect(go('/p/other/workflows/deploy')).resolves.toBe('/p/other/')
  })

  it('drops a task commit the run no longer has, keeps it for an unrelated 409', async () => {
    const run = { '/api/v1/p/other/runs/run-1': { body: { id: 'run-1' } } }
    answer({ ...run, '/api/v1/p/other/runs/run-1/commit/dead': { status: 409, body: { error: 'fatal: bad object dead' } } })
    await expect(go('/p/other/tasks/run-1/commits/dead')).resolves.toBe('/p/other/')
    answer({ ...run, '/api/v1/p/other/runs/run-1/commit/dead': { status: 409, body: { error: 'no worktree — this task ran directly in the repo working tree' } } })
    await expect(go('/p/other/tasks/run-1/commits/dead')).resolves.toBe('/p/other/tasks/run-1/commits/dead')
  })
})
