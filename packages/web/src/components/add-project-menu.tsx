import * as React from 'react'

import { AddProjectDialog } from '@/components/add-project-dialog'
import { CloneProjectDialog } from '@/components/clone-project-dialog'
import { FolderIcon, FolderPlusIcon } from '@/components/design-icons'
import { GithubIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

/**
 * The "Add project" dropdown beside the New task CTA (multi-project spec, "Sidebar → Header").
 *
 * "Open local folder…" opens the folder-browser dialog (step 4.2); "Clone from GitHub…" opens
 * the checkout dialog (step 4.3).
 *
 * Neither item is gh-gated here, deliberately. The spec's "disabled with a reason when `gh` is
 * unavailable" would mean reading `GET /api/health` from this component — and the dialogs are
 * mounted only while open precisely BECAUSE this shell must keep rendering where no QueryClient
 * is provided. So the degradation lands one click later instead, in the dialog, which shows the
 * server's own `gh CLI not found — install it and run 'gh auth login'` verbatim: the same
 * information, at the moment it is actionable, without a query in the shell.
 *
 * The dialogs are mounted only while open, ON PURPOSE: they are the one part of this shell that
 * talks to the API (queries + a mutation), and the shell itself must keep rendering in the
 * places that mount it without a QueryClient. The cost is no close animation, which is the
 * cheaper half of the trade.
 */
export function AddProjectMenu({
  triggerClassName,
  icon: Icon = FolderPlusIcon,
  iconClassName = 'size-4',
  side,
  origin,
  label,
}: {
  /** Extra trigger classes, merged over the footer's. The project rail (#618) restyles it. */
  triggerClassName?: string
  icon?: typeof FolderPlusIcon
  iconClassName?: string
  /** Which side the menu opens on; the rail opens it to the right, over the sidebar. */
  side?: 'right'
  /** Where this mount lives, as `data-origin` on the trigger, so a second mount (the rail) stays
   *  addressable. Not a `data-slot`: that would replace the Button's, which holds the 44px floor. */
  origin?: string
  /** A visible label: the mobile drawer's row shows it beside the icon. Absent, the trigger is
   *  the icon alone and the name is screen-reader only. */
  label?: string
} = {}) {
  const [browsing, setBrowsing] = React.useState(false)
  const [cloning, setCloning] = React.useState(false)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* size-11 in the drawer (touch target), the CTA's height on desktop. */}
        <Button
          variant="ghost"
          aria-label="Add project"
          title="Add project"
          data-origin={origin}
          className={cn('size-9 p-0 text-muted-foreground', triggerClassName)}
        >
          <Icon className={iconClassName} aria-hidden="true" />
          {label ? <span>{label}</span> : <span className="sr-only">Add project</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side={side} className="w-56">
        <DropdownMenuLabel className="text-xs text-soft-foreground">Add project</DropdownMenuLabel>
        <DropdownMenuItem data-slot="add-project-local" onSelect={() => setBrowsing(true)}>
          <FolderIcon aria-hidden="true" />
          Open local folder…
        </DropdownMenuItem>
        <DropdownMenuItem data-slot="add-project-clone" onSelect={() => setCloning(true)}>
          <GithubIcon aria-hidden="true" />
          Clone from GitHub…
        </DropdownMenuItem>
      </DropdownMenuContent>
      {browsing ? <AddProjectDialog open onOpenChange={setBrowsing} /> : null}
      {cloning ? <CloneProjectDialog open onOpenChange={setCloning} /> : null}
    </DropdownMenu>
  )
}
