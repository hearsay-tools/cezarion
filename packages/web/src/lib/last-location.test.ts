import type { ProjectsResponse, WorkspaceLastLocation } from '@open-mercato/cezar-api-client'
import { describe, expect, it, vi } from 'vitest'

import {
  PROJECT_LOCATIONS_STORAGE_KEY,
  locationToRestore,
  locationToSave,
  projectSwitchTarget,
  readStoredProjectLocation,
  sameLastLocation,
  writeStoredProjectLocation,
} from './last-location'

const REGISTRY: ProjectsResponse = {
  bootProject: 'boot',
  projectsDir: '/work',
  projects: [
    {
      id: 'boot',
      name: 'Boot',
      root: '/work/boot',
      addedAt: '2026-07-29T10:00:00.000Z',
      lastOpenedAt: '2026-07-29T10:00:00.000Z',
      source: 'local',
      status: 'ok',
    },
    {
      id: 'other',
      name: 'Other',
      root: '/work/other',
      addedAt: '2026-07-29T10:00:00.000Z',
      lastOpenedAt: '2026-07-29T10:00:00.000Z',
      source: 'local',
      status: 'not-git',
    },
    {
      id: 'gone',
      name: 'Gone',
      root: '/work/gone',
      addedAt: '2026-07-29T10:00:00.000Z',
      lastOpenedAt: '2026-07-29T10:00:00.000Z',
      source: 'local',
      status: 'missing',
    },
  ],
}

describe('locationToSave', () => {
  it('normalizes a registered project URL including query and hash', () => {
    expect(
      locationToSave(
        {
          pathname: '/p/boot/tasks/run-1/changes',
          search: '?file=src%2Findex.ts',
          hash: '#L12',
        },
        REGISTRY,
      ),
    ).toEqual({
      projectId: 'boot',
      pathname: '/p/boot/tasks/run-1/changes',
      search: '?file=src%2Findex.ts',
      hash: '#L12',
    })
  })

  it('omits empty query and hash components', () => {
    expect(locationToSave({ pathname: '/p/boot/', search: '', hash: '' }, REGISTRY)).toEqual({
      projectId: 'boot',
      pathname: '/p/boot/',
    })
  })

  it('treats a registered not-git project as usable', () => {
    expect(locationToSave({ pathname: '/p/other/git', search: '', hash: '' }, REGISTRY)).toEqual({
      projectId: 'other',
      pathname: '/p/other/git',
    })
  })

  it.each([
    ['an unscoped path', { pathname: '/tasks/run-1', search: '', hash: '' }],
    ['an unknown project', { pathname: '/p/unknown/', search: '', hash: '' }],
    ['a missing project', { pathname: '/p/gone/', search: '', hash: '' }],
    ['an overlong path', { pathname: `/p/boot/${'x'.repeat(2041)}`, search: '', hash: '' }],
    ['a malformed encoded project', { pathname: '/p/%/', search: '', hash: '' }],
  ])('rejects %s', (_case, location) => {
    expect(locationToSave(location, REGISTRY)).toBeNull()
  })

  it('waits for the project registry before saving', () => {
    expect(locationToSave({ pathname: '/p/boot/', search: '', hash: '' }, undefined)).toBeNull()
  })
})

describe('locationToRestore', () => {
  const saved: WorkspaceLastLocation = {
    projectId: 'other',
    pathname: '/p/other/tasks/run-1/changes',
    search: '?file=x',
    hash: '#L2',
  }

  it('restores a valid registered location exactly', () => {
    expect(locationToRestore(saved, REGISTRY, 'boot')).toBe('/p/other/tasks/run-1/changes?file=x#L2')
  })

  it('restores a registered not-git project', () => {
    expect(locationToRestore({ projectId: 'other', pathname: '/p/other/' }, REGISTRY, 'boot')).toBe('/p/other/')
  })

  it.each([
    ['a non-object value', 'nope'],
    ['a missing field', { projectId: 'boot' }],
    ['an extra field', { projectId: 'boot', pathname: '/p/boot/', extra: true }],
    ['an unscoped path', { projectId: 'boot', pathname: '/tasks/run-1' }],
    ['a project/path mismatch', { projectId: 'boot', pathname: '/p/other/' }],
    ['an unknown project', { projectId: 'unknown', pathname: '/p/unknown/' }],
    ['a missing project', { projectId: 'gone', pathname: '/p/gone/' }],
    ['a search without ?', { projectId: 'boot', pathname: '/p/boot/', search: 'tab=runs' }],
    ['a hash without #', { projectId: 'boot', pathname: '/p/boot/', hash: 'L2' }],
  ])('rejects %s', (_case, value) => {
    expect(locationToRestore(value, REGISTRY, 'boot')).toBeNull()
  })

  it('accepts only the health boot project while the registry is unavailable', () => {
    expect(locationToRestore({ projectId: 'boot', pathname: '/p/boot/tasks/run-1' }, undefined, 'boot')).toBe(
      '/p/boot/tasks/run-1',
    )
    expect(locationToRestore(saved, undefined, 'boot')).toBeNull()
    expect(locationToRestore({ projectId: 'boot', pathname: '/p/boot/' }, undefined, undefined)).toBeNull()
  })
})

