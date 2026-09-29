import { Link as RouterLink } from 'react-router'

import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { AddProjectMenu } from '@/components/add-project-menu'
import { ApplicationUpdateControl, ApplicationUpdateFeedback, type ApplicationUpdateControlProps } from '@/components/application-update-control'
import { CheckIcon, FolderPlusIcon, LayersIcon, Settings2Icon, SunMoonIcon, WrenchIcon, XIcon } from '@/components/design-icons'
import { ProjectMenu } from '@/components/sidebar-project-header'
import { StatusDot } from '@/components/status-dot'
import { SignalPill, signalPillSegments } from '@/components/signal-pill'
import { useTheme } from '@/components/theme-provider'
import { NEXT_THEME } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { SheetClose } from '@/components/ui/sheet'
import { isNewerVersion } from '@/lib/is-newer-version'
import { scopeTo } from '@/lib/project-router'
import { projectInitials, projectSignalParts, sumSignals, type ProjectSignal, type SignalTone } from '@/lib/project-signal'
import { cn } from '@/lib/utils'

/**
 * The phone's answer to "which project needs me" (#620): the same `projectSignal` the desktop rail
 * paints, at the two places a phone has room for it. The menu button carries the OTHER projects'
 * total, and the drawer's Projects section carries one row per project. Presentational, like the
 * rail: the shell container reads the registry and the runs index once and passes the result down.
 */

export type MobileProjectNav = {
  projects: readonly ProjectListEntry[]
  /** Null while the runs index has not loaded: activity is then unknown, not idle. */
  signals: ReadonlyMap<string, ProjectSignal> | null
  truncated: ReadonlySet<string>
  /** `capabilities.singleProject`: All projects and Add project go, as on the rail. */
  singleProject: boolean
}

/** Every project but the current one, summed. Null while activity is unknown. */
export function elsewhereSignal(nav: MobileProjectNav | null | undefined, currentProjectId: string | null): ProjectSignal | null {
  if (!nav?.signals) return null
  const signals = nav.signals
  return sumSignals(nav.projects.filter((project) => project.id !== currentProjectId).map((project) => signals.get(project.id)))
}

/** `Open projects. Elsewhere: 1 needs you, 1 failed, 2 working, 1 finished`, or plain `Open projects`. */
export function menuButtonLabel(elsewhere: ProjectSignal | null): string {
  const parts = projectSignalParts(elsewhere ?? undefined).map((part) => part.text)
  return parts.length > 0 ? `Open projects. Elsewhere: ${parts.join(', ')}` : 'Open projects'
}

/** The menu button's small rail mark: two pills right-aligned 2px from the button's edge. Compact,
 *  so a split pill stays 32px wide and never reaches the 20px menu icon at the left. */
export function MenuButtonPills({ elsewhere }: { elsewhere: ProjectSignal | null }) {
  if (!elsewhere) return null
  const { top, bottom } = signalPillSegments(elsewhere)
  const placement = 'right-[2px] border-card'
  return (
    <>
      <SignalPill position="top" segments={top} compact className={cn(placement, 'top-[3px]')} />
      <SignalPill position="bottom" segments={bottom} compact className={cn(placement, 'top-[24px]')} />
    </>
  )
}

const TONE_TEXT: Record<SignalTone, string> = {
  // `--pending-strong` is the amber that reads on both themes (#F4C542 dark, #996400 light).
  amber: 'text-pending-strong',
  red: 'text-danger',
  violet: 'text-status-running',
  green: 'text-success',
}

/** Brand row: app mark, name, version and the close button. The brand lives here and on the rail. */
export function DrawerIdentity({ version }: { version: string | null }) {
  const { resolvedTheme } = useTheme()
  return (
    <div data-slot="drawer-identity" className="flex shrink-0 items-center gap-[12px] border-b border-border pt-[env(safe-area-inset-top)] pr-[14px] pb-[14px] pl-[18px]">
      <img src={`/cezarion-mark-${resolvedTheme}.svg`} alt="" aria-hidden="true" className="mt-[14px] size-[32px] rounded-lg" />
      <span className="mt-[14px] text-[18px] leading-none font-bold tracking-[-0.02em] text-foreground">Cezarion</span>
      {version ? <span data-slot="drawer-version" className="mt-[14px] text-[11px] leading-none text-soft-foreground">v{version}</span> : null}
      <SheetClose asChild>
        {/* 44px, not the mock's 40: the spec's mobile touch-target floor wins. */}
        <Button variant="ghost" size="icon" aria-label="Close menu" className="mt-[14px] ml-auto size-[44px] text-foreground">
          <XIcon className="size-[19px]" aria-hidden="true" />
        </Button>
      </SheetClose>
    </div>
  )
}

