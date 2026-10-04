import { ChevronDownIcon, FolderIcon, MenuIcon, PlusIcon, SearchIcon, ShieldCheckIcon } from '@/components/design-icons'

import { ChevronLeftIcon } from 'lucide-react'
import * as React from 'react'
import type { ReactNode } from 'react'
import { Link as RouterLink, matchPath, useLocation } from 'react-router'

import { openCommandPalette } from '@/components/command-palette'
import { DrawerGlobal, DrawerIdentity, DrawerProjects, DrawerUpdate, MenuButtonPills, elsewhereSignal, menuButtonLabel, type DrawerTools, type MobileProjectNav } from '@/components/mobile-projects'
import { projectInitials, type ProjectSignal } from '@/lib/project-signal'
import { commandShortcutHint } from '@/lib/use-command-shortcut'
import { Link, pathnameProjectId, stripProjectPrefix, useNavigate } from '@/lib/project-router'
import { MobileRunBarSlotContext } from '@/components/mobile-run-bar'
import { StatusDot } from '@/components/status-dot'
import { SidebarViewTabs } from '@/components/sidebar-view-tabs'
import { ApplicationUpdateControl, ApplicationUpdateFeedback } from '@/components/application-update-control'
import { API_PREFIX, type ApplicationUpdateState } from '@open-mercato/cezar-api-client'
import { ProjectScopeContext, useProjectScope } from '@/api/project-scope-context'
import { isNewerVersion } from '@/lib/is-newer-version'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { activeNavItem, activeNavPath, isPushedGitScreen, isPushedRoute, visibleNavItems, type NavItem } from '@/components/nav-items'
import { MobileTabBar } from '@/components/mobile-tab-bar'
import { useKeyboardOpen } from '@/lib/keyboard-inset'
import { SIDEBAR_SELECTED_CLASS } from '@/components/nav-row-styles'
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_STEP,
  clampSidebarWidth,
  readStoredSidebarWidth,
  writeStoredSidebarWidth,
} from '@/lib/sidebar-width'
import { cn } from '@/lib/utils'
/** Tailwind's `md`. The drawer is the `<md` affordance, so this must stay in step with the
 *  `md:hidden` / `md:flex` classes below — they are the same breakpoint expressed twice, once
 *  for CSS and once for the state machine. */
const DESKTOP_MEDIA_QUERY = '(min-width: 768px)'

/** The desktop sidebar's current width, for the project rail (#711): it may unfold only while the
 *  main column keeps its floor, and the sidebar's width is part of that sum. The shell owns the
 *  width, so it provides it; outside a shell the rail reads the default. */
export const ShellSidebarWidthContext = React.createContext(DEFAULT_SIDEBAR_WIDTH)

// The one home of the add-project menu is its own file; it stays importable from here.
export { AddProjectMenu } from '@/components/add-project-menu'

export type RepoChip = {
  name: string
  branch: string
}

export type AppShellProps = {
  /** The routed view. Renders into the one scrolling region. */
  children: ReactNode
  breadcrumb?: { project: string | null; page: string; branch?: string | null }
  /** Repo + branch for the brand chip. Null until Step 3.1/3.2 wires `/api/health` — the chip
   *  is simply absent rather than showing an invented repo name. */
  repo?: RepoChip | null
  /** Inbox badge count. Null/0 renders no badge. Step 3.2 feeds it from the SSE stream. */
  inboxCount?: number | null
  /** A quiet, accessible marker on Skills when a checked update remains actionable. */
  skillsUpdateAvailable?: boolean
  /** Running cezar version beside the wordmark. Null while health is unknown. */
  version?: string | null
  /** The npm registry's newer version, when the server's update check found one (#368). */
  latestVersion?: string | null
  applicationUpdate?: ApplicationUpdateState
  onApplyUpdate?: () => Promise<void>
  onRestart?: () => Promise<void>
  applicationUpdateError?: string | null
  applicationUpdateBusy?: boolean
  applicationUpdateOffline?: boolean
  /** View-specific desktop navigation; unconverted views fall back to the task list. */
  sidebarList?: ReactNode
  /** Step 3.3's grouped task quick-list. */
  taskQuickList?: ReactNode
  sessionScope?: ReactNode
  /** Step 4.2's Tools dropdown trigger. */
  toolsMenu?: ReactNode
  /** Forge gating (R6 Step 1.1): `false` drops the GitHub nav item — see `visibleNavItems`.
   *  Defaults to shown so the presentational shell stays renderable alone; the container
   *  passes the health payload's truth. */
  forgeAvailable?: boolean
  /** Inbox gating (#471): `false` drops the Inbox nav item and its badge — the global inbox is
   *  opt-in via `CEZ_FOLLOWUPS=1`. Defaults to shown for the same reason as `forgeAvailable`. */
  inboxAvailable?: boolean
  /** Automations gating (#801): `false` drops the Automations nav item — GitHub automations are
   *  opt-in via `CEZ_AUTOMATIONS=1`. Defaults to shown for the same reason as `forgeAvailable`;
   *  the container passes the health payload's truth. */
  automationsAvailable?: boolean
  /** Global chrome banner, rendered in its own row above the scroller. Absent renders nothing —
   *  the slot is generic and currently unused (the #391 skills promo it once held is gone,
   *  replaced by the opt-in Import panel on the Skills page). */
  banner?: ReactNode
  /** The registry and every project's signal, for the phone's menu button and drawer (#620). Plain
   *  data rather than a slot: the shell reads no query itself. Absent renders no project UI. */
  mobileProjects?: MobileProjectNav | null
  projectHeader?: ReactNode
  /** Navigation belongs to the project displayed here, even on workspace routes. */
  sidebarProjectId?: string
  needsYou?: boolean
  /** The desktop project rail (#618): a 60px workspace-level column left of the sidebar. A slot
   *  because the rail reads the registry and the runs index, and this shell must keep rendering
   *  where no QueryClient is provided. Absent renders nothing; hidden below `md` by its own frame. */
  projectRail?: ReactNode
  /** The phone drawer's Tools row (#621): amber dot and forge note, derived from health by the
   *  container. Null/absent renders no row, as `toolsMenu` renders no trigger without health. */
  toolsStatus?: DrawerTools | null
}

