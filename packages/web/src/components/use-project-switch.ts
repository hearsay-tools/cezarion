import * as React from 'react'
import { useLocation, useNavigate } from 'react-router'

import { useHealth, useProjects } from '@/api/queries'
import { readStoredProjectLocation } from '@/lib/last-location'
import { pathnameProjectId } from '@/lib/project-router'
import {
  projectSwitchTarget,
  resolveProjectSwitch,
  type ProjectSwitchTarget,
} from '@/lib/project-switch'

/**
 * The one behind every "switch to project X" control (the rail, expanded and collapsed, and the
 * ⌘K Projects group): X's remembered page, or X's home.
 *
 * `target` is synchronous and feeds a link's `href`. `go` is the click: it confirms an entity
 * page still exists before landing on it, and drops its navigation if the user went somewhere
 * else (or switched again) while the answer was in flight.
 */
export function useProjectSwitch(): {
  target: (projectId: string) => ProjectSwitchTarget
  go: (projectId: string) => Promise<void>
} {
  const registry = useProjects().data
  const capabilities = useHealth().data?.capabilities
  const navigate = useNavigate()
  const { pathname, search, hash } = useLocation()
  const here = React.useRef(pathname)
  here.current = pathname
  const latest = React.useRef(0)
  const currentProjectId = pathnameProjectId(pathname)
  const currentHref = `${pathname}${search}${hash}`

  // The page you are on IS the current project's latest page. Storage lags it by one effect
  // (the controller files a page after the render that shows it), so the current mark and a
  // new-tab click on it read the location, never the store.
  const target = React.useCallback(
    (projectId: string): ProjectSwitchTarget =>
      projectId === currentProjectId
        ? { href: currentHref, verify: false }
        : projectSwitchTarget(projectId, readStoredProjectLocation(projectId), { registry, capabilities }),
    [registry, capabilities, currentProjectId, currentHref],
  )
  const go = React.useCallback(
    async (projectId: string) => {
      if (projectId === currentProjectId) return
      const ticket = ++latest.current
      const from = here.current
      const to = await resolveProjectSwitch(projectId, readStoredProjectLocation(projectId), { registry, capabilities })
      if (ticket === latest.current && here.current === from) navigate(to)
    },
    [registry, capabilities, navigate, currentProjectId],
  )
  return { target, go }
}