/**
 * The update row (#621): nothing while up to date, since the identity row already shows the
 * version. When a newer release exists it earns a full-width row right under the identity, with
 * the Update or Restart action and the progress/failure feedback that used to live in the
 * sidebar footer this drawer no longer renders.
 */
export function DrawerUpdate({ version, latestVersion, ...update }: Omit<ApplicationUpdateControlProps, 'version' | 'latestVersion'> & {
  version: string | null
  latestVersion: string | null
}) {
  // A ready or restarting update outlives the version gap (the new version is installed but not
  // running yet), so the state, not only the comparison, keeps the row visible.
  const pending = update.state?.status === 'ready' || update.state?.status === 'preparing' || update.state?.status === 'restarting'
  const available = Boolean(version && latestVersion && isNewerVersion(latestVersion, version))
  if (!available && !pending) return null
  const status = update.state?.status
  // Per state: "restart" is only true once the new version is installed; while it is still being
  // fetched the row says so.
  const label =
    status === 'preparing' ? 'Preparing update…'
    : status === 'ready' || status === 'restarting' ? 'Restart to finish updating'
    : `Update available · v${latestVersion}`
  return (
    <div data-slot="drawer-update" className="shrink-0 border-b border-border px-[18px] py-[6px]">
      <div className="flex min-h-[44px] items-center gap-[8px]">
        <StatusDot tone="pending" className="size-[6px] shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
          {label}
        </span>
        <ApplicationUpdateControl version={version} latestVersion={latestVersion} {...update} />
      </div>
      <ApplicationUpdateFeedback version={version} latestVersion={latestVersion} state={update.state} error={update.error} offline={update.offline} busy={update.busy} />
    </div>
  )
}

function DrawerProjectRow({ project, signal, known, truncated, current, onNavigate }: {
  project: ProjectListEntry
  signal: ProjectSignal | undefined
  known: boolean
  truncated: boolean
  current: boolean
  onNavigate: () => void
}) {
  const parts = projectSignalParts(signal)
  const { top, bottom } = signalPillSegments(signal)
  // The pills' ring is the surface they sit on, so they still read as cut-outs on the current row.
  const ring = current ? 'border-sidebar-row-selected' : 'border-sidebar'
  const placement = 'right-[-4px]'
  const link = (
    <RouterLink
      to={scopeTo(project.id, '/')}
      onClick={onNavigate}
      data-slot="drawer-project"
      data-project-id={project.id}
      aria-current={current ? 'page' : undefined}
      className={cn(
        'flex h-[64px] min-w-0 flex-1 items-center gap-[12px] rounded-[10px] px-[10px] text-foreground hover:bg-sidebar-row-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        // With the menu button beside it the row's fill moves to the wrapper, so it runs under both.
        current && 'hover:bg-sidebar-row-selected',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'relative flex size-[40px] shrink-0 items-center justify-center rounded-[10px] border text-[13px] leading-none font-semibold',
          current ? 'border-soft-foreground bg-sidebar text-foreground' : 'border-transparent bg-muted text-muted-foreground',
        )}
      >
        {projectInitials(project.name)}
        {/* Top `y = -6px`, bottom `y = 29px` on a 40px mark; the right edge sits at x = 44px. */}
        <SignalPill position="top" segments={top} className={cn(placement, ring)} />
        <SignalPill position="bottom" segments={bottom} className={cn(placement, ring, 'top-[29px]')} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span className="truncate text-[14.5px] leading-tight font-semibold">{project.name}</span>
        <span data-slot="drawer-project-state" className="flex min-w-0 flex-wrap items-center gap-x-[6px] text-[11.5px] leading-tight font-medium text-soft-foreground">
          {!known ? 'activity unknown' : parts.length === 0 ? 'idle' : parts.map((part, index) => (
            <span key={part.tone} className="flex items-center gap-[6px]">
              {index > 0 ? <span aria-hidden="true">·</span> : null}
              <span data-tone={part.tone} className={TONE_TEXT[part.tone]}>{part.text}</span>
            </span>
          ))}
          {known && truncated ? <span>· recent runs only</span> : null}
        </span>
      </span>
      {current ? <CheckIcon aria-hidden="true" className="size-[16px] shrink-0 text-foreground" /> : null}
    </RouterLink>
  )
  if (!current) return link
  // The `…` is a sibling of the link, never nested in the <a>: a button inside an anchor is
  // invalid and would make one tap do both. 44px, and the same menu the desktop header opens.
  return (
    <div data-slot="drawer-project-current" className="flex items-center rounded-[10px] bg-sidebar-row-selected pr-[4px]">
      {link}
      <ProjectMenu projectId={project.id} onNavigate={onNavigate} triggerClassName="size-[44px]" align="end" />
    </div>
  )
}

