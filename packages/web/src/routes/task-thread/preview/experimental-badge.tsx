import { FlaskConicalIcon } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * The marker that live preview is experimental (#781). Where the toolbar has no room it shrinks
 * to its icon, which keeps the accessible name and a tooltip reading "Experimental", so it still
 * counts as the marker.
 */
export function ExperimentalBadge({
  iconOnly = false,
  responsive = false,
  className,
}: {
  iconOnly?: boolean
  /** Icon only until the toolbar (a size container) is wide enough for the word. */
  responsive?: boolean
  className?: string
}) {
  if (responsive) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="img"
              aria-label="Experimental"
              tabIndex={0}
              data-slot="preview-experimental"
              className={cn('inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-0 rounded-full bg-muted px-0 text-xs font-semibold text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none @min-[640px]:gap-1.5 @min-[640px]:px-2.5', className)}
            >
              <FlaskConicalIcon className="size-3.5" aria-hidden="true" />
              <span className="hidden @min-[640px]:inline">Experimental</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>Experimental</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }
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
