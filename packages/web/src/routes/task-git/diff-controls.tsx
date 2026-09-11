import { GitBranchIcon, WrapTextIcon } from 'lucide-react'

import type { DiffMode } from '@/components/diff'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * The diff view's local controls, extracted from the Changes toolbar (R5 1.7) so the repo
 * view renders the SAME unified/split + wrap toggles and branch chip rather than a fork.
 * Layout preferences, not git actions — no policy involvement. Callers own the "hidden
 * below md" wrapper, because phones force unified+wrap and hide these entirely.
 */
export function DiffViewToggles({
  mode,
  wrap,
  onModeChange,
  onWrapChange,
}: {
  mode: DiffMode
  wrap: boolean
  onModeChange: (mode: DiffMode) => void
  onWrapChange: (wrap: boolean) => void
}) {
  return (
    <>
      <span
        data-slot="diff-mode-toggle"
        role="group"
        aria-label="Diff layout"
        className="flex items-center gap-2"
      >
        <ModeButton current={mode} value="unified" onModeChange={onModeChange} />
        <ModeButton current={mode} value="split" onModeChange={onModeChange} />
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        data-slot="wrap-toggle"
        aria-pressed={wrap}
        aria-label="Wrap long lines"
        title="Wrap long lines"
        className={cn('size-11', wrap && 'bg-muted text-foreground')}
        onClick={() => onWrapChange(!wrap)}
      >
        <WrapTextIcon aria-hidden="true" />
      </Button>
    </>
  )
}

function ModeButton({
  current,
  value,
  onModeChange,
}: {
  current: DiffMode
  value: DiffMode
  onModeChange: (mode: DiffMode) => void
}) {
  const active = current === value
  return (
    <button
      type="button"
      data-mode={value}
      aria-pressed={active}
      onClick={() => onModeChange(value)}
      className={cn(
        'min-h-11 rounded-lg border border-border bg-card px-3 text-xs font-medium capitalize',
        active ? 'border-accent-text/40 text-accent-text' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {value}
    </button>
  )
}

/** The mono branch chip both git toolbars lead with. */
export function BranchChip({ branch }: { branch: string }) {
  return (
    <span
      data-slot="branch-chip"
      className="flex min-w-0 items-center gap-1 rounded-sm border border-border bg-card px-1.5 py-px font-mono text-[11px] font-medium"
    >
      <GitBranchIcon aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{branch}</span>
    </span>
  )
}
