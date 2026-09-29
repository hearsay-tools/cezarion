import { useMutation } from '@tanstack/react-query'
import { CheckCheckIcon, CopyIcon, EllipsisIcon, ExternalLinkIcon, SettingsIcon } from 'lucide-react'
import { useRef, useState } from 'react'

import { openProjectIn } from '@/api/client'
import { useHealth, useMarkRunSeen, useOpenTargets, useProjects, useProjectRuns } from '@/api/queries'
import { useSidebarNavigate } from '@/components/app-shell'
import { cliTargetRunner, openInIcon } from '@/components/open-in-menu'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from '@/components/ui/toaster'
import { Link, useActiveProjectId } from '@/lib/project-router'
import { projectInitials } from '@/lib/project-signal'
import { isUnread } from '@/lib/read-state'
import { isOwnedWorker } from '@/lib/task-groups'

const menuClass = 'w-[228px] rounded-[10px] border-border bg-sidebar p-[5px] text-foreground shadow-[0_10px_28px_#00000047] motion-reduce:animate-none'
const itemClass = 'h-8 gap-2.5 rounded-[6px] px-[9px] py-0 text-[13px] focus:bg-sidebar-row-hover focus:text-foreground [&_svg]:size-[15px] [&_svg]:text-soft-foreground focus:[&_svg]:text-foreground max-md:min-h-11'

/** This project's identity and actions. Workspace health describes only the boot project;
 * the registry is authoritative for every other project's name, root and branch. */
