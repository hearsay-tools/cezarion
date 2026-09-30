import { NavLink } from 'react-router'
import type { Capabilities } from '@open-mercato/cezar-api-client'
import { SettingsIcon } from '@/components/design-icons'
import { SIDEBAR_SELECTED_CLASS } from '@/components/nav-row-styles'
import { cn } from '@/lib/utils'
import { visibleSettingsSections, type SettingsScope } from './registry'

/** Desktop view navigation; mobile keeps its section disclosure and index cards. */
export function SettingsSidebar({ projectId, projectName, capabilities }: {
  projectId: string
  projectName: string | null
  capabilities?: Pick<Capabilities, 'singleProject'>
}) {
  return (
    <div data-slot="settings-sidebar" className="px-2 pt-4">
      <h2 className="px-2.5 pb-4 text-[13px] font-semibold">Settings</h2>
      {(['project', 'global'] as const).map((scope: SettingsScope) => {
        const label = scope === 'project' ? `This project${projectName ? ` · ${projectName}` : ''}` : 'Global · every project'
        const root = scope === 'project' ? `/p/${encodeURIComponent(projectId)}/settings` : '/settings/global'
        const entries = [
          { id: 'general', title: 'General', icon: SettingsIcon, to: root },
          ...visibleSettingsSections(scope, capabilities).map((section) => ({ ...section, to: `${root}/${section.id}` })),
        ]
        return (
          <nav key={scope} aria-label={label} data-slot="settings-nav" data-scope={scope} className="mb-5">
            <h3 title={label} className="truncate px-2.5 pb-1.5 text-[11px] font-medium text-soft-foreground">{label}</h3>
            {entries.map(({ id, title, icon: Icon, to }) => (
              <NavLink
                key={id}
                to={to}
                end
                data-section={id === 'general' ? undefined : id}
                data-slot={id === 'general' ? 'settings-nav-index' : undefined}
                className={({ isActive }) => cn(
                  'group flex h-[32px] items-center gap-[10px] rounded-[6px] px-[10px] text-[13px] text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
                  isActive && SIDEBAR_SELECTED_CLASS,
                )}
              >
                <Icon aria-hidden="true" className="size-[15px] shrink-0 text-soft-foreground group-aria-[current=page]:text-foreground" />
                <span className="truncate">{title}</span>
              </NavLink>
            ))}
          </nav>
        )
      })}
    </div>
  )
}
