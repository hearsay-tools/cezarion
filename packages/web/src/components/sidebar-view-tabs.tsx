import { useRef, useState, type KeyboardEvent } from 'react'
import { EllipsisIcon } from 'lucide-react'
import type { NavItem } from './nav-items'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

export function SidebarViewTabs({ items, activeTo, needsYou = false, inboxCount, skillsUpdateAvailable, onNavigate }: {
  items: NavItem[]
  activeTo: string | null
  needsYou?: boolean
  inboxCount?: number | null
  skillsUpdateAvailable?: boolean
  onNavigate?: () => void
}) {
  const [open, setOpen] = useState(false)
  const nav = useRef<HTMLElement>(null)
  const overflow = items.filter(item => item.to === '/inbox' || item.to === '/automations')
  const primary = items.filter(item => !overflow.includes(item))
  const overflowActive = overflow.some(item => item.to === activeTo)
  const moveFocus = (event: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const controls = Array.from(nav.current?.querySelectorAll<HTMLElement>('[data-view-tab]') ?? [])
    const current = controls.indexOf(document.activeElement as HTMLElement)
    if (current < 0) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length
    controls[next]?.focus()
  }
  return <TooltipProvider><nav ref={nav} aria-label="Main" data-slot="view-tabs" onKeyDown={moveFocus} className="flex shrink-0 items-center justify-between max-md:justify-start max-md:gap-1 max-md:overflow-x-auto border-b border-border px-2.5 pt-2.5 pb-2">
    {primary.map(item => {
      const active = item.to === activeTo
      const Icon = item.icon
      const dot = item.to === '/' && needsYou && !active ? 'bg-pending-strong' : item.to === '/skills' && skillsUpdateAvailable ? 'bg-info' : null
      return <Tooltip key={item.to}><TooltipTrigger asChild><Link to={item.to} onClick={onNavigate} data-view-tab aria-label={item.label} aria-current={active ? 'page' : undefined}
        className={cn('relative flex h-[30px] min-w-0 items-center justify-center rounded-[7px] text-soft-foreground hover:bg-sidebar-row-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring max-md:min-h-11 max-md:min-w-11', active ? 'gap-1.5 bg-sidebar-row-selected px-[9px] text-[12px] font-semibold text-foreground' : overflow.length ? 'w-[26px] shrink-0' : 'w-7 shrink-0')}>
        <span className="relative"><Icon className="size-[15px]" aria-hidden="true" />{dot ? <span aria-label={item.to === '/' ? 'Tasks need you' : 'Skills update available'} data-slot={item.to === '/' ? 'nav-needs-you-dot' : 'nav-update-marker'} className={cn('absolute -top-1 -right-1 size-[7px] rounded-full border-[1.5px] border-sidebar', dot)} /> : null}</span>
        {active ? <span className="truncate">{item.label}</span> : null}
      </Link></TooltipTrigger><TooltipContent side="bottom" sideOffset={6} style={{ pointerEvents: 'none' }}>{item.label}</TooltipContent></Tooltip>
    })}
    {overflow.length ? <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip><TooltipTrigger asChild><DropdownMenuTrigger asChild><button type="button" data-view-tab aria-label="More views" data-active={overflowActive ? 'true' : undefined} className={cn('relative flex h-[30px] w-[26px] shrink-0 items-center justify-center rounded-[7px] text-soft-foreground hover:bg-sidebar-row-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring max-md:min-h-11 max-md:min-w-11', (open || overflowActive) && 'bg-sidebar-row-selected text-foreground')}>
        <EllipsisIcon className="size-[15px]" aria-hidden="true" />{inboxCount && overflow.some(item => item.to === '/inbox') ? <span data-slot="overflow-inbox-dot" className="absolute top-1 right-0.5 size-[7px] rounded-full border-[1.5px] border-sidebar bg-pending-strong" /> : null}
      </button></DropdownMenuTrigger></TooltipTrigger><TooltipContent side="bottom" sideOffset={6} style={{ pointerEvents: 'none' }}>More views</TooltipContent></Tooltip>
      <DropdownMenuContent align="end" sideOffset={4} className="w-48 rounded-[10px] border-border bg-sidebar p-[5px] shadow-[0_10px_28px_#00000047]">
        {overflow.map(item => { const Icon = item.icon; const active = item.to === activeTo
          return <DropdownMenuItem key={item.to} asChild className={cn('h-8 max-md:min-h-11 gap-2.5 rounded-md px-[9px] text-[13px] text-foreground focus:bg-sidebar-row-hover', active && 'bg-sidebar-row-selected font-medium')}>
            <Link to={item.to} onClick={onNavigate} aria-current={active ? 'page' : undefined}><Icon className="size-[15px] text-soft-foreground" />{item.label}{item.to === '/inbox' && inboxCount ? <span data-slot="inbox-count" className="ml-auto rounded-full bg-inbox-count px-1.5 text-[11px] font-semibold text-inbox-count-foreground">{inboxCount}</span> : null}</Link>
          </DropdownMenuItem>
        })}
      </DropdownMenuContent>
    </DropdownMenu> : null}
  </nav></TooltipProvider>
}