describe('sameLastLocation', () => {
  it('treats absent and empty optional components as equal', () => {
    const left: WorkspaceLastLocation = { projectId: 'boot', pathname: '/p/boot/' }
    const right: WorkspaceLastLocation = {
      projectId: 'boot',
      pathname: '/p/boot/',
      search: '',
      hash: '',
    }

    expect(sameLastLocation(left, right)).toBe(true)
  })

  it('detects a changed project, path, query, or hash', () => {
    const current: WorkspaceLastLocation = { projectId: 'boot', pathname: '/p/boot/', search: '?tab=runs' }

    expect(sameLastLocation(current, { ...current })).toBe(true)
    expect(sameLastLocation(undefined, current)).toBe(false)
    expect(sameLastLocation(current, { ...current, projectId: 'other' })).toBe(false)
    expect(sameLastLocation(current, { ...current, pathname: '/p/boot/git' })).toBe(false)
    expect(sameLastLocation(current, { ...current, search: '?tab=git' })).toBe(false)
    expect(sameLastLocation(current, { ...current, hash: '#L2' })).toBe(false)
  })
})

describe('per-project memories', () => {
  const ctx = { registry: REGISTRY, runIds: new Set(['run-1']) }

  it('keeps one independent memory per project across a reload', () => {
    localStorage.clear()
    writeStoredProjectLocation({ projectId: 'boot', pathname: '/p/boot/git' })
    writeStoredProjectLocation({ projectId: 'other', pathname: '/p/other/skills', search: '?skill=x' })
    writeStoredProjectLocation({ projectId: 'boot', pathname: '/p/boot/inbox' })

    expect(readStoredProjectLocation('boot')).toEqual({ projectId: 'boot', pathname: '/p/boot/inbox' })
    expect(readStoredProjectLocation('other')).toEqual({
      projectId: 'other',
      pathname: '/p/other/skills',
      search: '?skill=x',
    })
    expect(readStoredProjectLocation('gone')).toBeNull()
  })

  it.each(['not json', '[]', '"x"', 'null'])('reads corrupt storage (%s) as no memory and recovers on write', (raw) => {
    localStorage.setItem(PROJECT_LOCATIONS_STORAGE_KEY, raw)
    expect(readStoredProjectLocation('boot')).toBeNull()
    writeStoredProjectLocation({ projectId: 'boot', pathname: '/p/boot/git' })
    expect(readStoredProjectLocation('boot')).toEqual({ projectId: 'boot', pathname: '/p/boot/git' })
  })

  it('survives unavailable storage', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(readStoredProjectLocation('boot')).toBeNull()
    expect(() => writeStoredProjectLocation({ projectId: 'boot', pathname: '/p/boot/git' })).not.toThrow()
    expect(projectSwitchTarget('boot', null, ctx)).toBe('/p/boot/')
    spy.mockRestore()
    vi.restoreAllMocks()
  })
})

describe('projectSwitchTarget', () => {
  const ctx = { registry: REGISTRY, runIds: new Set(['run-1']) }
  const saved = (pathname: string, extra: object = {}) => ({ projectId: 'other', pathname, ...extra })

  it('lands on the project home with no memory', () => {
    expect(projectSwitchTarget('other', null, ctx)).toBe('/p/other/')
  })

  it('restores pathname, query and hash exactly', () => {
    expect(projectSwitchTarget('other', saved('/p/other/skills', { search: '?skill=x', hash: '#top' }), ctx)).toBe(
      '/p/other/skills?skill=x#top',
    )
  })

  it('ignores a memory that belongs to another project', () => {
    expect(projectSwitchTarget('other', { projectId: 'boot', pathname: '/p/boot/git' }, ctx)).toBe('/p/other/')
    expect(projectSwitchTarget('other', { projectId: 'other', pathname: '/p/boot/git' }, ctx)).toBe('/p/other/')
  })

  it('ignores a memory for a missing or unregistered project', () => {
    expect(projectSwitchTarget('gone', { projectId: 'gone', pathname: '/p/gone/git' }, ctx)).toBe('/p/gone/')
    expect(projectSwitchTarget('nope', { projectId: 'nope', pathname: '/p/nope/git' }, ctx)).toBe('/p/nope/')
  })

  it('keeps a task page only while the run still exists', () => {
    expect(projectSwitchTarget('other', saved('/p/other/tasks/run-1/changes', { search: '?file=a' }), ctx)).toBe(
      '/p/other/tasks/run-1/changes?file=a',
    )
    expect(projectSwitchTarget('other', saved('/p/other/tasks/deleted/changes'), ctx)).toBe('/p/other/')
    // Index not loaded: cannot verify, so the safe destination.
    expect(projectSwitchTarget('other', saved('/p/other/tasks/run-1'), { registry: REGISTRY })).toBe('/p/other/')
  })

  it.each([
    ['/p/other/git/commits/abc123', '/p/other/git/commits'],
    ['/p/other/github/prs/9/changes', '/p/other/github/prs'],
    ['/p/other/github/issues/4', '/p/other/github'],
    ['/p/other/workflows/gone', '/p/other/workflows'],
    ['/p/other/automations/a1/log', '/p/other/automations'],
    ['/p/other/compare/g1', '/p/other/'],
    ['/p/other/no-such-page', '/p/other/'],
  ])('falls back from entity or unknown page %s to %s', (pathname, expected) => {
    expect(projectSwitchTarget('other', saved(pathname, { search: '?x=1', hash: '#h' }), ctx)).toBe(expected)
  })

  it.each(['/p/other/git/branches', '/p/other/settings/skills', '/p/other/new', '/p/other/inbox'])(
    'keeps list-level page %s',
    (pathname) => {
      expect(projectSwitchTarget('other', saved(pathname), ctx)).toBe(pathname)
    },
  )
})
