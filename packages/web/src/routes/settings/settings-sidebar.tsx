import { NavLink } from 'react-router'
import type { Capabilities } from '@open-mercato/cezar-api-client'
import {
  SIDEBAR_LIST_BODY_CLASS, SIDEBAR_LIST_GROUP_LABEL_CLASS, SIDEBAR_LIST_ICON_CLASS, SIDEBAR_LIST_ROW_CLASS, SIDEBAR_LIST_ROW_HOVER_CLASS, SIDEBAR_SELECTED_CLASS,
} from '@/components/nav-row-styles'
import { SettingsIcon } from '@/components/design-icons'
import { cn } from '@/lib/utils'
import { visibleSettingsSections, type SettingsScope } from './registry'

/**
 * Desktop view navigation; mobile keeps its section disclosure and index cards.
 *
 * Board "Screen · Settings view, sections": the body is the two groups and nothing else — no
 * "Settings" heading (the view tab above already says it). 12px body padding, 12px between
 * groups (the second group adds 6px of its own), rows and labels as the shared list styles.
 *
 * Deviation from the board, by owner request: the project group leads with a "General" row for
 * the project index (`ProjectGeneral`), which was otherwise reachable only through the Settings
 * tab. The global group has no such row because the global area has no index page.
 */
export function SettingsSidebar({ projectId, projectName, capabilities }: {
  projectId: string
  projectName: string | null
  capabilities?: Pick<Capabilities, 'singleProject'>
}) {
  return (
    <div data-slot="settings-sidebar" className={SIDEBAR_LIST_BODY_CLASS}>
      {(['project', 'global'] as const).map((scope: SettingsScope) => {
        const label = scope === 'project' ? `This project${projectName ? ` · ${projectName}` : ''}` : 'Global · every project'
        const root = scope === 'project' ? `/p/${encodeURIComponent(projectId)}/settings` : '/settings/global'
        const sections = visibleSettingsSections(scope, capabilities).map((section) => ({ id: section.id, title: section.title, icon: section.icon, to: `${root}/${section.id}` }))
        const entries = scope === 'project' ? [{ id: 'general', title: 'General', icon: SettingsIcon, to: root }, ...sections] : sections
        return (
          <nav key={scope} aria-label={label} data-slot="settings-nav" data-scope={scope} className={cn('flex flex-col gap-px', scope === 'global' && 'pt-[6px]')}>
            <h3 title={label} className={SIDEBAR_LIST_GROUP_LABEL_CLASS}>{label}</h3>
            {entries.map(({ id, title, icon: Icon, to }) => (
              <NavLink
                key={id}
                to={to}
                end
                data-section={id}
                className={({ isActive }) => cn(SIDEBAR_LIST_ROW_CLASS, SIDEBAR_LIST_ROW_HOVER_CLASS, isActive && SIDEBAR_SELECTED_CLASS)}
              >
                <Icon aria-hidden="true" className={SIDEBAR_LIST_ICON_CLASS} />
                <span className="truncate">{title}</span>
              </NavLink>
            ))}
          </nav>
        )
      })}
    </div>
  )
}