/**
 * The drawer's close-on-navigate callback, published to whatever renders inside the sidebar's
 * slots (`projectHeader`, `taskQuickList`). The route-change effect already closes the drawer
 * for every *changed* route; this covers re-clicking a link to the CURRENT route (per the spec,
 * Tasks navigates home even when already active), which changes no pathname at all. Undefined
 * on desktop, where there is nothing to close.
 */
const SidebarNavigateContext = React.createContext<(() => void) | undefined>(undefined)

export function useSidebarNavigate(): (() => void) | undefined {
  return React.useContext(SidebarNavigateContext)
}

/** The main transcript owns cached/tail arrival; every other routed surface uses shell-top. */
export function routeOwnsScrollArrival(pathname: string): boolean {
  return matchPath({ path: '/tasks/:id', end: true }, stripProjectPrefix(pathname)) !== null
}

function isGithubPath(pathname: string): boolean {
  const path = stripProjectPrefix(pathname)
  return path === '/github' || path.startsWith('/github/')
}

/**
 * The cockpit's app shell: a fixed sidebar plus a single scrolling main region.
 *
 * Layout contract (spec, "App shell & navigation"):
 *  - `h-dvh` (never `100vh` — that ignores mobile browser chrome and clips the composer).
 *  - The main column is a `auto auto 1fr auto` grid — top bar / banner / scroller / composer
 *    dock. Rows are placed explicitly (`row-start-*`) so hiding the mobile bar at `md`, or
 *    passing no `banner`, leaves that row empty instead of promoting the scroller into the
 *    `auto` row and collapsing it.
 *  - The banner is a peer row of the scroller, never a child of it: routed views own
 *    `sticky top-0` headers (at both `z-10` and `z-20`), so a banner sticking to the same edge
 *    inside `main` would tie with them in the stacking order and be painted over. Its own row
 *    keeps it visible while the view scrolls under it, with no z-index coupling to any route.
 *  - `overflow-hidden` here and on `body` means the document never scrolls; only the main
 *    region does, with `overscroll-contain` so a thread at its end doesn't rubber-band the page.
 *  - Safe-area insets are the shell's job, not each view's: left/right on the root, top on the
 *    mobile bar, bottom on the composer row (which stays mounted, so the home indicator always
 *    has its gutter even before Step R4 puts a composer in it).
 *  - Below `md` the sidebar is gone and its content moves, unchanged, into an overlay drawer
 *    (`MobileNavDrawer`). Same components, only the framing changes.
 */
