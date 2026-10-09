import { cleanup, render, screen } from '@testing-library/react'
import { useContext } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ProjectScopeContext } from '@/api/project-scope-context'
import { TaskFileContext, type TaskFileContextValue } from './file-links'
import { TaskFileScope } from './task-file-scope'

// Issue #925: the project a file link is stamped with is the run's OWNER — the project whose
// route matched, the only store that can be serving the run being rendered — never the ambient
// viewer scope (`ProjectScopeContext` or the live URL). A shell above the wrong provider or a
// soft-nav transition can leave the ambient scope naming a project that does not own the run,
// and that is how a `cezar` run's links came out stamped `/p/squeal/…`.

/** Publishes the scope's assembled context — the value `taskFileHref` stamps into every link. */
function ContextProbe() {
  const context = useContext(TaskFileContext)
  return <div data-testid="context">{JSON.stringify(context)}</div>
}

afterEach(cleanup)

/** A routed `TaskFileScope` with full control over the route param and the ambient scope. */
function renderRouted(projectPathParam: string, ambientScope: string | null) {
  render(
    <MemoryRouter initialEntries={[`/p/${projectPathParam}/tasks/run-1`]}>
      <Routes>
        <Route
          path="/p/:projectId/tasks/:id"
          element={
            <ProjectScopeContext.Provider value={{ projectId: ambientScope, apiBase: `/api/p/${ambientScope}` }}>
              <TaskFileScope runId="run-1">
                <ContextProbe />
              </TaskFileScope>
            </ProjectScopeContext.Provider>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
  return () => JSON.parse(screen.getByTestId('context').textContent ?? 'null') as TaskFileContextValue | null
}

describe('TaskFileScope project ownership (#925)', () => {
  it('stamps the project whose route matched, not the ambient scope project', () => {
    // The viewer's ambient scope names squeal while the cezar-scoped route owns the render.
    const read = renderRouted('cezar', 'squeal')
    expect(read()).toEqual({ runId: 'run-1', projectId: 'cezar' })
  })

  it('stamps the boot project for its unscoped mount, where the provider reads null', () => {
    // The boot project mounts UNSCOPED (step-3.1 invariant): the provider says null while the
    // URL — and the matched route — name the boot project. #776 pinned this link shape.
    const read = renderRouted('boot', null)
    expect(read()).toEqual({ runId: 'run-1', projectId: 'boot' })
  })

  it('stamps a URL-encoded project id decoded, never the raw segment', () => {
    const read = renderRouted(encodeURIComponent('my project'), 'squeal')
    expect(read()).toEqual({ runId: 'run-1', projectId: 'my project' })
  })

  it('leaves the context unscoped when rendered outside a router', () => {
    render(
      <TaskFileScope runId="run-1">
        <ContextProbe />
      </TaskFileScope>,
    )
    expect(JSON.parse(screen.getByTestId('context').textContent ?? 'null')).toEqual({ runId: 'run-1' })
  })

  it('leaves the context unscoped on a route that names no project', () => {
    // A global surface (no `/p/:projectId` prefix) must not stamp whatever the ambient scope
    // says: an owner-less context renders flat links, which LegacyPathRedirect resolves.
    render(
      <MemoryRouter initialEntries={['/tools']}>
        <Routes>
          <Route
            path="/tools"
            element={
              <ProjectScopeContext.Provider value={{ projectId: 'squeal', apiBase: '/api/p/squeal' }}>
                <TaskFileScope runId="run-1">
                  <ContextProbe />
                </TaskFileScope>
              </ProjectScopeContext.Provider>
            }
          />
        </Routes>
      </MemoryRouter>,
    )
    expect(JSON.parse(screen.getByTestId('context').textContent ?? 'null')).toEqual({ runId: 'run-1' })
  })
})
