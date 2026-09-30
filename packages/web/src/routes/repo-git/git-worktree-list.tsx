import { DiffStatLabel } from '@/components/diff-stat'
import { ChevronRightIcon } from '@/components/design-icons'
import { StatusDot } from '@/components/status-dot'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import type { WorktreeRow } from './git-worktree-model'
import type { useGitWorktreeModel } from './use-git-worktree-model'

type Model = ReturnType<typeof useGitWorktreeModel>

/**
 * The Task worktrees group, shared by the desktop sidebar (`variant="sidebar"`, 32px rows) and the
 * phone's worktree screen (`variant="screen"`, 48px rows with chevrons). Each row is a native
 * link to that task's Changes tab: leading status dot, mono branch, then the task title and diff.
 */
export function GitWorktreeList({ model, variant, onNavigate }: {
  model: Model
  variant: 'sidebar' | 'screen'
  onNavigate?: () => void
}) {
  const screen = variant === 'screen'
  return (
    <nav aria-label="Task worktrees" data-slot="git-worktree-list" className={screen ? 'mb-6' : 'mb-5'}>
      <h3 className={cn('px-2.5 pb-1.5 text-[11px] font-medium text-soft-foreground', screen && 'px-1 pb-2')}>Task worktrees</h3>
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
      className={cn(
        'group flex items-center gap-[10px] rounded-[6px] px-[10px] text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
        screen ? 'h-12' : 'h-[32px]',
      )}
    >
      <span className="flex w-[12px] shrink-0 items-center justify-center">
        <StatusDot tone={attention.tone} shape={attention.shape} pulse={attention.pulse} aria-label={attention.label} title={attention.label} role="img" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span
          data-slot="git-worktree-branch"
          className={cn('truncate font-mono text-[12px]', row.branch === null && 'font-sans italic text-soft-foreground')}
        >
          {row.branch ?? 'no branch recorded'}
        </span>
        <span data-slot="git-worktree-meta" className="flex min-w-0 items-center gap-2 text-[11.5px] text-soft-foreground">
          <span className="truncate">{row.title}</span>
          {row.diff ? <DiffStatLabel stat={row.diff} compact className="shrink-0 text-[11.5px] font-normal" /> : null}
        </span>
      </span>
      {screen ? <ChevronRightIcon aria-hidden="true" className="size-[18px] shrink-0 text-soft-foreground" /> : null}
    </Link>
  )
}