/** What the drawer's Tools row needs from health: whether something blocks starting a task (the
 *  amber dot) and the forge note, both derived by the container from `toolsBlocker`/`forgeNote`. */
export type DrawerTools = { blocked: boolean; note: string | null }

const ROW_CLASS = 'flex h-[48px] w-full items-center gap-[12px] rounded-[10px] px-[10px] text-[14.5px] font-normal text-foreground hover:bg-sidebar-row-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&_svg]:size-[18px] [&_svg]:shrink-0 [&_svg]:text-soft-foreground'

/** The Projects section and, below a divider, the workspace links. Scrolls with the drawer. */
export function DrawerProjects({ nav, currentProjectId, onNavigate }: {
  nav: MobileProjectNav
  currentProjectId: string | null
  onNavigate: () => void
}) {
  return (
    <div data-slot="drawer-projects" className="shrink-0">
      <div className="px-[18px] pt-[14px] pb-[6px] text-[12px] font-medium text-soft-foreground" id="drawer-projects-label">Projects</div>
      {/* A group, not a `nav`: the drawer has no navigation landmark of its own. */}
      <div role="group" data-slot="drawer-projects-group" aria-labelledby="drawer-projects-label" className="flex flex-col gap-[2px] px-[8px] pb-[8px]">
        {nav.projects.map((project) => (
          <DrawerProjectRow
            key={project.id}
            project={project}
            signal={nav.signals?.get(project.id)}
            known={nav.signals !== null}
            truncated={nav.truncated.has(project.id)}
            current={project.id === currentProjectId}
            onNavigate={onNavigate}
          />
        ))}
      </div>
      {!nav.singleProject ? (
        <div data-slot="drawer-workspace" className="flex flex-col gap-[2px] border-t border-border px-[8px] py-[8px]">
          <RouterLink to="/tasks" onClick={onNavigate} data-slot="drawer-all-projects" className={ROW_CLASS}>
            <LayersIcon aria-hidden="true" />
            All projects · task overview
          </RouterLink>
          <AddProjectMenu
            origin="mobile"
            icon={FolderPlusIcon}
            iconClassName="size-[18px]"
            label="Add project"
            triggerClassName={cn(ROW_CLASS, 'h-[48px] justify-start p-0 px-[10px] text-foreground')}
          />
        </div>
      ) : null}
    </div>
  )
}

/** The bottom rows: Tools, Global settings and the theme cycle. Pinned below the scroll; the home
 *  indicator's inset is theirs, since the drawer runs under it. */
export function DrawerGlobal({ onNavigate, tools }: { onNavigate: () => void; tools?: DrawerTools | null }) {
  const { theme, setTheme } = useTheme()
  const next = NEXT_THEME[theme]
  const label = theme.charAt(0).toUpperCase() + theme.slice(1)
  return (
    <div data-slot="drawer-global" className="flex shrink-0 flex-col gap-[2px] border-t border-border px-[8px] pt-[8px] pb-[max(8px,env(safe-area-inset-bottom))]">
      {tools ? (
        // The desktop footer's Tools dropdown, as a plain row to the page that lists the same
        // probes. /tools does not itself explain a hidden GitHub tab, so the note rides here.
        <RouterLink to="/tools" onClick={onNavigate} data-slot="drawer-tools" className={cn(ROW_CLASS, tools.note && 'h-auto min-h-[48px] py-[6px]')}>
          <span className="relative flex shrink-0">
            <WrenchIcon aria-hidden="true" />
            {tools.blocked ? <StatusDot tone="pending" data-slot="drawer-tools-dot" className="absolute -top-[1px] -right-[2px] size-[6px]" /> : null}
          </span>
          <span className="flex min-w-0 flex-col">
            <span>Tools</span>
            {tools.note ? <span data-slot="drawer-tools-note" className="text-[11.5px] leading-tight text-soft-foreground">{tools.note}</span> : null}
          </span>
        </RouterLink>
      ) : null}
      <RouterLink to="/settings/global" onClick={onNavigate} data-slot="drawer-global-settings" className={ROW_CLASS}>
        <Settings2Icon aria-hidden="true" />
        Global settings
      </RouterLink>
      <button
        type="button"
        data-slot="theme-toggle"
        data-theme-pref={theme}
        aria-label={`Theme: ${theme.toLowerCase()}. Switch to ${next}.`}
        onClick={() => setTheme(next)}
        className={ROW_CLASS}
      >
        <SunMoonIcon aria-hidden="true" />
        Theme · {label}
      </button>
    </div>
  )
}
