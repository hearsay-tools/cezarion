import './settings-interiors.css'
import { ChevronDownIcon, ChevronRightIcon } from '@/components/design-icons'

import { Link as RouterLink, NavLink as RouterNavLink } from 'react-router'
import type { Capabilities } from '@open-mercato/cezar-api-client'
import { useActiveProjectIdentity } from '@/components/sidebar-project-header'
import { Link as ScopedLink, NavLink as ScopedNavLink } from '@/lib/project-router'
import { ProjectGeneral } from './project-general'
import { visibleSettingsSections, type SettingsScope, type SettingsSection } from './registry'

/**
 * The registry-driven Settings shell (R6 Step 1.3, spec §"Settings").
 *
 * Layout, both driven by the same `visibleSettingsSections(scope)` so they can never disagree:
 *  - desktop (`md:`): section navigation lives in the app sidebar;
 *  - mobile: a section disclosure above the content (the area index renders the stacked
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
 * The PROJECT area leads both navs (sidebar and mobile disclosure) with a "General" entry
 * pointing at its index, the project dashboard (`ProjectGeneral`). It is not a registry section,
 * but without it the index is a page you can only reach by arriving: every section links to its
 * siblings and none links back.
 *
 * The GLOBAL area has no index page. Its old one only explained what "global" means, which the
 * sidebar's two scope groups now say on every settings page, so `/settings/global` redirects to
 * `GLOBAL_SETTINGS_HOME` and every global entry point (rail, mobile drawer, cross-link) links
 * there directly.
 */

/** The area's URL root — also what `SettingsSkillsRedirect` and the legacy redirects target. */
export function settingsSectionPath(scope: SettingsScope, id: SettingsSection['id']): string {
  return scope === 'global' ? `/settings/global/${id}` : `/settings/${id}`
}

/** Where "Global settings" lands: the area has no index page of its own (header comment). */
export const GLOBAL_SETTINGS_HOME = settingsSectionPath('global', 'appearance')

/** Global links bypass the project prefix; project links get it. See the header comment. */
function navComponents(scope: SettingsScope) {
  return scope === 'global'
    ? { Link: RouterLink, NavLink: RouterNavLink }
    : { Link: ScopedLink, NavLink: ScopedNavLink }
}

/**
 * The Settings main header (board "Main header"): one line, "<Section> · <project>" — or
 * "· every project" in the global area, the same scope words the sidebar's group labels use.
 * Desktop only; below `md` the route keeps its own "Project settings"/"Global settings" title.
 * One h1 carries both so the page keeps a single heading; `display:none` drops the other
 * from the accessible name.
 */
function SettingsMainHeader({ scope, title, mobileTitle }: { scope: SettingsScope; title: string; mobileTitle: string }) {
  // The same name the sidebar header shows; an unregistered boot project falls back to its root.
  const projectName = useActiveProjectIdentity().name
  const where = scope === 'global' ? 'every project' : (projectName ?? 'this project')
  return (
    <header data-slot="settings-main-header" className="settings-route-header flex shrink-0 flex-col gap-2">
      <h1 className="text-[15px] font-semibold tracking-normal max-md:text-[24px] max-md:font-normal">
        <span className="md:hidden">{mobileTitle}</span>
        <span className="max-md:hidden">{title} · {where}</span>
      </h1>
      {scope === 'global' ? (
        <span data-slot="settings-scope-chip" className="sr-only">
          Global settings
        </span>
      ) : null}
    </header>
  )
}

/** Mobile sections use the reference's single disclosure, with ordinary scoped links. */
function SectionPills({ scope, activeId, capabilities }: {
  scope: SettingsScope
  activeId: SettingsSection['id'] | null
  capabilities?: Pick<Capabilities, 'singleProject'>
}) {
  const { NavLink } = navComponents(scope)
  const sections = visibleSettingsSections(scope, capabilities)
  return (
    <details key={`${scope}-${activeId}`} className="settings-section-picker md:hidden">
      <summary>
        {sections.find((section) => section.id === activeId)?.title ?? 'General'}
        <ChevronDownIcon aria-hidden="true" className="size-5 text-muted-foreground" />
      </summary>
      <nav aria-label="Settings sections" data-slot="settings-nav-mobile" data-scope={scope}>
        {scope === 'project' ? <NavLink to="/settings" end data-slot="settings-nav-index">General</NavLink> : null}
        {sections.map((section) => (
          <NavLink key={section.id} to={settingsSectionPath(scope, section.id)} data-section={section.id}>
            {section.title}
          </NavLink>
        ))}
      </nav>
    </details>
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
      className="settings-route mx-auto flex min-h-full w-full flex-col"
    >
      <SettingsMainHeader
        scope={scope}
        title={section.title}
        mobileTitle={scope === 'global' ? 'Global settings' : 'Project settings'}
      />
      <div className="settings-route-body flex min-w-0 flex-1 flex-col md:flex-row">
        <SectionPills scope={scope} activeId={section.id} capabilities={capabilities} />
        <section className="settings-panel min-w-0 self-start md:flex-1" aria-label={section.title}>
          <h2 className="settings-panel-title">{section.title}</h2>
          <Body />
        </section>
      </div>
    </div>
  )
}

/** The project area's index, General: the project dashboard plus, on small screens, the registry
 *  as a stacked list of cards (the mobile drill-in page; desktop navigation lives in the app
 *  sidebar). The global area has none — see the header comment. */
export function SettingsIndexRoute({ capabilities }: {
  capabilities?: Pick<Capabilities, 'singleProject'>
}) {
  return (
    <div data-route="settings" className="settings-route mx-auto flex min-h-full w-full flex-col">
      <SettingsMainHeader scope="project" title="General" mobileTitle="Project settings" />
      <div className="settings-route-body flex min-w-0 flex-1 flex-col md:flex-row">
        <SectionPills scope="project" activeId={null} capabilities={capabilities} />
        {/* No second h1 for small screens: the app shell's mobile top bar already titles the
            page "Settings" from the nav registry. */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* The index is a PAGE, not a menu: the folder, the registry facts, the concurrency
              ceiling and Remove. `capabilities` travels because the registry half of that page
              is exactly what single-project mode disables, the same gate
              `visibleSettingsSections` applies. */}
          <ProjectGeneral capabilities={capabilities} />
          <h2 className="settings-other-title mt-6 rounded-t-lg border border-b-0 border-border bg-card px-5 pt-5 text-base font-semibold md:hidden">Other project settings</h2>
          <ul
            data-slot="settings-index"
            className="mt-7 flex w-full flex-col gap-5 md:hidden"
          >
            {visibleSettingsSections('project', capabilities).map((section) => (
              <li key={section.id}>
                <ScopedLink
                  to={settingsSectionPath('project', section.id)}
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
                </ScopedLink>
              </li>
            ))}
          </ul>
          {/* The cross-link out of the project area: the split is only discoverable if it says
              where the other half is. */}
          <p className="mt-5 w-full text-[12px] text-soft-foreground">
            Appearance, notifications, host resources and the project registry live in{' '}
            <RouterLink
              to={GLOBAL_SETTINGS_HOME}
              data-slot="settings-global-link"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Global settings
            </RouterLink>
            .
          </p>
        </div>
      </div>
    </div>
  )
}
