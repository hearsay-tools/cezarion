import type { Capabilities, ProjectsResponse } from '@open-mercato/cezar-api-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  getProjectRun: vi.fn(),
  getGroup: vi.fn(),
  getRepoCommit: vi.fn(),
  getRunCommit: vi.fn(),
  getGithubItem: vi.fn(),
  getWorkflows: vi.fn(),
  getAutomations: vi.fn(),
}))

import * as client from '@/api/client'
import { visibleSettingsSections } from '@/routes/settings/registry'
import { projectSwitchTarget, resolveProjectSwitch } from './project-switch'

const registry = {
  bootProject: 'boot',
  projectsDir: '/work',
  projects: ['boot', 'other'].map((id) => ({
    id,
    name: id,
    root: `/work/${id}`,
    addedAt: '2026-07-29T10:00:00.000Z',
    lastOpenedAt: '2026-07-29T10:00:00.000Z',
    source: 'local',
    status: 'ok',
  })),
} as ProjectsResponse
const capabilities = undefined as Capabilities | undefined
const ctx = { registry, capabilities }
const saved = (pathname: string, extra: object = {}) => ({ projectId: 'other', pathname, ...extra })
const apiError = (status: number, message = `HTTP ${status}`) => new client.ApiError(status, message)

beforeEach(() => vi.resetAllMocks())

describe('projectSwitchTarget', () => {
  it('lands on the home with no memory', () => {
    expect(projectSwitchTarget('other', null, ctx)).toEqual({ href: '/p/other/', verify: false })
  })

  it.each([
    '/p/other/git/branches',
    '/p/other/git/',
    '/p/other/Git',
    '/p/other/new',
    '/p/other/inbox',
    '/p/other/skills',
    '/p/other/workflows',
    '/p/other/automations/new',
  ])('restores the routed list page %s with query and hash', (pathname) => {
    expect(projectSwitchTarget('other', saved(pathname, { search: '?q=x', hash: '#h' }), ctx)).toEqual({
      href: `${pathname}?q=x#h`,
      verify: false,
    })
  })

  it.each([
    '/p/other/tasks/run-1',
    '/p/other/tasks/run-1/',
    '/p/other/Tasks/run-1/changes',
    '/p/other/tasks/run-1/commits/abc',
    '/p/other/compare/g1',
    '/p/other/git/commits/abc',
    '/p/other/github/issues/4',
    '/p/other/github/prs/9/changes',
    '/p/other/workflows/deploy',
    '/p/other/automations/a1/log',
  ])('restores entity page %s but marks it for verification', (pathname) => {
    expect(projectSwitchTarget('other', saved(pathname, { search: '?x=1' }), ctx)).toEqual({
      href: `${pathname}?x=1`,
      verify: true,
    })
  })

  it('sends unrouted pages and unknown settings sections home', () => {
    for (const pathname of ['/p/other/no-such-page', '/p/other/tasks', '/p/other/settings/nonexistent']) {
      expect(projectSwitchTarget('other', saved(pathname), ctx).href).toBe('/p/other/')
    }
  })

  it('follows the settings sections the capabilities make visible', () => {
    const section = visibleSettingsSections('project', capabilities)[0]
    expect(projectSwitchTarget('other', saved(`/p/other/settings/${section?.id}`), ctx).href).toBe(
      `/p/other/settings/${section?.id}`,
    )
  })

  it('hides the sections a single-project server hides', () => {
    const single = { registry, capabilities: { singleProject: true } as Capabilities }
    expect(projectSwitchTarget('other', saved('/p/other/settings/projects'), ctx).href).toBe('/p/other/settings/projects')
    expect(projectSwitchTarget('other', saved('/p/other/settings/projects'), single).href).toBe('/p/other/')
  })

  it('never throws on a malformed percent escape', () => {
    for (const bad of ['/p/other/tasks/%', '/p/other/tasks/%E0%A4%A', '/p/other/git/commits/%zz']) {
      expect(() => projectSwitchTarget('other', saved(bad), ctx)).not.toThrow()
      expect(projectSwitchTarget('other', saved(bad), ctx)).toEqual({ href: '/p/other/', verify: false })
    }
  })
})

