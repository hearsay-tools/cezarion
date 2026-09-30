import { DiffStatLabel } from '@/components/diff-stat'
import { ChevronRightIcon } from '@/components/design-icons'
import {
  SCREEN_LIST_CHEVRON_CLASS, SCREEN_LIST_GROUP_CLASS, SCREEN_LIST_GROUP_LABEL_CLASS, SIDEBAR_LIST_GROUP_CLASS,
  SIDEBAR_LIST_GROUP_LABEL_CLASS, SIDEBAR_LIST_ROW_HOVER_CLASS,
} from '@/components/nav-row-styles'
import { StatusDot } from '@/components/status-dot'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import type { WorktreeRow } from './git-worktree-model'
import type { useGitWorktreeModel } from './use-git-worktree-model'

/** The board's Sidebar / Task row: 6px 8px 6px 10px, 10px between the dot slot, the text and the trailing slot. */
export const GIT_TWO_LINE_ROW_CLASS = 'group flex items-center gap-[10px] rounded-[6px] py-[6px] pr-[8px] pl-[10px] text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring'

type Model = ReturnType<typeof useGitWorktreeModel>

/**
 * The Task worktrees group, shared by the desktop sidebar (`variant="sidebar"`, 49px two-line rows) and the
 * phone's worktree screen (`variant="screen"`, 56px rows with chevrons). Each row is a native
 * link to that task's Changes tab: leading status dot, mono branch, then a soft `title · +adds −dels` line.
 */
export function GitWorktreeList({ model, variant, onNavigate }: {
  model: Model
  variant: 'sidebar' | 'screen'
  onNavigate?: () => void
}) {
  const screen = variant === 'screen'
  const count = !model.loading && model.error === null && model.rows ? model.rows.length : null
  return (
    <nav aria-label="Task worktrees" data-slot="git-worktree-list" className={screen ? SCREEN_LIST_GROUP_CLASS : SIDEBAR_LIST_GROUP_CLASS}>
      <h3 className={screen ? SCREEN_LIST_GROUP_LABEL_CLASS : SIDEBAR_LIST_GROUP_LABEL_CLASS}>
        Task worktrees
        {count !== null ? <span data-slot="git-worktree-count" className="ml-1.5 font-normal tabular-nums">{count}</span> : null}
      </h3>
      {model.loading ? (
        <p data-slot="git-worktree-loading" role="status" className="px-2.5 py-2 text-xs text-soft-foreground">Loading worktrees…</p>
      ) : model.error !== null ? (
        <p data-slot="git-worktree-error" role="alert" className="px-2.5 py-2 text-xs text-danger">Could not load worktrees: {model.error}</p>
      ) : model.rows!.length === 0 ? (
        <p data-slot="git-worktree-empty" className="px-2.5 py-2 text-xs text-soft-foreground">No task worktrees on disk</p>
      ) : (
        model.rows!.map((row) => <WorktreeItem key={row.runId} row={row} screen={screen} onNavigate={onNavigate} />)
      )}
    </nav>
  )
}

function WorktreeItem({ row, screen, onNavigate }: { row: WorktreeRow; screen: boolean; onNavigate?: () => void }) {
  const { attention } = row
  return (
    <Link
      to={row.to}
      data-slot="git-worktree-row"
      data-run-id={row.runId}
      title={row.title}
      onClick={onNavigate}
      className={cn(GIT_TWO_LINE_ROW_CLASS, SIDEBAR_LIST_ROW_HOVER_CLASS, screen ? 'h-[56px]' : 'h-[49px]')}
    >
      <span className="flex min-w-0 flex-1 items-start gap-[10px]">
        {/* As tall as the branch line (the board's 19px title line), so the dot centres on it, not on the row. */}
        <span className="flex h-[19px] w-[12px] shrink-0 items-center justify-center">
          <StatusDot tone={attention.tone} shape={attention.shape} pulse={attention.pulse} aria-label={attention.label} title={attention.label} role="img" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span
            data-slot="git-worktree-branch"
            className={cn('truncate font-mono text-[12px] leading-[19px]', row.branch === null && 'font-sans italic text-soft-foreground')}
          >
            {row.branch ?? 'no branch recorded'}
          </span>
          <span data-slot="git-worktree-meta" className="flex min-w-0 items-center text-[11.5px] leading-[17px] text-soft-foreground">
            <span className="truncate">{row.title}</span>
            {row.diff ? (
              <>
                <span aria-hidden="true" className="shrink-0 whitespace-pre"> · </span>
                <DiffStatLabel stat={row.diff} compact className="shrink-0 font-sans text-[11.5px] font-normal [&>span]:text-inherit" />
              </>
            ) : null}
          </span>
        </span>
      </span>
      {screen ? <ChevronRightIcon aria-hidden="true" className={SCREEN_LIST_CHEVRON_CLASS} /> : <span aria-hidden="true" className="w-[16px] shrink-0" />}
    </Link>
  )
}
