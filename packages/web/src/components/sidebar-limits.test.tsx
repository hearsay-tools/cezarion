import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { setApiScope, type ProjectListEntry, type RunRecord, type SidebarLimits } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { ListViewProvider } from './list-view'
import { ProjectGroups } from './project-groups'
import { TaskQuickListContainer } from './task-quick-list'

const project: ProjectListEntry = { id: 'boot', name: 'Boot', root: '/boot', addedAt: '2026-07-01T00:00:00Z', lastOpenedAt: '2026-07-01T00:00:00Z', source: 'local', status: 'ok' }
const runs: RunRecord[] = ['waiting', 'done', 'running'].flatMap((status, section) => Array.from({ length: 4 }, (_, index) => {
  const number = section * 10 + index + 1
  return { id: `r${number}`, title: `Row ${number}`, workflow: 'default', task: 'task', status: status as RunRecord['status'], createdAt: '2026-07-14T10:00:00Z', tokensUsed: 0, archived: false, steps: [], referencedIssueUrl: `https://github.com/o/r/issues/${number}` }
}))
afterEach(() => { cleanup(); localStorage.clear(); setApiScope(null); vi.unstubAllGlobals() })
it.each([['desktop', true], ['mobile', true], ['desktop', false], ['mobile', false]] as const)('%s uses the same scoped combined limits for rows and reference requests (boot alias: %s)', async (surface, boot) => {
  const projectId = boot ? 'boot' : 'shop'
  const cacheScope = boot ? 'default' : projectId
  // The shell sits above the selected project provider: ambient scope must be ignored.
  setApiScope('other')
  const client = createQueryClient()
  client.setQueryData([cacheScope, 'ui-state'], { sidebarLimits: { overall: 3, needsYou: 1, finished: 1, working: 1 } })
  const requested: string[] = []
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = String(input).replace('?archived=recent', ''); requested.push(url)
    const body = url.endsWith('/run-summaries') ? runs : url.endsWith('/health') ? { bootProject: 'boot' } : url.includes('/ref-status') ? { available: true, prs: {}, issues: {}, conflicts: [], recheckAfterMs: null } : {}
    return new Response(JSON.stringify(body), { status: 200 })
  }))
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/p/${projectId}/`]}><ListViewProvider>
    {surface === 'desktop' ? <ProjectGroups projects={[{ ...project, id: projectId }]} bootProjectId="boot" /> : <TaskQuickListContainer projectId={projectId} boot={boot} />}
  </ListViewProvider></MemoryRouter></QueryClientProvider>)
  const visible = () => Array.from(document.querySelectorAll('[data-slot="task-row"]')).map(el => el.getAttribute('data-run-id'))
  await waitFor(() => expect(visible()).toEqual(['r1', 'r11', 'r21']))
  await waitFor(() => expect(requested.some(url => url.includes('/ref-status'))).toBe(true))
  const numbers = () => [...new Set(requested.filter(url => url.includes('/ref-status')).flatMap(url => new URL(url, 'http://localhost').searchParams.get('issues')?.split(',') ?? []))].sort()
  expect(numbers()).toEqual(['1', '11', '21'])
  expect(requested.some(url => url.includes('/p/other/ui-state'))).toBe(false)
  // A save through the boot/default cache updates every shell consumer immediately.
  client.setQueryData([cacheScope, 'ui-state'], { sidebarLimits: { overall: null, needsYou: 1, finished: 1, working: 2 } satisfies SidebarLimits })
  await waitFor(() => expect(visible()).toEqual(['r1', 'r11', 'r21', 'r22']))
  await waitFor(() => expect(numbers()).toEqual(['1', '11', '21', '22']))
})

it.each((['desktop', 'mobile'] as const).flatMap(surface => [null, [], 3, 'bad', { overall: -1, needsYou: 1, finished: 0, working: 1.5 }].map(sidebarLimits => ({ surface, sidebarLimits }))))('$surface normalizes $sidebarLimits for both rendering and reference requests', async ({ surface, sidebarLimits }) => {
  const client = createQueryClient()
  client.setQueryData(['default', 'ui-state'], { sidebarLimits })
  const requested: string[] = []
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = String(input).replace('?archived=recent', ''); requested.push(url)
    return new Response(JSON.stringify(url.endsWith('/run-summaries') ? runs : url.includes('/ref-status') ? { available: true, prs: {}, issues: {}, conflicts: [], recheckAfterMs: null } : {}))
  }))
  render(<QueryClientProvider client={client}><MemoryRouter><ListViewProvider>
    {surface === 'desktop' ? <ProjectGroups projects={[project]} bootProjectId="boot" /> : <TaskQuickListContainer projectId="boot" boot />}
  </ListViewProvider></MemoryRouter></QueryClientProvider>)
  const expected = sidebarLimits && typeof sidebarLimits === 'object' && !Array.isArray(sidebarLimits)
    ? ['r1', 'r11', 'r12', 'r13', 'r14', 'r21', 'r22', 'r23', 'r24']
    : ['r1', 'r2', 'r3', 'r4', 'r11', 'r12', 'r13', 'r14', 'r21', 'r22']
  await waitFor(() => expect(Array.from(document.querySelectorAll('[data-slot="task-row"]')).map(el => el.getAttribute('data-run-id'))).toEqual(expected))
  await waitFor(() => expect(requested.some(url => url.includes('/ref-status'))).toBe(true))
  expect([...new Set(requested.filter(url => url.includes('/ref-status')).flatMap(url => new URL(url, 'http://localhost').searchParams.get('issues')?.split(',') ?? []))].sort()).toEqual(expected.map(id => id.slice(1)).sort())
})
