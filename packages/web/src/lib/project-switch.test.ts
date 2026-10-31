import { runAddress } from '@/api/run-address'
import type { Capabilities, ProjectsResponse } from '@open-mercato/cezar-api-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  getRun: vi.fn(),
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
    vi.mocked(client.getRun).mockResolvedValue({} as never)
    await expect(resolve('/p/other/tasks/run-1/changes', { search: '?file=a', hash: '#L2' })).resolves.toBe(
      '/p/other/tasks/run-1/changes?file=a#L2',
    )
    expect(client.getRun).toHaveBeenCalledWith(runAddress('run-1', { projectId: 'other' }), expect.anything())
  })

  it('goes home only for a CONFIRMED missing entity (404)', async () => {
    vi.mocked(client.getRun).mockRejectedValue(apiError(404))
    await expect(resolve('/p/other/tasks/gone')).resolves.toBe('/p/other/')
  })

  it.each([[500], [0], [403]])('does not infer deletion from an inconclusive answer (%i)', async (status) => {
    vi.mocked(client.getRun).mockRejectedValue(apiError(status))
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
    vi.mocked(client.getRun).mockRejectedValue(apiError(409, 'unknown revision'))
    await expect(resolve('/p/other/tasks/run-1')).resolves.toBe('/p/other/tasks/run-1')
  })

  it('checks a task\'s child commit and issue/PR, not just the run', async () => {
    vi.mocked(client.getRun).mockResolvedValue({ prNumber: 7, issueNumber: 7 } as never)
    const withRepo = (pathname: string) =>
      resolveProjectSwitch('other', saved(pathname), { ...ctx, repoBaseOf: () => 'https://github.com/acme/widgets' })
    vi.mocked(client.getRunCommit).mockRejectedValue(apiError(409, 'fatal: bad object deadbeef'))
    await expect(resolve('/p/other/tasks/run-1/commits/deadbeef')).resolves.toBe('/p/other/')
    expect(client.getRunCommit).toHaveBeenCalledWith('run-1', 'deadbeef', expect.objectContaining({ projectId: 'other' }))
    vi.mocked(client.getRunCommit).mockRejectedValue(apiError(409, 'task has no worktree'))
    await expect(resolve('/p/other/tasks/run-1/commits/abcd')).resolves.toBe('/p/other/tasks/run-1/commits/abcd')
    vi.mocked(client.getRunCommit).mockResolvedValue({} as never)
    await expect(resolve('/p/other/tasks/run-1/commits/abcd')).resolves.toBe('/p/other/tasks/run-1/commits/abcd')

    vi.mocked(client.getGithubItem).mockResolvedValue({ available: true, item: null } as never)
    await expect(withRepo('/p/other/tasks/run-1/pr/7')).resolves.toBe('/p/other/')
    vi.mocked(client.getGithubItem).mockResolvedValue({ available: false, reason: 'no gh' } as never)
    await expect(withRepo('/p/other/tasks/run-1/issue/7')).resolves.toBe('/p/other/tasks/run-1/issue/7')
  })

  it('keeps a workflow page when the catalog reported unreadable files', async () => {
    vi.mocked(client.getWorkflows).mockResolvedValue({
      workflows: [],
      issues: [{ path: '.ai/cezar/workflows/deploy.yaml', message: 'EACCES' }],
    } as never)
    await expect(resolve('/p/other/workflows/deploy')).resolves.toBe('/p/other/workflows/deploy')
  })

  it('verifies commit, workflow, automation and forge pages', async () => {
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
    expect(client.getRun).not.toHaveBeenCalled()
  })
})

/** The existence answer per entity kind, as a table (hearsay-tools/cezarion#1775). The exported
 *  API shows only `false` (the project home) against everything else (the saved page), so a row
 *  says which of the two a click lands on and which requests were made. */
