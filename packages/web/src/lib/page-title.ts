import { matchPath } from 'react-router'

import { stripProjectPrefix } from './project-router'

export interface PageTitleContext {
  pageLabel: string | null
  taskId: string | null
}

export const PAGE_TITLE_ROUTES = [
  { pattern: '/', pageLabel: 'Tasks' },
  // The global page. It is not project-scoped, so it never carries a `/p/` prefix to strip —
  // but it goes through the same table, because the browser title is one mechanism.
  { pattern: '/tasks', pageLabel: 'All tasks' },
  { pattern: '/tools', pageLabel: 'Workspace tools' },
  { pattern: '/new', pageLabel: 'New task' },
  // The project view and the global `/activity` share one row: the global path has no prefix.
  { pattern: '/activity', pageLabel: 'Activity' },
  { pattern: '/git/*', pageLabel: 'Git' },
  { pattern: '/github/*', pageLabel: 'GitHub' },
  { pattern: '/automations/*', pageLabel: 'Automations' },
  { pattern: '/skills', pageLabel: 'Skills' },
  { pattern: '/inbox', pageLabel: 'Inbox' },
  { pattern: '/reports', pageLabel: 'Reports' },
  { pattern: '/workflows/*', pageLabel: 'Workflows' },
  { pattern: '/settings/*', pageLabel: 'Settings' },
] as const

/** Browser-title context from the project-relative route map; raw ids are lookup keys only. */
export function pageTitleContext(pathname: string): PageTitleContext {
  const projectPath = stripProjectPrefix(pathname)
  const task = matchPath({ path: '/tasks/:id/*', end: true }, projectPath)
  if (task) return { pageLabel: null, taskId: task.params.id ?? null }

  const route = PAGE_TITLE_ROUTES.find(({ pattern }) =>
    matchPath({ path: pattern, end: true }, projectPath),
  )
  return { pageLabel: route?.pageLabel ?? null, taskId: null }
}
