import './settings-interiors.css'
import { ChevronRightIcon } from 'lucide-react'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Link as RouterLink, NavLink as RouterNavLink } from 'react-router'
import type { Capabilities } from '@open-mercato/cezar-api-client'
import { Link as ScopedLink, NavLink as ScopedNavLink } from '@/lib/project-router'
import { cn } from '@/lib/utils'
import { ProjectGeneral } from './project-general'
import { ProjectLocationNav } from './project-location'
import { visibleSettingsSections, type SettingsScope, type SettingsSection } from './registry'

/**
 * The registry-driven Settings shell (R6 Step 1.3, spec §"Settings").
 *
 * Layout, both driven by the same `visibleSettingsSections(scope)` so they can never disagree:
 *  - desktop (`md:`): a left section nav beside the section's content;
 *  - mobile: a segmented pill row above the content (the area index renders the stacked
 *    section list instead — the drill-in page small screens expect).
 *
 * ONE shell serves both areas since the multi-project split (step 3.5): project settings at
 * `/p/<projectId>/settings/…` and global settings at `/settings/global/…`. The `scope` prop is
 * the whole difference, and it decides two things:
 *  - which sections the nav lists (the registry's `scope` field), and
 *  - how links are built. Project links are project-relative and go through the SCOPED
 *    `project-router` wrappers, which prefix the active `/p/<id>`. Global links must NOT be
 *    prefixed — `/settings/global/*` lives outside every project — so they use the plain
 *    react-router components. Routing a global link through the scoped wrapper would mint
 *    `/p/<id>/settings/global/appearance`, which is not a route.
 *
 * Every section is its own URL, so the h1 is the SECTION title — that is what the page is
 * about; "Settings" is the area. Hidden registry entries are not routed, so their URLs are
 * honest 404s until the section ships.
 *
 * Both navs lead with a "General" entry pointing at the area INDEX. It is not a registry section
 * — it has no settings of its own — but without it the index is a page you can only reach by
 * arriving: every section links to its siblings and none links back, so the project folder and
 * the cross-link to the other area became unreachable the moment a user clicked anything.
 */

/** The area's URL root — also what `SettingsSkillsRedirect` and the legacy redirects target. */
export function settingsSectionPath(scope: SettingsScope, id: SettingsSection['id']): string {
  return scope === 'global' ? `/settings/global/${id}` : `/settings/${id}`
}

function settingsIndexPath(scope: SettingsScope): string {
  return scope === 'global' ? '/settings/global' : '/settings'
}

/** Global links bypass the project prefix; project links get it. See the header comment. */
function navComponents(scope: SettingsScope) {
  return scope === 'global'
    ? { Link: RouterLink, NavLink: RouterNavLink }
    : { Link: ScopedLink, NavLink: ScopedNavLink }
}

const OVERFLOW_EPSILON_PX = 1
const PILL_EDGE_GUTTER_PX = 12

function revealPill(scroller: HTMLElement, pill: HTMLElement) {
  const scrollerRect = scroller.getBoundingClientRect()
  const pillRect = pill.getBoundingClientRect()
  // Hidden desktop stand-ins and jsdom have no layout. Waiting for a real box also keeps the
  // reveal from guessing before the mobile shell has settled.
  if (scrollerRect.width <= 0 || pillRect.width <= 0) return

  const visibleLeft = scrollerRect.left + PILL_EDGE_GUTTER_PX
  const visibleRight = scrollerRect.right - PILL_EDGE_GUTTER_PX
  let delta = 0
  if (pillRect.left < visibleLeft) delta = pillRect.left - visibleLeft
  else if (pillRect.right > visibleRight) delta = pillRect.right - visibleRight
  if (delta === 0) return

  // Scroll only this horizontal viewport. `scrollIntoView` may also move the page vertically,
  // which is especially disruptive when a deep-linked settings section has restored its scroll.
  const target = scroller.scrollLeft + delta
  const outwardTarget = delta < 0 ? Math.floor(target) : Math.ceil(target)
  scroller.scrollTo({ left: Math.max(0, outwardTarget), behavior: 'auto' })
}

function SectionNav({
  scope,
  activeId,
  capabilities,
}: {
  scope: SettingsScope
  activeId: SettingsSection['id'] | null
  capabilities?: Pick<Capabilities, 'singleProject'>
}) {
  const { NavLink } = navComponents(scope)
  return (
    <nav
      aria-label="Settings sections"
      data-slot="settings-nav"
      data-scope={scope}
      className="hidden w-[180px] shrink-0 flex-col gap-1 md:flex"
    >
      <NavLink
        to={settingsIndexPath(scope)}
        end
        data-slot="settings-nav-index"
        aria-current={activeId === null ? 'page' : undefined}
        className={cn(
          'flex min-h-11 items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors',
          activeId === null
            ? 'bg-accent-strong/10 text-accent-text'
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        )}
      >
        General
      </NavLink>
      {visibleSettingsSections(scope, capabilities).map((section) => (
        <NavLink
          key={section.id}
          to={settingsSectionPath(scope, section.id)}
          data-section={section.id}
          aria-current={section.id === activeId ? 'page' : undefined}
          className={cn(
            'flex min-h-11 items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors',
            section.id === activeId
              ? 'bg-accent-strong/10 text-accent-text'
              : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
          )}
        >
          {section.title}
        </NavLink>
      ))}
      {/* The nav footer answers "what am I editing?" — and each area answers it differently.
          Global: settings are per USER, not per repo, said once where the choice to write there
          is being made. Project: WHICH repo, by its absolute path on disk. */}
      {scope === 'global' ? (
        <p className="mt-auto px-2.5 pt-3 text-[11px] text-soft-foreground">Stored in ~/.cezar</p>
      ) : (
        <ProjectLocationNav />
      )}
    </nav>
  )
}