describe('resolveProjectSwitch: the answer for each entity kind', () => {
  const HOME = '/p/other/'
  const REPO = 'https://github.com/acme/widgets'
  const withRepo = (pathname: string) =>
    resolveProjectSwitch('other', saved(pathname), { ...ctx, repoBaseOf: () => REPO })
  const landing = async (pathname: string, resolver: (pathname: string) => Promise<string> = (to) => resolveProjectSwitch('other', saved(to), ctx)) => {
    const to = await resolver(pathname)
    return to === HOME ? 'home' : to === pathname ? 'kept' : to
  }
  const signalOf = expect.objectContaining({ signal: expect.any(AbortSignal) })
  const targetOf = expect.objectContaining({ projectId: 'other', signal: expect.any(AbortSignal) })

  /** Failures that every existence request maps the same way: only a 404 proves absence. */
  const FAILURES: [label: string, error: Error, landing: 'home' | 'kept'][] = [
    ['404', apiError(404), 'home'],
    ['500', apiError(500), 'kept'],
    ['403', apiError(403), 'kept'],
    ['a dead connection', apiError(0, 'offline'), 'kept'],
    ['a 409 off the commit routes', apiError(409, 'fatal: bad object deadbeef'), 'kept'],
  ]
  /** Segments the item routes refuse before any item request: not a positive safe integer. */
  const BAD_NUMBERS = ['0', '-1', '1.5', 'x', '99999999999999999999']

  describe.each([
    '/p/other/tasks/run-1',
    '/p/other/tasks/run-1/changes',
    '/p/other/tasks/run-1/files',
    '/p/other/tasks/run-1/commits',
  ])('task page %s', (pathname) => {
    it('is kept while the run exists, and asks for nothing else', async () => {
      vi.mocked(client.getRun).mockResolvedValue({} as never)
      expect(await landing(pathname)).toBe('kept')
      expect(client.getRun).toHaveBeenCalledWith(runAddress('run-1', { projectId: 'other' }), signalOf)
      expect(client.getRunCommit).not.toHaveBeenCalled()
      expect(client.getGithubItem).not.toHaveBeenCalled()
    })

    it.each(FAILURES)('answers a run lookup that fails with %s', async (_label, error, expected) => {
      vi.mocked(client.getRun).mockRejectedValue(error)
      expect(await landing(pathname)).toBe(expected)
    })
  })

  describe('task commit /tasks/:id/commits/:sha', () => {
    const pathname = '/p/other/tasks/run-1/commits/abc'

    it('asks for the run, then for the commit, in the target project', async () => {
      vi.mocked(client.getRun).mockResolvedValue({} as never)
      vi.mocked(client.getRunCommit).mockResolvedValue({} as never)
      expect(await landing(pathname)).toBe('kept')
      expect(client.getRunCommit).toHaveBeenCalledWith('run-1', 'abc', targetOf)
      expect(vi.mocked(client.getRun).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(client.getRunCommit).mock.invocationCallOrder[0] ?? 0,
      )
    })

    it.each([
      ['404', apiError(404), 'home'],
      ['500', apiError(500), 'kept'],
      ['a dead connection', apiError(0, 'offline'), 'kept'],
    ] as [string, Error, 'home' | 'kept'][])('never asks for the commit when the run lookup fails with %s', async (_label, error, expected) => {
      vi.mocked(client.getRun).mockRejectedValue(error)
      expect(await landing(pathname)).toBe(expected)
      expect(client.getRunCommit).not.toHaveBeenCalled()
    })

    it.each([
      ['404', apiError(404), 'home'],
      ['500', apiError(500), 'kept'],
      ['403', apiError(403), 'kept'],
      ['a dead connection', apiError(0, 'offline'), 'kept'],
    ] as [string, Error, 'home' | 'kept'][])('answers a commit lookup that fails with %s', async (_label, error, expected) => {
      vi.mocked(client.getRun).mockResolvedValue({} as never)
      vi.mocked(client.getRunCommit).mockRejectedValue(error)
      expect(await landing(pathname)).toBe(expected)
    })
  })

  describe.each(['issue', 'pr'] as const)('task %s page', (kind) => {
    const pathname = `/p/other/tasks/run-1/${kind}/7`
    const otherKind = kind === 'issue' ? { prNumber: 7 } : { issueNumber: 7 }

    beforeEach(() => {
      vi.mocked(client.getRun).mockResolvedValue((kind === 'issue' ? { issueNumber: 7 } : { prNumber: 7 }) as never)
    })

    it('keeps an item the task links and the forge has', async () => {
      vi.mocked(client.getGithubItem).mockResolvedValue({ available: true, item: { number: 7 } } as never)
      expect(await landing(pathname, withRepo)).toBe('kept')
      expect(client.getGithubItem).toHaveBeenCalledWith(kind, 7, {}, targetOf)
    })

    it('goes home when the forge has no such item', async () => {
      vi.mocked(client.getGithubItem).mockResolvedValue({ available: true, item: null } as never)
      expect(await landing(pathname, withRepo)).toBe('home')
    })

    it('keeps the page while the forge is unavailable', async () => {
      vi.mocked(client.getGithubItem).mockResolvedValue({ available: false, reason: 'no gh' } as never)
      expect(await landing(pathname, withRepo)).toBe('kept')
    })

    it.each(FAILURES)('answers an item request that fails with %s', async (_label, error, expected) => {
      vi.mocked(client.getGithubItem).mockRejectedValue(error)
      expect(await landing(pathname, withRepo)).toBe(expected)
    })

    it.each([
      ['404', apiError(404), 'home'],
      ['500', apiError(500), 'kept'],
    ] as [string, Error, 'home' | 'kept'][])('never asks for the item when the run lookup fails with %s', async (_label, error, expected) => {
      vi.mocked(client.getRun).mockRejectedValue(error)
      expect(await landing(pathname, withRepo)).toBe(expected)
      expect(client.getGithubItem).not.toHaveBeenCalled()
    })

    it.each(BAD_NUMBERS)('goes home for the number %s, after the run lookup and with no item request', async (bad) => {
      expect(await landing(`/p/other/tasks/run-1/${kind}/${bad}`, withRepo)).toBe('home')
      expect(client.getRun).toHaveBeenCalledTimes(1)
      expect(client.getGithubItem).not.toHaveBeenCalled()
    })

    it('goes home for a number the task does not link, when the repository is known', async () => {
      expect(await landing(`/p/other/tasks/run-1/${kind}/8`, withRepo)).toBe('home')
      expect(client.getGithubItem).not.toHaveBeenCalled()
    })

    it('goes home for a number the task links as the other kind', async () => {
      vi.mocked(client.getRun).mockResolvedValue(otherKind as never)
      expect(await landing(pathname, withRepo)).toBe('home')
      expect(client.getGithubItem).not.toHaveBeenCalled()
    })

    it('keeps an unlinked number when the repository is unknown', async () => {
      expect(await landing(`/p/other/tasks/run-1/${kind}/8`)).toBe('kept')
      expect(client.getGithubItem).not.toHaveBeenCalled()
    })
  })

  describe('repository commit /git/commits/:sha', () => {
    const pathname = '/p/other/git/commits/abc'

    it('keeps a commit the repository has', async () => {
      vi.mocked(client.getRepoCommit).mockResolvedValue({} as never)
      expect(await landing(pathname)).toBe('kept')
      expect(client.getRepoCommit).toHaveBeenCalledWith('abc', targetOf)
    })

    it.each([
      ['404', apiError(404), 'home'],
      ['500', apiError(500), 'kept'],
      ['403', apiError(403), 'kept'],
      ['a dead connection', apiError(0, 'offline'), 'kept'],
    ] as [string, Error, 'home' | 'kept'][])('answers a lookup that fails with %s', async (_label, error, expected) => {
      vi.mocked(client.getRepoCommit).mockRejectedValue(error)
      expect(await landing(pathname)).toBe(expected)
    })
  })

  describe.each([
    ['/p/other/github/issues/4', 'issue', 4],
    ['/p/other/github/prs/9', 'pr', 9],
    ['/p/other/github/prs/9/changes', 'pr', 9],
  ] as [string, 'issue' | 'pr', number][])('GitHub item %s', (pathname, kind, number) => {
    it('keeps an item the forge has', async () => {
      vi.mocked(client.getGithubItem).mockResolvedValue({ available: true, item: { number } } as never)
      expect(await landing(pathname)).toBe('kept')
      expect(client.getGithubItem).toHaveBeenCalledWith(kind, number, {}, targetOf)
    })

    it('goes home when the forge has no such item', async () => {
      vi.mocked(client.getGithubItem).mockResolvedValue({ available: true, item: null } as never)
      expect(await landing(pathname)).toBe('home')
    })

    it('keeps the page while the forge is unavailable', async () => {
      vi.mocked(client.getGithubItem).mockResolvedValue({ available: false, reason: 'no gh' } as never)
      expect(await landing(pathname)).toBe('kept')
    })

    it.each(FAILURES)('answers an item request that fails with %s', async (_label, error, expected) => {
      vi.mocked(client.getGithubItem).mockRejectedValue(error)
      expect(await landing(pathname)).toBe(expected)
    })

    it.each(BAD_NUMBERS)('goes home for the number %s with no request', async (bad) => {
      expect(await landing(pathname.replace(`/${number}`, `/${bad}`))).toBe('home')
      expect(client.getGithubItem).not.toHaveBeenCalled()
    })
  })

  describe('workflow /workflows/:name', () => {
    const pathname = '/p/other/workflows/deploy'

    it('keeps a listed workflow even when the catalog reports unreadable files', async () => {
      vi.mocked(client.getWorkflows).mockResolvedValue({
        workflows: [{ name: 'deploy' }],
        issues: [{ path: '.ai/cezar/workflows/other.yaml', message: 'EACCES' }],
      } as never)
      expect(await landing(pathname)).toBe('kept')
      expect(client.getWorkflows).toHaveBeenCalledWith(targetOf)
    })

    it.each(FAILURES)('answers a catalog request that fails with %s', async (_label, error, expected) => {
      vi.mocked(client.getWorkflows).mockRejectedValue(error)
      expect(await landing(pathname)).toBe(expected)
    })
  })

  describe.each(['/p/other/automations/a1', '/p/other/automations/a1/log'])('automation %s', (pathname) => {
    it('keeps a listed automation', async () => {
      vi.mocked(client.getAutomations).mockResolvedValue({ available: true, automations: [{ id: 'a1' }] } as never)
      expect(await landing(pathname)).toBe('kept')
      expect(client.getAutomations).toHaveBeenCalledWith(targetOf)
    })

    it('goes home when the list lacks it', async () => {
      vi.mocked(client.getAutomations).mockResolvedValue({ available: true, automations: [{ id: 'a2' }] } as never)
      expect(await landing(pathname)).toBe('home')
    })

    it('keeps the page while automations are unavailable', async () => {
      vi.mocked(client.getAutomations).mockResolvedValue({ available: false, automations: [] } as never)
      expect(await landing(pathname)).toBe('kept')
    })

    it.each(FAILURES)('answers a list request that fails with %s', async (_label, error, expected) => {
      vi.mocked(client.getAutomations).mockRejectedValue(error)
      expect(await landing(pathname)).toBe(expected)
    })
  })

  it('keeps a routed page that no existence check covers, with no request', async () => {
    // `/compare/:groupId` is the retired page's redirect: it has a param, so it is verified, and
    // nothing in the checker table claims it.
    expect(await landing('/p/other/compare/g1')).toBe('kept')
    for (const request of [client.getRun, client.getRunCommit, client.getRepoCommit, client.getGithubItem, client.getWorkflows, client.getAutomations]) {
      expect(request).not.toHaveBeenCalled()
    }
  })

  describe('the abort signal', () => {
    const requestSignals = () => [
      ...vi.mocked(client.getRun).mock.calls.map(([, opts]) => opts?.signal),
      ...vi.mocked(client.getRunCommit).mock.calls.map(([, , opts]) => opts?.signal),
      ...vi.mocked(client.getRepoCommit).mock.calls.map(([, opts]) => opts?.signal),
      ...vi.mocked(client.getGithubItem).mock.calls.map(([, , , opts]) => opts?.signal),
      ...vi.mocked(client.getWorkflows).mock.calls.map(([opts]) => opts?.signal),
      ...vi.mocked(client.getAutomations).mock.calls.map(([opts]) => opts?.signal),
    ]

    it.each([
      ['/p/other/tasks/run-1', 1],
      ['/p/other/tasks/run-1/commits/abc', 2],
      ['/p/other/tasks/run-1/issue/7', 2],
      ['/p/other/tasks/run-1/pr/7', 2],
      ['/p/other/git/commits/abc', 1],
      ['/p/other/github/issues/4', 1],
      ['/p/other/github/prs/9', 1],
      ['/p/other/workflows/deploy', 1],
      ['/p/other/automations/a1', 1],
    ] as [string, number][])('reaches every request for %s', async (pathname, requests) => {
      vi.mocked(client.getRun).mockResolvedValue({ prNumber: 7, issueNumber: 7 } as never)
      vi.mocked(client.getRunCommit).mockResolvedValue({} as never)
      vi.mocked(client.getRepoCommit).mockResolvedValue({} as never)
      vi.mocked(client.getGithubItem).mockResolvedValue({ available: true, item: { number: 1 } } as never)
      vi.mocked(client.getWorkflows).mockResolvedValue({ workflows: [{ name: 'deploy' }], issues: [] } as never)
      vi.mocked(client.getAutomations).mockResolvedValue({ available: true, automations: [{ id: 'a1' }] } as never)
      expect(await landing(pathname, withRepo)).toBe('kept')
      const signals = requestSignals()
      expect(signals).toHaveLength(requests)
      expect(signals[0]).toBeInstanceOf(AbortSignal)
      for (const signal of signals) expect(signal).toBe(signals[0])
    })

    it('aborts the pending request at the check timeout and keeps the page', async () => {
      // Fake timers: the 2 500 ms check timeout is moved past, never waited for.
      vi.useFakeTimers()
      try {
        vi.mocked(client.getRun).mockResolvedValue({} as never)
        vi.mocked(client.getRunCommit).mockImplementation(
          (_id, _sha, opts) =>
            new Promise((_resolve, reject) => {
              const abort = () => reject(new DOMException('aborted', 'AbortError'))
              if (opts?.signal?.aborted) abort()
              else opts?.signal?.addEventListener('abort', abort)
            }),
        )
        const pending = landing('/p/other/tasks/run-1/commits/abc')
        await vi.advanceTimersByTimeAsync(2_500)
        await expect(pending).resolves.toBe('kept')
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