export function AppShell({
  children,
  breadcrumb,
  repo = null,
  inboxCount = null,
  skillsUpdateAvailable = false,
  version = null,
  latestVersion = null,
  applicationUpdate,
  onApplyUpdate,
  onRestart,
  applicationUpdateError,
  applicationUpdateBusy,
  applicationUpdateOffline,
  sidebarList,
  taskQuickList,
  sessionScope,
  toolsMenu,
  forgeAvailable = true,
  inboxAvailable = true,
  automationsAvailable = true,
  banner,
  mobileProjects,
  projectHeader,
  sidebarProjectId,
  needsYou,
  projectRail,
  toolsStatus,
}: AppShellProps) {
  const { pathname, search } = useLocation()
  // The nav's area rules reason about the flat route map — strip any `/p/:projectId` prefix
  // (multi-project spec, step 3.2) so `/p/cezar/git/commits` still lights Git.
  const areaPathname = stripProjectPrefix(pathname)
  const activeTo = areaPathname === '/new' ? '/new' : activeNavPath(areaPathname)
  const current = activeNavItem(areaPathname)
  // The URL's own scope, as on the rail: global routes carry none, so every project is "elsewhere".
  const currentProjectId = pathnameProjectId(pathname)
  // The tab bar belongs to list screens (#621): an opened task is a pushed screen whose composer
  // owns the bottom edge, and while the keyboard is up (the visual viewport shrank below the
  // layout viewport — the same source `--kb` is published from) it would only eat the room the
  // composer needs.
  // A pinch-zoom also leaves the visual viewport shorter than the layout one, so a real keyboard
  // is the bottom inset that is both large and seen at scale ~1.
  const keyboardOpen = useKeyboardOpen()
  // Pushed Git section screens hide it too (issue 08 §C, the slice 5 rule): each has its own Back to Git.
  const showTabBar = !isPushedRoute(pathname) && !isPushedGitScreen(pathname, search) && !keyboardOpen
  const tabBarSignal = currentProjectId !== null ? mobileProjects?.signals?.get(currentProjectId) : undefined
  const [menuOpen, setMenuOpen] = React.useState(false)
  // The pushed task screen (#621): its top bar carries back / title / state / run actions, and the
  // routed `RunHeader` fills the slot below through `MobileRunBarSlotContext`.
  const pushed = isPushedRoute(pathname)
  const [runBarSlot, setRunBarSlot] = React.useState<HTMLElement | null>(null)
  const mobileNavTrigger = React.useRef<HTMLButtonElement | null>(null)
  const mainRef = React.useRef<HTMLElement>(null)
  const previousPathname = React.useRef<string | null>(null)
  const routeOwnsArrival = routeOwnsScrollArrival(pathname)
  // Git's phone index and its repository share ONE pathname (`/git` vs `/git?view=repo`), so the
  // pathname-only reset below misses that switch. A boolean, so unrelated search changes do not
  // reset anything.
  const gitRepositoryView = areaPathname === '/git' && new URLSearchParams(search).get('view') === 'repo'
  // The desktop column's width (#788). Read once, lazily, from `localStorage` — it is a
  // browser-local preference like the theme, so there is nothing to fetch and nothing to wait
  // for, and the first paint is already the user's width rather than a default that jumps.
  const [sidebarWidth, setSidebarWidth] = React.useState(readStoredSidebarWidth)
  const changeSidebarWidth = React.useCallback((next: number) => {
    const width = clampSidebarWidth(next)
    setSidebarWidth(width)
    // Persist on every change rather than on drag end: a drag is a stream of small writes to one
    // key, which localStorage is fine with, and it means a tab closed mid-drag still remembers.
    writeStoredSidebarWidth(width)
  }, [])

  // The scroller PERSISTS across routes (it is the shell's, not the view's), so without this
  // a deep scroll on one page carries into the next — most visibly on mobile, where Tasks or
  // GitHub opened mid-list. Layout effect: the reset lands before the new view paints. The main
  // task transcript owns its arrival offset. GitHub keeps the same docked page while picking an
  // item, so its main scroll stays put when both routes are inside the same project's GitHub.
  React.useLayoutEffect(() => {
    const previous = previousPathname.current
    previousPathname.current = pathname
    if (routeOwnsArrival) return
    if (previous !== null &&
      pathnameProjectId(previous) === pathnameProjectId(pathname) &&
      isGithubPath(previous) && isGithubPath(pathname)) return
    const main = mainRef.current
    if (main) main.scrollTop = 0
  }, [pathname, routeOwnsArrival, gitRepositoryView])

  // Close on route change. Without this the drawer survives the navigation it triggered and sits
  // on top of the view the user just asked for — and back/forward and the ⌘K palette (Step 4.3)
  // navigate without going through the drawer's own links at all.
  React.useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

  // The drawer must not outlive its breakpoint: widening past `md` reveals the real sidebar, and
  // an open drawer would leave a focus-trapping modal over an already-visible nav.
  React.useEffect(() => {
    const query = window.matchMedia?.(DESKTOP_MEDIA_QUERY)
    if (!query) return
    if (query.matches) setMenuOpen(false)
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setMenuOpen(false)
    }
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  const nav = {
    activeTo,
    items: visibleNavItems({ forge: forgeAvailable, inbox: inboxAvailable, automations: automationsAvailable }),
    repo,
    // The badge belongs to the Inbox item — with the item gone there is nothing to badge.
    inboxCount: inboxAvailable ? inboxCount : null,
    skillsUpdateAvailable,
    version,
    latestVersion,
    applicationUpdate,
    onApplyUpdate,
    onRestart,
    applicationUpdateError,
    applicationUpdateBusy,
    applicationUpdateOffline,
    sidebarList,
    taskQuickList,
    sessionScope,
    toolsMenu,
    projectHeader,
    sidebarProjectId,
    needsYou,
    }

  return (
    // The Sheet root renders no DOM of its own — it is the context that lets the top bar's menu
    // button be a real SheetTrigger while the open state stays ours to close on navigation.
    <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
      <div
        data-slot="app-shell"
        className="flex h-dvh overflow-hidden bg-background text-foreground pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
      >
        {/* Outside the resizable sidebar: SidebarResize only ever changes the aside's width. */}
        <ShellSidebarWidthContext.Provider value={sidebarWidth}>{projectRail}</ShellSidebarWidthContext.Provider>
        <Sidebar {...nav} width={sidebarWidth} onWidthChange={changeSidebarWidth} />
        {/* The drawer leaves a visible dismissal strip beside the shared navigation. */}
        <MobileNavDrawer {...nav} mobileProjects={mobileProjects} currentProjectId={currentProjectId} toolsStatus={toolsStatus} onNavigate={() => setMenuOpen(false)} onCloseAutoFocus={(event) => {
          // Both mobile controls open the same drawer. Restore the actual opener, rather
          // than Radix's single trigger ref (which otherwise points at the last mount).
          if (mobileNavTrigger.current?.isConnected) {
            event.preventDefault()
            mobileNavTrigger.current.focus()
          }
        }} />

        <div className="grid min-w-0 flex-1 grid-rows-[auto_auto_1fr_auto] overflow-hidden">
          <MobileTopBar title={current?.label ?? 'cezar'} pushed={pushed ? { compare: areaPathname.startsWith('/compare/'), onSlot: setRunBarSlot } : null} repo={repo} elsewhere={elsewhereSignal(mobileProjects, currentProjectId)} onTrigger={(button) => { mobileNavTrigger.current = button }} />
          <header data-slot="desktop-breadcrumb" className={cn("row-start-1 hidden min-w-0 items-center gap-3 border-b border-border text-[13px] text-muted-foreground md:flex", areaPathname === '/new' ? 'h-[72px] px-11' : 'h-16 px-9')}>
            <FolderIcon aria-hidden="true" className="size-4 shrink-0" />
            {(breadcrumb?.project ?? repo?.name) ? <><span className="truncate font-medium text-foreground">{breadcrumb?.project ?? repo?.name}</span><span aria-hidden="true">/</span></> : null}
            <span className="min-w-0 truncate">{breadcrumb?.page ?? current?.label ?? 'Cezarion'}</span>
            {(breadcrumb?.branch ?? repo?.branch) ? <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px]">{/* The one teal left beside the sidebar, deliberately (#617 01c): the header's ShieldCheck
                sits outside the sidebar list and waits for the brand accent's own review. */}<ShieldCheckIcon aria-hidden="true" className="size-4 text-accent-text" />{breadcrumb?.branch ?? repo?.branch}</span> : null}
          </header>

          {banner ? (
            <div data-slot="banner-slot" className="row-start-2">
              {banner}
            </div>
          ) : null}

          <main
            ref={mainRef}
            data-slot="main"
            // The New task button floats over the bottom of main, so leave its height (48px + 16px
            // gap) plus air clear while it is shown, or the last row sits under it at full scroll.
            className={cn('row-start-3 min-h-0 overflow-y-auto overscroll-contain', showTabBar && areaPathname !== '/new' && 'max-md:pb-20')}
          >
            <MobileRunBarSlotContext.Provider value={pushed ? runBarSlot : null}>
              {children}
            </MobileRunBarSlotContext.Provider>
          </main>

          {/* Row 4 reserves whichever obstruction is taller: the home indicator or the visual
              keyboard inset published as --kb. The real thread composer remains in document
              flow inside main; shrinking that viewport keeps it reachable without an overlay. */}
          <div
            data-slot="composer"
            // On a list screen below `md` the row IS the tab bar's surface, so the inset padding
            // sits under the bar on the bar's own fill, and it is the anchor the New task button
            // floats from. `md:` sheds all of it: the desktop row stays the empty gutter it was.
            className={cn(
              'row-start-4 pb-[max(env(safe-area-inset-bottom),var(--kb,0px))]',
              showTabBar && 'relative max-md:border-t max-md:border-border max-md:bg-sidebar',
            )}
          >
            {showTabBar ? (
              <div className="md:hidden">
                <MobileTabBar
                  items={nav.items}
                  activeTo={activeTo}
                  signal={tabBarSignal}
                  projectName={mobileProjects?.projects.find((project) => project.id === currentProjectId)?.name ?? repo?.name ?? null}
                  inboxCount={nav.inboxCount}
                  skillsUpdateAvailable={skillsUpdateAvailable}
                  showNewTask={areaPathname !== '/new'}
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </Sheet>
  )
}

type NavProps = {
  activeTo: string | null
  items: NavItem[]
  repo: RepoChip | null
  inboxCount: number | null
  skillsUpdateAvailable: boolean
  version: string | null
  latestVersion: string | null
  applicationUpdate?: ApplicationUpdateState
  onApplyUpdate?: () => Promise<void>
  onRestart?: () => Promise<void>
  applicationUpdateError?: string | null
  applicationUpdateBusy?: boolean
  applicationUpdateOffline?: boolean
  sidebarList?: ReactNode
  taskQuickList?: ReactNode
  sessionScope?: ReactNode
  toolsMenu?: ReactNode
  projectHeader?: ReactNode
  /** Navigation belongs to the project displayed here, even on workspace routes. */
  sidebarProjectId?: string
  needsYou?: boolean

}

/**
 * The desktop frame, from `md` up — 232px by default and draggable up to 420px (#788).
 *
 * The width is the user's, not the layout's: the sidebar is the app's primary navigation and its
 * rows carry task names, so the right column width depends on the screen someone is sitting at.
 * It lives in `localStorage` rather than in the workspace config for exactly that reason — see
 * `lib/sidebar-width.ts`.
 *
 * An inline `width` rather than a Tailwind class because the value is a number from state, and
 * the class is left off entirely below `md`, where `hidden` takes the element out of flow and the
 * drawer (a fixed 232px) is the sidebar instead.
 */
function Sidebar({ width, onWidthChange, ...props }: NavProps & SidebarResize) {
  return (
    <aside
      data-slot="sidebar"
      style={{ width }}
      className="relative hidden shrink-0 flex-col border-r border-border bg-sidebar md:flex"
    >
      <SidebarContent {...props} />
      <SidebarResizeHandle width={width} onWidthChange={onWidthChange} />
    </aside>
  )
}

type SidebarResize = {
  width: number
  onWidthChange: (width: number) => void
}

/**
 * The drag handle on the sidebar's right border (#788).
 *
 * A `separator` with `aria-orientation="vertical"` — the ARIA window-splitter pattern — which is
 * the one role that is BOTH focusable and carries a value range, so the same affordance serves a
 * pointer and a keyboard. Arrow keys step it, Home/End go to the bounds, and a double-click puts
 * it back to the default, which is the cheap way out of a width you dragged by accident.
 *
 * Pointer capture rather than window listeners: the drag must survive the pointer leaving a 5px
 * hit area (it will, immediately, on any real drag), and capture is how the browser keeps
 * delivering the moves to this element without us installing and remembering to remove global
 * handlers. `touch-none` stops a touch-drag from scrolling the page instead of resizing — the
 * handle is `md`-only, but `md` includes touch laptops and tablets.
 *
 * Rendered inside the `<aside>` and absolutely positioned over its border, so it inherits the
 * column's height without a second element having to track it.
 */
function SidebarResizeHandle({ width, onWidthChange }: SidebarResize) {
  // The width the drag started from, plus the pointer x it started at. Refs, not state: they
  // change on every pointermove and nothing renders from them.
  const origin = React.useRef<{ x: number; width: number } | null>(null)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Primary button only — a right-click on the border must not start a resize.
    if (event.button !== 0) return
    origin.current = { x: event.clientX, width }
    event.currentTarget.setPointerCapture(event.pointerId)
    // Without this the drag selects the sidebar's text as it passes over it.
    event.preventDefault()
    // …but preventing the default also suppresses the focus the press would have given a
    // `tabIndex=0` element, which would leave someone who grabbed the handle with a mouse unable
    // to fine-tune with the arrow keys immediately afterwards. Focus it explicitly instead.
    event.currentTarget.focus()
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = origin.current
    if (!start) return
    onWidthChange(clampSidebarWidth(start.width + (event.clientX - start.x)))
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!origin.current) return
    origin.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === 'ArrowLeft'
        ? width - SIDEBAR_WIDTH_STEP
        : event.key === 'ArrowRight'
          ? width + SIDEBAR_WIDTH_STEP
          : event.key === 'Home'
            ? MIN_SIDEBAR_WIDTH
            : event.key === 'End'
              ? MAX_SIDEBAR_WIDTH
              : null
    if (next === null) return
    // Only for the keys we handled: Tab, Escape and the rest stay the browser's.
    event.preventDefault()
    onWidthChange(clampSidebarWidth(next))
  }

  return (
    <div
      data-slot="sidebar-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-valuenow={width}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onWidthChange(DEFAULT_SIDEBAR_WIDTH)}
      title="Drag to resize the sidebar — double-click to reset"
      // A 5px grab strip straddling the border, invisible until you reach for it. `touch-none`
      // is load-bearing rather than decorative: without it a touch drag is claimed by the
      // browser's own panning and scrolls the page instead of resizing the column.
      className="absolute inset-y-0 -right-[2px] z-20 w-[5px] cursor-col-resize touch-none bg-transparent transition-colors hover:bg-[var(--composer-border)] focus-visible:bg-[var(--composer-border)] focus-visible:outline-none"
    />
  )
}

/**
 * The `<md` drawer: projects and their current task sections (#811). Views live in the tab bar and
 * its More sheet, New task on the floating button and search
 * in the top bar, so the desktop `SidebarContent` is no longer rendered here. The three things
 * only it carried got new homes: Tools is a row in `DrawerGlobal`, the update action is
 * `DrawerUpdate` under the identity row, and the project menu is the `…` on the current project.
 *
 * Radix's Dialog (via the Sheet primitive) supplies the parts that are easy to get wrong by hand:
 * `role="dialog"`, the accessible name, the focus trap, the Escape handler, the backdrop's
 * dismiss-on-tap, and `aria-hidden` on everything outside the portal — which is how it delivers
 * modality (it does not set `aria-modal`; `hideOthers` is the stronger guarantee).
 */
function MobileNavDrawer({
  onNavigate, onCloseAutoFocus, mobileProjects, currentProjectId, toolsStatus,
  version, latestVersion, applicationUpdate, onApplyUpdate, onRestart,
  applicationUpdateError, applicationUpdateBusy, applicationUpdateOffline,
  taskQuickList, sidebarProjectId,
}: Pick<NavProps, 'sidebarProjectId' | 'taskQuickList' | 'version' | 'latestVersion' | 'applicationUpdate' | 'onApplyUpdate' | 'onRestart' | 'applicationUpdateError' | 'applicationUpdateBusy' | 'applicationUpdateOffline'> & {
  onNavigate: () => void
  onCloseAutoFocus?: React.ComponentProps<typeof SheetContent>['onCloseAutoFocus']
  mobileProjects?: MobileProjectNav | null
  currentProjectId: string | null
  toolsStatus?: DrawerTools | null
}) {
  return (
    <SheetContent
      side="left"
      data-slot="mobile-nav-drawer"
      onCloseAutoFocus={onCloseAutoFocus}
      overlayClassName="bg-[var(--nav-scrim)]"
      showCloseButton={false}
      // Same width and surface token as the desktop sidebar, and no padding of its own — its
      // rows bring their own. `sm:max-w-none` sheds the primitive's sheet width cap.
      className="w-[calc(100%-68px)] max-w-[334px] gap-0 border-border bg-sidebar p-0 sm:max-w-[334px] md:hidden"
      // Nav needs no prose description, and Radix warns when it cannot find the one it links to.
      aria-describedby={undefined}
    >
      {/* The dialog's accessible name. Visually redundant with the identity row below. */}
      <SheetTitle className="sr-only">Navigation</SheetTitle>
      <DrawerIdentity version={version} />
      <DrawerUpdate
        version={version}
        latestVersion={latestVersion}
        state={applicationUpdate}
        onApplyUpdate={onApplyUpdate}
        onRestart={onRestart}
        error={applicationUpdateError}
        busy={applicationUpdateBusy}
        offline={applicationUpdateOffline}
      />
      {/* One scroll: Projects, then the workspace links. The safe-area insets are the identity
          row's and the global rows', so the content between them takes none of its own. */}
      <div data-slot="drawer-scroll" className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
        {mobileProjects ? <DrawerProjects nav={mobileProjects} currentProjectId={currentProjectId} onNavigate={onNavigate} /> : null}
        {taskQuickList ? <SidebarNavigationScope projectId={sidebarProjectId} onNavigate={onNavigate}>
          <div data-slot="drawer-tasks" className="border-t border-border px-[8px] py-[8px]">{taskQuickList}</div>
        </SidebarNavigationScope> : null}
      </div>
      <DrawerGlobal onNavigate={onNavigate} tools={toolsStatus} />
    </SheetContent>
  )
}

/** Displayed-project navigation is shared by the desktop sidebar and the mobile task list. */
function SidebarNavigationScope({ projectId, onNavigate, children }: {
  projectId?: string
  onNavigate?: () => void
  children: React.ReactNode
}) {
  const inheritedScope = useProjectScope()
  // Context only: the routed view owns the mutable API scope. Sidebar queries bind their
  // endpoints explicitly; links and row navigation share this displayed project's identity.
  const scope = projectId === undefined ? inheritedScope : {
    projectId,
    apiBase: `${API_PREFIX}/p/${encodeURIComponent(projectId)}`,
  }
  return <ProjectScopeContext.Provider value={scope}>
    <SidebarNavigateContext.Provider value={onNavigate}>{children}</SidebarNavigateContext.Provider>
  </ProjectScopeContext.Provider>
}

/**
 * Everything inside the sidebar: brand lockup, New task CTA, nav, quick-list, footer. Framed by
 * `Sidebar`, desktop only since #621. The phone drawer reuses the task list (#811).
 */
function SidebarContent({
  activeTo,
  items,
  repo,
  inboxCount,
  skillsUpdateAvailable,
  version,
  latestVersion,
  applicationUpdate,
  onApplyUpdate,
  onRestart,
  applicationUpdateError,
  applicationUpdateBusy,
  applicationUpdateOffline,
  sidebarList,
  taskQuickList,
  sessionScope,
  toolsMenu,
  projectHeader,
  sidebarProjectId,
  needsYou,
  onNavigate,
}: NavProps & {
  /** Fires on any in-drawer navigation. The route-change effect already closes the drawer for
   *  every *changed* route; this also covers re-clicking the active item (per the spec, Tasks
   *  navigates home even when already active), which changes no pathname at all. */
  onNavigate?: () => void
}) {
  return (
    <SidebarNavigationScope projectId={sidebarProjectId} onNavigate={onNavigate}><div
      data-slot="sidebar-content"
      // `@container/sidebar` (#788): the sidebar is no longer one fixed width, so what its rows
      // can afford to paint is a question about THIS column, not about the viewport. Everything
      // inside that is droppable metadata — the quick-list's diff pair today — hides itself with
      // an `@min-[…]/sidebar:` query and returns when the user drags the column wider.
      className={'@container/sidebar flex min-h-0 flex-1 flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]'}
    >
      <div data-slot="sidebar-header" className="shrink-0">
        {projectHeader ?? (repo ? <div className="px-[14px] pt-[14px] pb-2.5"><div className="truncate text-sm font-semibold">{repo.name}</div><div className="truncate font-mono text-[10.5px] text-soft-foreground">{repo.branch}</div></div> : null)}
      </div>

      {/* The board's Actions frame: 12px sides, 8px between Search and New task, both 32px. */}
      <div data-slot="sidebar-actions" className="flex flex-col gap-2 px-3">
        <CommandPaletteHint />
        {/* On /new it wears a selected nav item's fill and ink (#617 01c); its hover is the rows'. */}
        <Button asChild variant="ghost" className={cn("relative h-[32px] max-md:min-h-11 rounded-[7px] bg-muted w-full min-w-0 justify-start gap-2 px-2.5 text-[12.5px] font-medium text-foreground hover:bg-sidebar-row-hover hover:text-foreground", activeTo === "/new" && SIDEBAR_SELECTED_CLASS)}>
          {/* A Router Link since R4 Step 1.1: the React /new composer is real, so deliberate
              New task affordances stay inside the SPA. Full document loads of /new (the
              bookmarklet contract) land on the shell like any route (static-ui.ts) — the
              React composer has owned auto-start parity since R4 Step 1.3. */}
          {/* `data-sidebar-item`, not `data-slot`: Slot would let it replace the Button's
              `data-slot="button"`, which is what holds the mobile 44px floor. */}
          <Link to="/new" onClick={onNavigate} data-sidebar-item="new-task" aria-current={activeTo === '/new' ? 'page' : undefined}>
            <PlusIcon className="size-[15px]" aria-hidden="true" />
            New task
            {/* Decorative: the `c`-to-create accelerator is registered in the command palette.
                (⌘N is also bound there, but only the desktop shell receives it — the browser
                reserves ⌘N for a new window — so the chip advertises the one that always works.) */}
            <kbd
              aria-hidden="true"
              className="sr-only"
            >
              C
            </kbd>
          </Link>
        </Button>
      </div>

      {sessionScope ? <div className="shrink-0 px-3 pt-2">{sessionScope}</div> : null}
      <SidebarViewTabs items={items} activeTo={activeTo} needsYou={needsYou} inboxCount={inboxCount} skillsUpdateAvailable={skillsUpdateAvailable} onNavigate={onNavigate} />
      <div data-slot="project-task-navigation" className={'min-h-0 flex-1 overflow-y-auto overscroll-contain p-3'}>
        <SidebarNavigateContext.Provider value={onNavigate}>
          {sidebarList ?? <div data-slot="task-quick-list">{taskQuickList}</div>}
        </SidebarNavigateContext.Provider>
      </div>

      <div data-slot="sidebar-footer" className="shrink-0">
        {/* The board's footer: a 44px bar, 12px sides, Tools at the left, version and update at the right. */}
        <div data-slot="sidebar-footer-controls" className="flex h-11 items-center justify-between gap-1 border-t border-border px-3">
          <div data-slot="tools-menu" className="shrink-0">{toolsMenu}</div>
          <div className="flex min-w-0 items-center gap-1" data-slot="version-action">
            {version ? <VersionChip version={version} latestVersion={latestVersion} /> : null}
            <ApplicationUpdateControl version={version} latestVersion={latestVersion} state={applicationUpdate} onApplyUpdate={onApplyUpdate} onRestart={onRestart} error={applicationUpdateError} busy={applicationUpdateBusy} offline={applicationUpdateOffline} />
          </div>
        </div>
        <ApplicationUpdateFeedback version={version} latestVersion={latestVersion} state={applicationUpdate} error={applicationUpdateError} offline={applicationUpdateOffline} busy={applicationUpdateBusy} />
      </div>
    </div></SidebarNavigationScope>
  )
}

/**
 * The ⌘K discoverability affordance (Step 4.3): the footer's first row, shaped like a search
 * input — magnifier, a muted `Search…` label, the chord parked on the right. It was a chip
 * cut from the version chip's cloth until #702, where the footer's five chips overflowed the
 * narrow column; giving search the whole line is what makes the remaining controls fit on one
 * row, and it reads as the launcher it is rather than as a keyboard-shortcut footnote.
 *
 * Still a button, not an input: there is no search *here*: clicking opens the palette through
 * the same programmatic seam anything else would, and the palette owns the real input.
 *
 * No `aria-label`: the visible `Search…` already names it, and an override that merely drops
 * the ellipsis would make the accessible name diverge from the label a speech user reads
 * aloud (WCAG 2.5.3). The chord rides `commandShortcutHint` so the kbd shows Ctrl+K off Apple
 * hardware, per the spec's platform-symbol rule.
 */
function CommandPaletteHint() {
  return (
    <button
      type="button"
      data-slot="command-palette-hint"
      title="Search — command palette (⌘K / Ctrl+K)"
      onClick={() => openCommandPalette()}
      className="flex h-[32px] max-md:min-h-11 w-full items-center gap-2 rounded-[7px] border border-border bg-background px-2.5 text-left text-[12.5px] font-normal text-soft-foreground transition-colors hover:border-border hover:text-foreground"
    >
      <SearchIcon className="size-[14px] shrink-0" aria-hidden="true" />
      <span className="truncate">Search…</span>
      <kbd
        aria-hidden="true"
        className="ml-auto shrink-0 font-sans text-[11px] font-normal text-soft-foreground"
      >
        {commandShortcutHint('k')}
      </kbd>
    </button>
  )
}

/**
 * The header's `v{version}` chip. A numeric newer release gets a quiet pending dot.
 *
 * The chip yields to the fixed 44px action when a nightly version is long. The full string
 * remains in the DOM for assistive tech and in `title` for pointer readers when it truncates.
 */
function VersionChip({ version, latestVersion }: { version: string; latestVersion: string | null }) {
  const updateAvailable = Boolean(latestVersion && isNewerVersion(latestVersion, version))
  return (
    <span
      data-slot="version-chip"
      data-update-available={updateAvailable ? 'true' : undefined}
      title={updateAvailable ? `v${version} — update available: v${latestVersion}` : `v${version}`}
      className="flex min-w-0 items-center gap-1 font-mono text-[11px] text-soft-foreground"
    >
      {updateAvailable ? <StatusDot tone="pending" className="size-[5px] shrink-0" /> : null}
      <span className="truncate">v{version}</span>
    </span>
  )
}

/** Mobile chrome (<md): the sidebar's replacement. Its menu button and project button open `MobileNavDrawer`. */
function MobileTopBar({ title, pushed, repo, elsewhere, onTrigger }: {
  title: string
  /** Non-null on a pushed screen (a task or a variant compare): the bar swaps its project chrome for
   *  back / title / actions. `onSlot` receives the element the routed view portals its content into. */
  pushed: { compare: boolean; onSlot: (slot: HTMLElement | null) => void } | null
  repo: RepoChip | null
  /** The other projects' four counts summed; null while activity is unknown. */
  elsewhere: ProjectSignal | null
  onTrigger: (button: HTMLButtonElement) => void
}) {
  if (pushed) return <PushedTopBar compare={pushed.compare} onSlot={pushed.onSlot} />
  return (
    <header
      data-slot="mobile-top-bar"
      // `min-w-0`: a grid item sizes its column to its min-content by default, and a long project name
      // (nowrap) would widen the whole shell past the phone. The name truncates instead.
      className="row-start-1 min-w-0 border-b border-border bg-card pt-[env(safe-area-inset-top)] md:hidden"
    >
      <div className="flex h-[56px] min-w-0 items-center gap-[8px] px-[8px]">
        {/* A real SheetTrigger rather than an onClick that flips our state: it is what registers
            the button as the dialog's trigger, which is what Radix restores focus to on close —
            with a bare onClick, closing the drawer drops focus on <body>. It also carries the
            aria-haspopup / aria-expanded / aria-controls wiring for free. */}
        <SheetTrigger asChild>
          <Button
            variant="ghost"
            aria-label={menuButtonLabel(elsewhere)}
            onClick={(event) => onTrigger(event.currentTarget)}
            // 64×44: the icon at the left, the other projects' two pills stacked on the right like
            // a small rail mark. 44px tall is the minimum touch target.
            className="relative h-[44px] w-[64px] shrink-0 justify-start rounded-md p-0 pl-[10px] text-foreground"
          >
            <MenuIcon className="size-[20px]" aria-hidden="true" />
            <MenuButtonPills elsewhere={elsewhere} />
          </Button>
        </SheetTrigger>
        {repo ? (
          <SheetTrigger asChild>
            {/* No count, ever: a signal beside the project name would read as that project's. */}
            <button type="button" data-slot="mobile-project-picker" aria-label={`Switch project: ${repo.name}`}
              onClick={(event) => onTrigger(event.currentTarget)}
              className="flex h-[44px] min-w-0 flex-1 items-center justify-start gap-[10px] rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring">
              <span aria-hidden="true" className="flex size-[28px] shrink-0 items-center justify-center rounded-[8px] border border-soft-foreground bg-sidebar-row-selected text-[11px] leading-none font-semibold text-foreground">
                {projectInitials(repo.name)}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[15px] leading-tight font-semibold text-foreground">{repo.name}</span>
                {repo.branch ? <span className="truncate font-mono text-[10.5px] leading-tight text-soft-foreground">{repo.branch}</span> : null}
              </span>
              <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0 text-soft-foreground" />
            </button>
          </SheetTrigger>
        ) : null}
        {title !== 'cezar' ? (
          // Beside a project the page title is redundant with the view itself, so it stays for
          // screen readers only; with no project (global routes) it is the bar's label.
          <span data-slot="mobile-route-title" className={cn('truncate text-[15px] font-semibold text-foreground', repo ? 'sr-only' : 'min-w-0 flex-1 pl-[8px]')}>
            {title}
          </span>
        ) : repo ? null : <span className="flex-1" />}
        <Button
          variant="ghost"
          aria-label="Search"
          data-slot="mobile-search"
          onClick={() => openCommandPalette()}
          className="ml-auto size-[44px] shrink-0 p-0 text-foreground"
        >
          <SearchIcon className="size-[19px]" aria-hidden="true" />
        </Button>
      </div>
    </header>
  )
}

/**
 * The pushed screen's bar: back, then whatever the routed view publishes into the slot (a task's
 * title, state line and run actions — see `mobile-run-bar.tsx`). A compare route publishes
 * nothing, so it titles itself.
 *
 * Back returns to where the user came from when the app has in-app history (react-router's
 * `history.state.idx` counts entries pushed by this session), and falls to the Tasks list when the
 * screen was opened cold — a deep link or a reload — where `navigate(-1)` would leave the app.
 */
function PushedTopBar({ compare, onSlot }: { compare: boolean; onSlot: (slot: HTMLElement | null) => void }) {
  const navigate = useNavigate()
  const goBack = () => {
    const idx = (window.history.state as { idx?: unknown } | null)?.idx
    if (typeof idx === 'number' && idx > 0) navigate(-1)
    else navigate('/')
  }
  return (
    <header
      data-slot="mobile-top-bar"
      data-mode="task"
      className="row-start-1 min-w-0 border-b border-border bg-card pt-[env(safe-area-inset-top)] md:hidden"
    >
      <div className="flex h-[56px] min-w-0 items-center gap-[4px] px-[8px]">
        <Button
          variant="ghost"
          aria-label="Back"
          data-slot="mobile-back"
          onClick={goBack}
          className="size-[44px] shrink-0 p-0 text-foreground"
        >
          <ChevronLeftIcon className="size-[22px]" aria-hidden="true" />
        </Button>
        {compare ? <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-foreground">Compare variants</span> : null}
        {/* The routed view's portal target; empty while the run loads. */}
        <div data-slot="mobile-run-bar" ref={onSlot} className={cn('flex min-w-0 items-center gap-[4px]', compare ? 'shrink-0' : 'flex-1')} />
      </div>
    </header>
  )
}
