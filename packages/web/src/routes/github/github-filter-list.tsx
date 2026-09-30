import { CircleDashed, Eye } from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

import {
  BotIcon, ChevronRightIcon, CircleDotIcon, CircleXIcon, GitPullRequestIcon, UserRoundIcon,
} from '@/components/design-icons'
import {
  SCREEN_LIST_CHEVRON_CLASS, SCREEN_LIST_COUNT_CLASS, SCREEN_LIST_GROUP_CLASS, SCREEN_LIST_GROUP_LABEL_CLASS,
  SCREEN_LIST_ICON_CLASS, SCREEN_LIST_ROW_CLASS, SIDEBAR_LIST_COUNT_CLASS, SIDEBAR_LIST_GROUP_CLASS,
  SIDEBAR_LIST_GROUP_LABEL_CLASS, SIDEBAR_LIST_ICON_CLASS, SIDEBAR_LIST_ROW_CLASS, SIDEBAR_LIST_ROW_HOVER_CLASS,
  SIDEBAR_SELECTED_CLASS,
} from '@/components/nav-row-styles'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import {
  ISSUE_ROWS, PR_ROWS, countTitle, filterForRow, formatCount, githubFilterPath,
  type GithubRowId,
} from './github-sidebar-model'
import type { useGithubFilterModel } from './use-github-filter-model'

type Model = ReturnType<typeof useGithubFilterModel>

const ICONS: Record<GithubRowId, ComponentType<SVGProps<SVGSVGElement>>> = {
  assigned: UserRoundIcon,
  'no-task': CircleDashed,
  'has-task': BotIcon,
  all: CircleDotIcon,
  review: Eye,
  mine: GitPullRequestIcon,
  failing: CircleXIcon,
  'all-prs': CircleDotIcon,
}

/** Why a row cannot be opened at all. Loading and failed SEARCHES are not reasons: the list says
 *  those itself. */
function disabledReason(id: GithubRowId, blocked: Model['blocked']): string | null {
  if (id === 'assigned' || id === 'mine') return blocked.identity
  if (id === 'no-task' || id === 'has-task') return blocked.tasks
  return null
}

/**
 * The two filter groups, shared by the desktop sidebar (`variant="sidebar"`, 32px rows) and the
 * phone's filter screen (`variant="screen"`, 48px rows with chevrons). `activeId` lights one row
 * (`aria-current="page"`); the screen passes none.
 */
export function GithubFilterList({ model, variant, activeId, onNavigate }: {
  model: Model
  variant: 'sidebar' | 'screen'
  activeId?: GithubRowId | null
  onNavigate?: () => void
}) {
  const screen = variant === 'screen'
  const groups = [
    { key: 'issues', label: 'Issues', rows: ISSUE_ROWS },
    { key: 'prs', label: 'Pull requests', rows: PR_ROWS },
  ] as const
  return (
    <>
      {groups.map((group) => (
        <nav key={group.key} aria-label={group.label} data-slot="github-filter-group" data-group={group.key} className={screen ? SCREEN_LIST_GROUP_CLASS : SIDEBAR_LIST_GROUP_CLASS}>
          <h3 className={screen ? SCREEN_LIST_GROUP_LABEL_CLASS : SIDEBAR_LIST_GROUP_LABEL_CLASS}>{group.label}</h3>
          {group.rows.map(({ id, label }) => {
            const Icon = ICONS[id]
            const active = activeId === id
            const reason = disabledReason(id, model.blocked)
            const count = model.counts[id]
            const text = formatCount(count)
            const className = cn(
              // The final board sets the sidebar label at 12.5px; the shared row class still says 13.
              screen ? SCREEN_LIST_ROW_CLASS : cn(SIDEBAR_LIST_ROW_CLASS, 'text-[12.5px]'),
              reason ? 'cursor-not-allowed opacity-60' : SIDEBAR_LIST_ROW_HOVER_CLASS,
              active && SIDEBAR_SELECTED_CLASS,
            )
            const content = (
              <>
                <Icon aria-hidden="true" className={screen ? SCREEN_LIST_ICON_CLASS : SIDEBAR_LIST_ICON_CLASS} />
                <span className="truncate">{label}</span>
                {text ? (
                  <span data-slot="gh-filter-count" title={countTitle(id, count)} className={screen ? SCREEN_LIST_COUNT_CLASS : SIDEBAR_LIST_COUNT_CLASS}>{text}</span>
                ) : null}
                {screen ? <ChevronRightIcon aria-hidden="true" className={cn(SCREEN_LIST_CHEVRON_CLASS, !text && 'ml-auto')} /> : null}
              </>
            )
            if (reason) {
              return (
                <div key={id} data-gh-filter={id} aria-disabled="true" title={reason} className={className}>
                  {content}
                  <span className="sr-only">{reason}</span>
                </div>
              )
            }
            const { view, filter } = filterForRow(id)
            return (
              <Link key={id} to={githubFilterPath(view, filter)} data-gh-filter={id} aria-current={active ? 'page' : undefined} onClick={onNavigate} className={className}>
                {content}
              </Link>
            )
          })}
        </nav>
      ))}
    </>
  )
}
