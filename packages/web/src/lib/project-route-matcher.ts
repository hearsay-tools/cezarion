import * as React from 'react'

/** A project page the router really serves: its project-relative pattern (`/tasks/:id/changes`)
 *  and the decoded params. Null for the catch-all (not found) and for anything unrouted.
 *  `matchProjectRoute` in `routes.tsx` is the one implementation; it is injected, not imported, so
 *  the project switch does not load the whole route tree. */
export type ProjectRouteMatcher = (
  pathname: string,
) => { pattern: string; params: Record<string, string | undefined> } | null

/** The app's route matcher. `App` provides the real `matchProjectRoute`; there is no default,
 *  because a switch without the route table cannot tell a page from a 404. */
export const ProjectRouteMatcherContext = React.createContext<ProjectRouteMatcher | null>(null)