describe('resolveProjectSwitch', () => {
  const resolve = (pathname: string, extra: object = {}) =>
    resolveProjectSwitch('other', saved(pathname, extra), ctx)

  it('restores a task page that exists, with its query and hash', async () => {
    vi.mocked(client.getProjectRun).mockResolvedValue({} as never)
    await expect(resolve('/p/other/tasks/run-1/changes', { search: '?file=a', hash: '#L2' })).resolves.toBe(
      '/p/other/tasks/run-1/changes?file=a#L2',
    )
    expect(client.getProjectRun).toHaveBeenCalledWith('other', 'run-1', expect.anything())
  })

  it('goes home only for a CONFIRMED missing entity (404)', async () => {
    vi.mocked(client.getProjectRun).mockRejectedValue(apiError(404))
    await expect(resolve('/p/other/tasks/gone')).resolves.toBe('/p/other/')
  })

  it.each([[500], [0], [403]])('does not infer deletion from an inconclusive answer (%i)', async (status) => {
    vi.mocked(client.getProjectRun).mockRejectedValue(apiError(status))
    await expect(resolve('/p/other/tasks/run-1')).resolves.toBe('/p/other/tasks/run-1')
  })

  it('checks the entity in the TARGET project, not the active one', async () => {
    vi.mocked(client.getRepoCommit).mockResolvedValue({} as never)
    await resolve('/p/other/git/commits/abc')
    expect(client.getRepoCommit).toHaveBeenCalledWith('abc', expect.objectContaining({ projectId: 'other' }))
  })

  it('treats the commit route\'s 409 as gone only when git says the object is absent', async () => {
    vi.mocked(client.getRepoCommit).mockRejectedValue(
      apiError(409, "fatal: ambiguous argument 'abc^{commit}': unknown revision or path not in the working tree."),
    )
    await expect(resolve('/p/other/git/commits/abc')).resolves.toBe('/p/other/')
    vi.mocked(client.getRepoCommit).mockRejectedValue(apiError(409, 'not a commit hash: zz'))
    await expect(resolve('/p/other/git/commits/zz')).resolves.toBe('/p/other/')
    vi.mocked(client.getRepoCommit).mockRejectedValue(apiError(409, 'not a git repository'))
    await expect(resolve('/p/other/git/commits/abc')).resolves.toBe('/p/other/git/commits/abc')
    vi.mocked(client.getRepoCommit).mockRejectedValue(apiError(0, 'offline'))
    await expect(resolve('/p/other/git/commits/abc')).resolves.toBe('/p/other/git/commits/abc')
    // A 409 on any other route is not evidence of absence.
    vi.mocked(client.getProjectRun).mockRejectedValue(apiError(409, 'unknown revision'))
    await expect(resolve('/p/other/tasks/run-1')).resolves.toBe('/p/other/tasks/run-1')
  })

  it('checks a task\'s child commit and issue/PR, not just the run', async () => {
    vi.mocked(client.getProjectRun).mockResolvedValue({} as never)
    vi.mocked(client.getRunCommit).mockRejectedValue(apiError(409, 'fatal: bad object deadbeef'))
    await expect(resolve('/p/other/tasks/run-1/commits/deadbeef')).resolves.toBe('/p/other/')
    expect(client.getRunCommit).toHaveBeenCalledWith('run-1', 'deadbeef', expect.objectContaining({ projectId: 'other' }))
    vi.mocked(client.getRunCommit).mockRejectedValue(apiError(409, 'task has no worktree'))
    await expect(resolve('/p/other/tasks/run-1/commits/abcd')).resolves.toBe('/p/other/tasks/run-1/commits/abcd')
    vi.mocked(client.getRunCommit).mockResolvedValue({} as never)
    await expect(resolve('/p/other/tasks/run-1/commits/abcd')).resolves.toBe('/p/other/tasks/run-1/commits/abcd')

    vi.mocked(client.getGithubItem).mockResolvedValue({ available: true, item: null } as never)
    await expect(resolve('/p/other/tasks/run-1/pr/7')).resolves.toBe('/p/other/')
    vi.mocked(client.getGithubItem).mockResolvedValue({ available: false, reason: 'no gh' } as never)
    await expect(resolve('/p/other/tasks/run-1/issue/7')).resolves.toBe('/p/other/tasks/run-1/issue/7')
  })

  it('keeps a workflow page when the catalog reported unreadable files', async () => {
    vi.mocked(client.getWorkflows).mockResolvedValue({
      workflows: [],
      issues: [{ path: '.ai/cezar/workflows/deploy.yaml', message: 'EACCES' }],
    } as never)
    await expect(resolve('/p/other/workflows/deploy')).resolves.toBe('/p/other/workflows/deploy')
  })

  it('verifies compare, commit, workflow, automation and forge pages', async () => {
    vi.mocked(client.getGroup).mockRejectedValue(apiError(404))
    await expect(resolve('/p/other/compare/g1')).resolves.toBe('/p/other/')

    vi.mocked(client.getRepoCommit).mockRejectedValue(apiError(404))
    await expect(resolve('/p/other/git/commits/abc')).resolves.toBe('/p/other/')

    vi.mocked(client.getWorkflows).mockResolvedValue({ workflows: [{ name: 'deploy' }], issues: [] } as never)
    await expect(resolve('/p/other/workflows/deploy')).resolves.toBe('/p/other/workflows/deploy')
    await expect(resolve('/p/other/workflows/old')).resolves.toBe('/p/other/')

    vi.mocked(client.getAutomations).mockResolvedValue({ available: true, automations: [{ id: 'a1' }] } as never)
    await expect(resolve('/p/other/automations/a1/log')).resolves.toBe('/p/other/automations/a1/log')
    await expect(resolve('/p/other/automations/a2')).resolves.toBe('/p/other/')
    vi.mocked(client.getAutomations).mockResolvedValue({ available: false, automations: [] } as never)
    await expect(resolve('/p/other/automations/a2')).resolves.toBe('/p/other/automations/a2')

    vi.mocked(client.getGithubItem).mockResolvedValue({ available: true, item: null } as never)
    await expect(resolve('/p/other/github/issues/4')).resolves.toBe('/p/other/')
    vi.mocked(client.getGithubItem).mockResolvedValue({ available: false, reason: 'no gh' } as never)
    await expect(resolve('/p/other/github/prs/9')).resolves.toBe('/p/other/github/prs/9')
    await expect(resolve('/p/other/github/prs/0')).resolves.toBe('/p/other/')
  })

  it('does no network work for list pages or the home', async () => {
    await expect(resolve('/p/other/git')).resolves.toBe('/p/other/git')
    await expect(resolveProjectSwitch('other', null, ctx)).resolves.toBe('/p/other/')
    expect(client.getProjectRun).not.toHaveBeenCalled()
  })
})
