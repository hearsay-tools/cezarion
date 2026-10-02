import { FlaskConicalIcon } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * The marker that live preview is experimental (#781). Where the toolbar has no room it shrinks
 * to its icon, which keeps the accessible name and a tooltip reading "Experimental", so it still
 * counts as the marker.
 */
export function ExperimentalBadge({ iconOnly = false, className }: { iconOnly?: boolean; className?: string }) {
  if (!iconOnly) {
    return (
      <span
        data-slot="preview-experimental"
        className={cn('inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-muted px-2.5 text-xs font-semibold text-muted-foreground', className)}
      >
        <FlaskConicalIcon className="size-3.5" aria-hidden="true" />
        Experimental
      </span>
    )
  }
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            aria-label="Experimental"
            tabIndex={0}
            data-slot="preview-experimental"
            className={cn('inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none', className)}
          >
            <FlaskConicalIcon className="size-3.5" aria-hidden="true" />
          </span>
        </TooltipTrigger>
        <TooltipContent>Experimental</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
