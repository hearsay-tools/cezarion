import { describe, expect, it } from 'vitest'

import { shellRoute } from './app-shell-route'

type Row = {
  pathname: string
  search?: string | undefined
  keyboardOpen?: boolean
  activeTo: string | null
  label: string | null
  projectId: string | null
  newTask?: boolean
  pushed?: boolean
  showTabBar: boolean
  gitRepositoryView?: boolean
}

const rows: Row[] = [
  { pathname: '/', activeTo: '/', label: 'Tasks', projectId: null, showTabBar: true },
  { pathname: '/p/cezarion/', activeTo: '/', label: 'Tasks', projectId: 'cezarion', showTabBar: true },
  { pathname: '/p/cezarion/', keyboardOpen: true, activeTo: '/', label: 'Tasks', projectId: 'cezarion', showTabBar: false },
  { pathname: '/p/cezarion/tasks', activeTo: '/', label: 'Tasks', projectId: 'cezarion', showTabBar: true },
  // `/new` lights the New task button, not a nav item, so the routed label is absent.
  { pathname: '/new', activeTo: '/new', label: null, projectId: null, newTask: true, showTabBar: true },
  { pathname: '/p/cezarion/new', activeTo: '/new', label: null, projectId: 'cezarion', newTask: true, showTabBar: true },
  { pathname: '/p/cezarion/new', keyboardOpen: true, activeTo: '/new', label: null, projectId: 'cezarion', newTask: true, showTabBar: false },
  { pathname: '/p/cezarion/tasks/abc', activeTo: '/', label: 'Tasks', projectId: 'cezarion', pushed: true, showTabBar: false },
  { pathname: '/tasks/abc/files', activeTo: '/', label: 'Tasks', projectId: null, pushed: true, showTabBar: false },
  { pathname: '/p/cezarion/git', activeTo: '/git', label: 'Git', projectId: 'cezarion', showTabBar: true },
  { pathname: '/p/cezarion/git', search: '?view=other', activeTo: '/git', label: 'Git', projectId: 'cezarion', showTabBar: true },
  { pathname: '/p/cezarion/git', search: '?view=repo', activeTo: '/git', label: 'Git', projectId: 'cezarion', showTabBar: false, gitRepositoryView: true },
  { pathname: '/git', search: '?view=repo', activeTo: '/git', label: 'Git', projectId: null, showTabBar: false, gitRepositoryView: true },
  { pathname: '/git/branches', activeTo: '/git', label: 'Git', projectId: null, showTabBar: false },
  { pathname: '/p/cezarion/github/issues/3', activeTo: '/github', label: 'GitHub', projectId: 'cezarion', showTabBar: true },
  { pathname: '/p/my%20project/skills', activeTo: '/skills', label: 'Skills', projectId: 'my project', showTabBar: true },
  { pathname: '/tools', activeTo: null, label: null, projectId: null, showTabBar: true },
]

describe('shellRoute', () => {
  it.each(rows)('$pathname$search (keyboard open: $keyboardOpen)', (row) => {
    const route = shellRoute(row.pathname, row.search ?? '', row.keyboardOpen ?? false)
    expect({
      activeTo: route.activeTo,
      label: route.current?.label ?? null,
      projectId: route.currentProjectId,
      newTask: route.newTask,
      pushed: route.pushed,
      showTabBar: route.showTabBar,
      gitRepositoryView: route.gitRepositoryView,
    }).toEqual({
      activeTo: row.activeTo,
      label: row.label,
      projectId: row.projectId,
      newTask: row.newTask ?? false,
      pushed: row.pushed ?? false,
      showTabBar: row.showTabBar,
      gitRepositoryView: row.gitRepositoryView ?? false,
    })
  })
})