export function SidebarProjectHeader({ onNavigate }: { onNavigate?: () => void } = {}) {
  const sidebarNavigate = useSidebarNavigate()
  const markRef = useRef<HTMLSpanElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const [menuOffset, setMenuOffset] = useState(0)
  const activeProjectId = useActiveProjectId()
  const health = useHealth()
  const registry = useProjects()
  const [marking, setMarking] = useState(false)
  const bootId = registry.data?.bootProject ?? health.data?.bootProject
  const projectId = activeProjectId ?? bootId ?? null
  const runs = useProjectRuns(projectId ?? 'default', projectId !== null, projectId === bootId)
  const seen = useMarkRunSeen(projectId ?? 'default', projectId === bootId ? 'default' : projectId ?? 'default')
  const currentProject = useRef(projectId)
  currentProject.current = projectId
  const project = registry.data?.projects.find((entry) => entry.id === projectId)
  const bootRepo = projectId === bootId ? health.data?.repo : undefined
  const root = project?.root ?? bootRepo?.root
  const name = project?.name ?? root?.split(/[\\/]/).filter(Boolean).at(-1)
  const branch = bootRepo?.branch ?? project?.branch
  const local = health.data?.capabilities.localHandoff === true
  const identity = name ?? (registry.isPending ? 'Loading project…' : 'Project unavailable')
  const detail = [local ? root : undefined, branch].filter(Boolean).join(' · ')
  const unread = (runs.data ?? []).filter((run) => !isOwnedWorker(run) && isUnread(run))
  const count = runs.isError ? 'Unavailable' : runs.data === undefined ? 'Loading…' : `${unread.length} unread`

  async function markAllRead() {
    setMarking(true)
    let failures = 0
    try {
      // Sequential mutations preserve each optimistic receipt if a later request rolls back.
      // Stop the batch if navigation switches the API scope while a receipt is in flight.
      for (const run of unread) {
        if (currentProject.current !== projectId) break
        try { await seen.mutateAsync(run.id) } catch { failures += 1 }
      }
      if (failures > 0) toast(`Could not mark ${failures} task${failures === 1 ? '' : 's'} read. Try again.`, { tone: 'danger' })
    } finally { setMarking(false) }
  }

  async function copyPath() {
    if (!root) return
    try {
      await navigator.clipboard.writeText(root)
      toast('Project folder copied')
    } catch {
      toast(`Could not copy path: ${root}`, { tone: 'danger' })
    }
  }

  return (
    <div data-slot="project-header" className="flex min-w-0 items-center gap-2.5 px-[14px] pt-[14px] pb-2.5">
      <span ref={markRef} aria-hidden="true" data-slot="project-header-mark" className="flex size-7 shrink-0 items-center justify-center rounded-[7px] border border-soft-foreground bg-sidebar-row-selected text-[11px] leading-none font-semibold text-foreground">
        {name ? projectInitials(name) : '…'}
      </span>
      <div className="min-w-0 flex-1">
        <div data-slot="project-header-name" className="truncate text-[14px] font-semibold text-foreground" title={identity}>{identity}</div>
        {/* Keep the end (especially the branch) visible without reversing the actual text. */}
        <div data-slot="project-header-detail" dir="rtl" className="truncate text-left font-mono text-[10.5px] text-soft-foreground" title={detail || undefined}>
          <bdi dir="ltr">{detail || (registry.isPending ? 'Loading…' : 'Branch unavailable')}</bdi>
        </div>
      </div>
      <DropdownMenu onOpenChange={(open) => {
        if (open && markRef.current && menuButtonRef.current) {
          setMenuOffset(markRef.current.getBoundingClientRect().left - menuButtonRef.current.getBoundingClientRect().left)
        }
      }}>
        <DropdownMenuTrigger asChild>
          <button data-slot="project-menu-trigger" ref={menuButtonRef} type="button" aria-label="Project menu" className="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-soft-foreground hover:bg-sidebar-row-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:bg-sidebar-row-selected data-[state=open]:text-foreground max-md:size-11">
            <EllipsisIcon aria-hidden="true" className="size-[15px]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" alignOffset={menuOffset} sideOffset={4} className={menuClass}>
          <DropdownMenuItem className={itemClass} disabled={marking || runs.isError || runs.data === undefined || unread.length === 0 || projectId === null} onSelect={() => { void markAllRead() }}>
            <CheckCheckIcon aria-hidden="true" /> Mark all read
            <span className="ml-auto text-[11.5px] text-soft-foreground">{marking ? 'Marking…' : count}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator className="mx-0" />
          {local && <>
            <ProjectOpenSubmenu projectId={projectId ?? 'default'} disabled={!root || project?.status === 'missing'} />
            <DropdownMenuItem className={itemClass} disabled={!root} onSelect={() => { void copyPath() }}>
              <CopyIcon aria-hidden="true" /> Copy path
            </DropdownMenuItem>
            <DropdownMenuSeparator className="mx-0" />
          </>}
          <DropdownMenuItem asChild className={itemClass}>
            <Link to="/settings" onClick={onNavigate ?? sidebarNavigate}><SettingsIcon aria-hidden="true" /> Project settings</Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** Mount the machine-level query only when the local handoff capability allows it. */
function ProjectOpenSubmenu({ disabled, projectId }: { disabled: boolean; projectId: string }) {
  const targets = useOpenTargets()
  const open = useMutation({
    mutationFn: (target: string) => openProjectIn(target, projectId),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
    onSuccess: () => toast('Opening project folder'),
  })
  const choices = (targets.data?.targets ?? []).filter((target) => cliTargetRunner(target.id) === undefined)
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={itemClass} disabled={disabled || open.isPending}>
        <ExternalLinkIcon aria-hidden="true" /> Open in
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className={menuClass}>
          {choices.map((target) => {
            const Icon = openInIcon(target)
            return <DropdownMenuItem key={target.id} className={itemClass} data-target={target.id} onSelect={() => open.mutate(target.id)}><Icon aria-hidden="true" />{target.label}</DropdownMenuItem>
          })}
          {choices.length === 0 && <DropdownMenuItem className={itemClass} disabled>{targets.isError ? 'Apps unavailable' : targets.isPending ? 'Loading apps…' : 'No apps available'}</DropdownMenuItem>}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  )
}
