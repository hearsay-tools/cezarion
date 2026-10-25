import { activeNavItem, activeNavPath, isPushedGitScreen, isPushedRoute, type NavItem } from '@/components/nav-items'
import { pathnameProjectId, stripProjectPrefix } from '@/lib/project-router'

/** The app shell's route-dependent choices: which nav item is active and which mobile chrome shows. */
export type ShellRoute = {
  /** The nav path to mark as current. `/new` is its own, so the New task button lights up. */
  activeTo: string | null
  /** The nav item that owns the route; the mobile title and the breadcrumb's page come from it. */
  current: NavItem | null
  /** The URL's own scope, as on the rail: global routes carry none, so every project is "elsewhere". */
  currentProjectId: string | null
  /** The New task screen. */
  newTask: boolean
  /** The pushed task screen: its top bar carries back / title / state / run actions. */
  pushed: boolean
  /** Whether the mobile tab bar shows. */
  showTabBar: boolean
  /** Git's repository view, which shares its pathname with Git's phone index. */
  gitRepositoryView: boolean
}

/** Derive the shell's route-dependent choices from the URL and the keyboard state. Pure. */
export function shellRoute(pathname: string, search: string, keyboardOpen: boolean): ShellRoute {
  // The nav's area rules reason about the flat route map — strip any `/p/:projectId` prefix
  // (multi-project spec, step 3.2) so `/p/cezar/git/commits` still lights Git.
  const areaPathname = stripProjectPrefix(pathname)
  const newTask = areaPathname === '/new'
  const pushed = isPushedRoute(pathname)
  return {
    activeTo: newTask ? '/new' : activeNavPath(areaPathname),
    current: activeNavItem(areaPathname),
    currentProjectId: pathnameProjectId(pathname),
    newTask,
    pushed,
    // The tab bar belongs to list screens (#621): an opened task is a pushed screen whose composer
    // owns the bottom edge, and while the keyboard is up it would only eat the room the composer
    // needs. Pushed Git section screens hide it too (issue 08 §C, the slice 5 rule): each has its
    // own Back to Git.
    showTabBar: !pushed && !isPushedGitScreen(pathname, search) && !keyboardOpen,
    // Git's phone index and its repository share ONE pathname (`/git` vs `/git?view=repo`), so the
    // shell's pathname-only scroll reset misses that switch. A boolean, so unrelated search
    // changes do not reset anything.
    gitRepositoryView: areaPathname === '/git' && new URLSearchParams(search).get('view') === 'repo',
  }
}
