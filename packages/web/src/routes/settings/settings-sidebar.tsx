import { NavLink } from 'react-router'
import type { Capabilities } from '@open-mercato/cezar-api-client'
import { SettingsIcon } from '@/components/design-icons'
import {
  SIDEBAR_LIST_BODY_CLASS, SIDEBAR_LIST_GROUP_CLASS, SIDEBAR_LIST_GROUP_LABEL_CLASS, SIDEBAR_LIST_HEADING_CLASS,
  SIDEBAR_LIST_ICON_CLASS, SIDEBAR_LIST_ROW_CLASS, SIDEBAR_LIST_ROW_HOVER_CLASS, SIDEBAR_SELECTED_CLASS,
} from '@/components/nav-row-styles'
import { cn } from '@/lib/utils'
import { visibleSettingsSections, type SettingsScope } from './registry'

/** Desktop view navigation; mobile keeps its section disclosure and index cards. */
export function SettingsSidebar({ projectId, projectName, capabilities }: {
  projectId: string
  projectName: string | null
  capabilities?: Pick<Capabilities, 'singleProject'>
}) {
  return (
    <div data-slot="settings-sidebar" className={SIDEBAR_LIST_BODY_CLASS}>
      <h2 className={SIDEBAR_LIST_HEADING_CLASS}>Settings</h2>
      {(['project', 'global'] as const).map((scope: SettingsScope) => {
        const label = scope === 'project' ? `This project${projectName ? ` · ${projectName}` : ''}` : 'Global · every project'
        const root = scope === 'project' ? `/p/${encodeURIComponent(projectId)}/settings` : '/settings/global'
        const entries = [
          { id: 'general', title: 'General', icon: SettingsIcon, to: root },
          ...visibleSettingsSections(scope, capabilities).map((section) => ({ ...section, to: `${root}/${section.id}` })),
        ]
        return (
          <nav key={scope} aria-label={label} data-slot="settings-nav" data-scope={scope} className={SIDEBAR_LIST_GROUP_CLASS}>
            <h3 title={label} className={SIDEBAR_LIST_GROUP_LABEL_CLASS}>{label}</h3>
            {entries.map(({ id, title, icon: Icon, to }) => (
              <NavLink
                key={id}
                to={to}
                end
                data-section={id === 'general' ? undefined : id}
                data-slot={id === 'general' ? 'settings-nav-index' : undefined}
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