/** The mobile stand-in for the left nav: one segmented, scrollable pill row. */
function SectionPills({
  scope,
  activeId,
  capabilities,
}: {
  scope: SettingsScope
  activeId: SettingsSection['id']
  capabilities?: Pick<Capabilities, 'singleProject'>
}) {
  const { NavLink } = navComponents(scope)
  const scrollerRef = useRef<HTMLElement>(null)
  const [overflow, setOverflow] = useState({ start: false, end: false })
  const updateOverflow = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const start = scroller.scrollLeft > OVERFLOW_EPSILON_PX
    const end = scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft > OVERFLOW_EPSILON_PX
    setOverflow((current) =>
      current.start === start && current.end === end ? current : { start, end },
    )
  }, [])
  const revealActiveAndUpdateOverflow = useCallback(() => {
    const scroller = scrollerRef.current
    const active = scroller?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!scroller || !active) return
    revealPill(scroller, active)
    updateOverflow()
  }, [updateOverflow])

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    revealActiveAndUpdateOverflow()

    // The viewport changes on resize; pill widths also change with density and font layout.
    // Observe both so a cue never goes stale while the page itself stays mounted.
    const observer = typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(revealActiveAndUpdateOverflow)
    observer?.observe(scroller)
    for (const pill of scroller.children) observer?.observe(pill)
    window.addEventListener('resize', revealActiveAndUpdateOverflow)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', revealActiveAndUpdateOverflow)
    }
  }, [scope, capabilities?.singleProject, revealActiveAndUpdateOverflow])

  useLayoutEffect(() => {
    revealActiveAndUpdateOverflow()
  }, [activeId, revealActiveAndUpdateOverflow])

  return (
    <div className="relative shrink-0 md:hidden">
      <nav
        ref={scrollerRef}
        aria-label="Settings sections"
        data-slot="settings-nav-mobile"
        onScroll={updateOverflow}
        onFocusCapture={(event) => {
          const target = event.target
          if (target instanceof HTMLElement) revealPill(event.currentTarget, target)
        }}
        className="flex gap-1.5 overflow-x-auto border-b border-border px-3 py-2.5"
      >
        {/* Never the active pill: the index is a different route, and reaching it from a section
            is the whole reason this entry exists. */}
        <NavLink
          to={settingsIndexPath(scope)}
          end
          data-slot="settings-nav-index"
          className="inline-flex min-h-11 items-center rounded-full border border-border bg-card px-3 py-1.5 text-[13px] font-medium whitespace-nowrap text-muted-foreground transition-colors"
        >
          General
        </NavLink>
        {visibleSettingsSections(scope, capabilities).map((section) => (
          <NavLink
            key={section.id}
            to={settingsSectionPath(scope, section.id)}
            data-section={section.id}
            aria-current={section.id === activeId ? 'page' : undefined}
            className={cn(
              'inline-flex min-h-11 items-center rounded-full border px-3 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors',
              section.id === activeId
                ? 'border-transparent bg-contrast text-contrast-foreground'
                : 'border-border bg-card text-muted-foreground',
            )}
          >
            {section.title}
          </NavLink>
        ))}
      </nav>
      {/* These stay inside the row's existing 12px padding gutter. Active and focused pills are
          revealed with the same inset, keeping labels and rings clear of the visual cue. */}
      <span
        aria-hidden="true"
        data-slot="settings-overflow-start"
        data-visible={overflow.start}
        className={cn(
          'pointer-events-none absolute inset-y-px left-0 z-10 w-3 bg-gradient-to-r from-background to-transparent',
          !overflow.start && 'hidden',
        )}
      />
      <span
        aria-hidden="true"
        data-slot="settings-overflow-end"
        data-visible={overflow.end}
        className={cn(
          'pointer-events-none absolute inset-y-px right-0 z-10 w-3 bg-gradient-to-l from-background to-transparent',
          !overflow.end && 'hidden',
        )}
      />
    </div>
  )
}

