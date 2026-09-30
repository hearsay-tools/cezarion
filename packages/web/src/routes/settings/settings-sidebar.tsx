import { NavLink } from 'react-router'
import type { Capabilities } from '@open-mercato/cezar-api-client'
import {
  SIDEBAR_LIST_GROUP_LABEL_CLASS, SIDEBAR_LIST_ICON_CLASS, SIDEBAR_LIST_ROW_CLASS, SIDEBAR_LIST_ROW_HOVER_CLASS, SIDEBAR_SELECTED_CLASS,
} from '@/components/nav-row-styles'
import { cn } from '@/lib/utils'
import { visibleSettingsSections, type SettingsScope } from './registry'

/**
 * Desktop view navigation; mobile keeps its section disclosure and index cards.
 *
 * Board "Screen · Settings view, sections": the body is the two groups and nothing else — no
 * "Settings" heading (the view tab above already says it) and no "General" row. The area index
 * is reached through that Settings tab. 12px body padding, 12px between groups (the second
 * group adds 6px of its own), rows and labels as the shared list styles.
 */
export function SettingsSidebar({ projectId, projectName, capabilities }: {
  projectId: string
  projectName: string | null
  capabilities?: Pick<Capabilities, 'singleProject'>
}) {
  return (
    <div data-slot="settings-sidebar" className="flex flex-col gap-[12px] p-[12px]">
      {(['project', 'global'] as const).map((scope: SettingsScope) => {
        const label = scope === 'project' ? `This project${projectName ? ` · ${projectName}` : ''}` : 'Global · every project'
        const root = scope === 'project' ? `/p/${encodeURIComponent(projectId)}/settings` : '/settings/global'
        const entries = visibleSettingsSections(scope, capabilities).map((section) => ({ ...section, to: `${root}/${section.id}` }))
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
