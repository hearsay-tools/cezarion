import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it } from 'vitest'

import { ProjectScopeContext } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import { useHandToAgentState } from './use-hand-to-agent-state'

afterEach(() => { cleanup(); localStorage.clear() })

it('shares live selections and queued links within a project, retaining separate project sessions', () => {
  const client = createQueryClient()
  client.setQueryData(queryKeys.workflows, { workflows: [], issues: [] })
  client.setQueryData(queryKeys.skills, [])
  client.setQueryData(queryKeys.uiState, {})
  const wrapper = (projectId: string) => ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ProjectScopeContext.Provider value={{ projectId, apiBase: `/api/v1/p/${projectId}` }}>
        {children}
      </ProjectScopeContext.Provider>
    </QueryClientProvider>
  )
  const first = renderHook(useHandToAgentState, { wrapper: wrapper('first') })
  const second = renderHook(useHandToAgentState, { wrapper: wrapper('second') })
  const sameProject = renderHook(useHandToAgentState, { wrapper: wrapper('first') })
  const engine = { runner: 'codex' as const, model: 'model-a', effort: null, account: 'work' }
  act(() => {
    first.result.current.setSelectedSkills(['review'])
    first.result.current.setEngine(engine)
    first.result.current.onQueued('https://github.com/o/r/issues/7', 'new-run')
  })
  expect(sameProject.result.current.selectedSkills).toEqual(['review'])
  expect(sameProject.result.current.engine).toEqual(engine)
  expect(sameProject.result.current.queued.get('https://github.com/o/r/issues/7')).toBe('new-run')
  expect(second.result.current.selectedSkills).toEqual([])
  expect(second.result.current.engine.runner).toBeNull()
  expect(second.result.current.queued.size).toBe(0)
  first.unmount()
  sameProject.unmount()
  const restored = renderHook(useHandToAgentState, { wrapper: wrapper('first') })
  expect(restored.result.current.engine).toEqual(engine)
  expect(restored.result.current.selectedSkills).toEqual(['review'])
})