/** One registered section inside the shell — `/p/<id>/settings/<id>` or `/settings/global/<id>`. */
export function SettingsSectionRoute({
  section,
  scope,
  capabilities,
}: {
  section: SettingsSection
  scope: SettingsScope
  capabilities?: Pick<Capabilities, 'singleProject'>
}) {
  const Body = section.component
  return (
    <div
      data-route={scope === 'global' ? `settings-global-${section.id}` : `settings-${section.id}`}
      className="mx-auto flex min-h-full w-full max-w-[calc(var(--measure)+72px)] flex-col gap-[22px] px-[18px] pt-6 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-9"
    >
      {/* Desktop header — below `md` the shell's top bar already says "Settings". The
          breadcrumb is what tells the two areas apart at a glance (mockup: "Global settings"). */}
      <header className="flex shrink-0 flex-col gap-2">
        <h1 className="text-[28px] font-semibold tracking-tight">{scope === 'global' ? 'Global settings' : 'Project settings'}</h1>
        <p className="text-[13px] text-soft-foreground">{scope === 'global' ? 'Preferences for you and this machine, shared by every project.' : 'Configure this project and its agents.'}</p>
        {scope === 'global' ? (
          <span data-slot="settings-scope-chip" className="sr-only">
            Global settings
          </span>
        ) : null}
      </header>
      <div className="flex min-w-0 flex-1 flex-col gap-6 md:flex-row">
        <SectionNav scope={scope} activeId={section.id} capabilities={capabilities} />
        <SectionPills scope={scope} activeId={section.id} capabilities={capabilities} />
        <section className="settings-panel min-w-0 self-start md:flex-1" aria-label={section.title}>
          <h2 className="settings-panel-title">{section.title}</h2>
          <Body />
        </section>
      </div>
    </div>
  )
}

/** The area's index: the same registry rendered as a stacked list of cards (the mobile drill-in
 *  page; on desktop it sits beside the nav as a plain directory). */
export function SettingsIndexRoute({ scope, capabilities }: {
  scope: SettingsScope
  capabilities?: Pick<Capabilities, 'singleProject'>
}) {
  const { Link } = navComponents(scope)
  const global = scope === 'global'
  return (
    <div data-route={global ? 'settings-global' : 'settings'} className="mx-auto flex min-h-full w-full max-w-[calc(var(--measure)+72px)] flex-col gap-[22px] px-[18px] pt-6 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-9">
      <header className="flex shrink-0 flex-col gap-2">
        <h1 className="text-[28px] font-semibold tracking-tight">{global ? 'Global settings' : 'Project settings'}</h1>
        <p className="text-[13px] text-soft-foreground">
          {global
            ? 'Preferences for you and this machine, shared by every project.'
            : 'Configure this project and its agents.'}
        </p>
      </header>
      <div className="flex min-w-0 flex-1 flex-col gap-6 md:flex-row">
        <SectionNav scope={scope} activeId={null} capabilities={capabilities} />
        {/* No second h1 for small screens: the app shell's mobile top bar already titles the
            page "Settings" from the nav registry. */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* The project area's index is a PAGE, not a menu: the folder, the registry facts, the
              concurrency ceiling and Remove. The global area has no such dashboard — nothing about
              the machine is per-project — so there the cards are the whole page.
              `capabilities` travels because the registry half of that page is exactly what
              single-project mode disables, the same gate `visibleSettingsSections` applies. */}
          {global ? <section className="mb-5 rounded-lg border border-border bg-card p-5"><span className="inline-flex rounded bg-accent-strong/10 px-2 py-1 text-[11px] text-accent-text">Stored locally · ~/.cezar</span><p className="mt-4 text-[13px] text-muted-foreground">Changes here apply across every connected project. Agent instructions and worktree settings remain project-specific.</p></section> : <ProjectGeneral capabilities={capabilities} />}
          <ul
            data-slot="settings-index"
            className={cn(
              'flex w-full flex-col gap-5',
              // On desktop the left nav already lists every section, so in the project area the
              // cards would be the same menu twice. Small screens have no nav — there they ARE it.
              global ? null : 'mt-7 md:hidden',
            )}
          >
            {visibleSettingsSections(scope, capabilities).map((section) => (
              <li key={section.id}>
                <Link
                  to={settingsSectionPath(scope, section.id)}
                  data-section={section.id}
                  className="flex items-center gap-3.5 rounded-lg border border-border bg-card p-4 transition-colors hover:bg-card-2"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center text-accent-text">
                    <section.icon aria-hidden="true" className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">{section.title}</span>
                    <span className="block text-xs text-soft-foreground">{section.description}</span>
                  </span>
                  <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-soft-foreground" />
                </Link>
              </li>
            ))}
          </ul>
          {/* The cross-link between the two areas, both ways: the split is only discoverable if
              each half says where the other one is. */}
          <p className="mt-5 w-full text-[12px] text-soft-foreground">
            {global ? (
              <>Agents, worktrees, bookmarklets and prompt templates are per project.</>
            ) : (
              <>
                Appearance, notifications, host resources and the project registry live in{' '}
                <RouterLink
                  to={settingsIndexPath('global')}
                  data-slot="settings-global-link"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Global settings
                </RouterLink>
                .
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  )
}
