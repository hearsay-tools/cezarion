import type { ComponentType, SVGProps } from 'react'

import {
  ChevronRightIcon, CircleDotIcon, CircleIcon, CircleSlashIcon, CircleXIcon, FileSearchIcon,
  GitPullRequestIcon, ListTodoIcon, UserRoundIcon,
} from '@/components/design-icons'
import { SIDEBAR_SELECTED_CLASS } from '@/components/nav-row-styles'
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
  'no-task': CircleSlashIcon,
  'has-task': ListTodoIcon,
  all: CircleDotIcon,
  review: FileSearchIcon,
  mine: UserRoundIcon,
  failing: CircleXIcon,
  'all-prs': GitPullRequestIcon,
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
        <nav key={group.key} aria-label={group.label} data-slot="github-filter-group" data-group={group.key} className={screen ? 'mb-6' : 'mb-5'}>
          <h3 className={cn('px-2.5 pb-1.5 text-[11px] font-medium text-soft-foreground', screen && 'px-1 pb-2')}>{group.label}</h3>
          {group.rows.map(({ id, label }) => {
            const Icon = ICONS[id]
            const active = activeId === id
            const reason = disabledReason(id, model.blocked)
            const count = model.counts[id]
            const text = formatCount(count)
            const className = cn(
              'group flex items-center rounded-[6px] text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring',
              screen ? 'h-12 gap-[10px] px-[10px] text-[15px]' : 'h-[32px] gap-[10px] px-[10px] text-[13px]',
              reason ? 'cursor-not-allowed opacity-60' : 'hover:bg-sidebar-row-hover hover:text-foreground',
              active && SIDEBAR_SELECTED_CLASS,
            )
            const content = (
              <>
                <Icon aria-hidden="true" className={cn('shrink-0 text-soft-foreground group-aria-[current=page]:text-foreground', screen ? 'size-[18px]' : 'size-[15px]')} />
                <span className="truncate">{label}</span>
                {text ? (
                  <span data-slot="gh-filter-count" title={countTitle(id, count)} className="ml-auto text-[11.5px] tabular-nums text-soft-foreground">{text}</span>
                ) : null}
                {screen ? <ChevronRightIcon aria-hidden="true" className={cn('size-[18px] shrink-0 text-soft-foreground', text ? '' : 'ml-auto')} /> : null}
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
