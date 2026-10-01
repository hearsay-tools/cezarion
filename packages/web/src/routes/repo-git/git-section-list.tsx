import { BrushIcon } from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

import { ChevronRightIcon, GitBranchIcon, GitCommitHorizontalIcon } from '@/components/design-icons'
import {
  SCREEN_LIST_CHEVRON_CLASS, SCREEN_LIST_COUNT_CLASS, SCREEN_LIST_GROUP_CLASS, SCREEN_LIST_ICON_CLASS,
  SCREEN_LIST_ROW_CLASS, SIDEBAR_LIST_COUNT_CLASS, SIDEBAR_LIST_ICON_CLASS, SIDEBAR_LIST_ROW_CLASS,
  SIDEBAR_LIST_ROW_HOVER_CLASS, SIDEBAR_LIST_UNLABELLED_GROUP_CLASS, SIDEBAR_SELECTED_CLASS,
} from '@/components/nav-row-styles'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { GIT_PHONE_MAIN_PATH, GIT_SECTION_PATH, type GitSection } from './git-sections'

export type GitListSection = Exclude<GitSection, 'changes'>

const ICONS: Record<GitListSection, ComponentType<SVGProps<SVGSVGElement>>> = {
  main: GitCommitHorizontalIcon,
  cleanup: BrushIcon,
  branches: GitBranchIcon,
}

/** The section row's label. Recently on names the checked-out branch, because that is the log it
 *  shows; before the repository answers it is plainly "Recent commits". */
export function gitSectionLabel(section: GitSection, branch: string | null): string {
  switch (section) {
    case 'main': return branch ? `Recently on ${branch}` : 'Recent commits'
    case 'cleanup': return 'Cleanup'
    case 'branches': return 'All branches'
    case 'changes': return 'Uncommitted changes'
  }
}

/** The order the board draws them in. Not landed sits between main and Cleanup once issue 08 ships it. */
const ORDER: readonly GitListSection[] = ['main', 'cleanup', 'branches']

/**
 * The Git sections (issue 06 §3), shared by the desktop sidebar (`variant="sidebar"`, 32px rows,
 * the open section lit) and the phone Git screen (`variant="screen"`, 48px rows with chevrons).
 * A null count draws nothing: unknown is never shown as zero.
 */
export function GitSectionList({ branch, counts, variant, active, onNavigate }: {
  branch: string | null
  counts: Record<GitListSection, string | null>
  variant: 'sidebar' | 'screen'
  active?: GitSection | null
  onNavigate?: () => void
}) {
  const screen = variant === 'screen'
  return (
    <nav aria-label="Git sections" data-slot="git-sections" className={screen ? SCREEN_LIST_GROUP_CLASS : SIDEBAR_LIST_UNLABELLED_GROUP_CLASS}>
      {ORDER.map((section) => {
        const Icon = ICONS[section]
        const current = !screen && active === section
        const count = counts[section]
        return (
          <Link
            key={section}
            to={screen && section === 'main' ? GIT_PHONE_MAIN_PATH : GIT_SECTION_PATH[section]}
            data-git-section={section}
            aria-current={current ? 'page' : undefined}
            onClick={onNavigate}
            className={cn(
              // The final board sets the sidebar label at 12.5px; the shared row class still says 13.
              screen ? SCREEN_LIST_ROW_CLASS : cn(SIDEBAR_LIST_ROW_CLASS, 'text-[12.5px]'),
              SIDEBAR_LIST_ROW_HOVER_CLASS,
              current && SIDEBAR_SELECTED_CLASS,
            )}
          >
            <Icon aria-hidden="true" className={screen ? SCREEN_LIST_ICON_CLASS : SIDEBAR_LIST_ICON_CLASS} />
            <span className="min-w-0 flex-1 truncate">{gitSectionLabel(section, branch)}</span>
            {count ? (
              <span data-slot="git-section-count" className={screen ? SCREEN_LIST_COUNT_CLASS : SIDEBAR_LIST_COUNT_CLASS}>{count}</span>
            ) : null}
            {screen ? <ChevronRightIcon aria-hidden="true" className={SCREEN_LIST_CHEVRON_CLASS} /> : null}
          </Link>
        )
      })}
    </nav>
  )
}
