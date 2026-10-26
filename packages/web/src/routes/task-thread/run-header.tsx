import './run-header.css'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AppWindowIcon, FileTextIcon, MailIcon, PencilIcon, PinOffIcon } from 'lucide-react'
import { CircleDotIcon, CopyIcon, EllipsisIcon, GitPullRequestIcon, PinIcon, Trash2Icon, XIcon } from '@/components/design-icons'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from '@/lib/project-router'

import { deleteRun } from '@/api/client'
import {
  queryKeys,
  useHealth,
  useMarkRunUnseen,
  usePatchRun,
  usePinRun,
  useRunHandoff,
  useRuns,
} from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { TitleEditInput, useTitleEditor } from '@/components/editable-title'
import { Pill } from '@/components/pill'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ReferenceStatusGlyph } from '@/components/reference-chip'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { TabLink } from '@/components/tab-link'
import { MobileRunBarPortal, useIsDesktopViewport, useMobileRunBarSlot } from '@/components/mobile-run-bar'
import { StatusDot } from '@/components/status-dot'
import { usePreviewPane } from './preview/preview-state'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from '@/components/ui/toaster'
import { deriveAttention } from '@/lib/attention'
import { queuePositions, runTitle } from '@/lib/task-groups'
import { taskItemTabs, type TaskItemTab } from '@/lib/tasks-table'
import { cn } from '@/lib/utils'

import { ArchiveButton } from './archive-action'
import { CompletionStatus } from './completion-status'
import { runStatusLine, statusLineText } from './run-status'
import { OpenInMenuForRun, copyToClipboard, useResumeInTerminal, useRunReferenceRequests } from './run-workspace'
import { HandoffAction, useHandoffActionVisible } from './handoff-action'
import { Markdown } from './markdown'
import { TaskFileScope } from './task-file-scope'
import { archiveInComposer, resumeHint, runActionFlags } from './run-actions'
import { CompactParentTaskLink, ParentTaskLink } from './parent-task-link'

/**
 * The run header (spec §"Task thread" → Header): editable title + status pill, the meta line,
 * the Session | Changes | Files tabs with the action bar — the header region above the thread.
 * Session activity controls live in the activity dock above the composer. The header scrolls away
 * on phones so the transcript owns the small viewport. On desktop Session it docks (`md:sticky md:top-0`) so Archive and sibling
 * actions stay on screen while the transcript scrolls. Git tabs stay in document flow — their own
 * sticky chrome (`top-4` / `--diff-sticky-top`) already parks under the viewport top. Opaque
 * `bg-background` so thread text does not show through; `z-20` parks it below any shell top bar
 * and above the transcript.
 *
 * Two deliberate omissions, both seams rather than gaps:
 *  - **VS Code** (spec: `POST /api/runs/:id/open-in-editor`) — the endpoint does not exist yet;
 *    R5 adds it driver-detected. Faking the button against nothing would be dishonest.
 *  - **Hosted mode** (spec §"Deployment modes"): when R5's `capabilities.localHandoff` lands in
 *    `/api/health`, Terminal (and VS Code) must disappear entirely and the resume hint must drop
 *    its `cd`. Today's HealthResponse carries no such field, so Terminal renders per current
 *    (local-only) behavior — the gate goes in where the flags are read, `runActionFlags` callers.
 */
/** Which run-detail tab this header instance sits above — drives the active underline.
 *  A prop rather than a route match so the header stays testable with a bare render. An object
 *  is one of the task's linked issue/PR tabs (#692). */
export type RunTab = 'session' | 'changes' | 'commits' | 'files' | TaskItemTab

/** How many item tabs fit inline before the rest go into the "+N" menu (spec #692). */
const MAX_INLINE_ITEM_TABS = 3

const sameItemTab = (a: TaskItemTab, b: TaskItemTab) => a.kind === b.kind && a.number === b.number

/**
 * The item tabs split into what shows inline and what goes into the "+N" menu. The first `max`
 * show inline — unless the ACTIVE tab sits past them, in which case it takes the last inline slot
 * and the tab it displaced moves into the menu, so the tab the reader is on is always visible.
 */
export function visibleItemTabs(
  tabs: TaskItemTab[],
  active: TaskItemTab | null,
  max = MAX_INLINE_ITEM_TABS,
): { inline: TaskItemTab[]; overflow: TaskItemTab[] } {
  const activeIndex = active ? tabs.findIndex((tab) => sameItemTab(tab, active)) : -1
  if (tabs.length <= max || activeIndex < max) {
    return { inline: tabs.slice(0, max), overflow: tabs.slice(max) }
  }
  const inline = [...tabs.slice(0, max - 1), tabs[activeIndex]!]
  return { inline, overflow: tabs.filter((tab) => !inline.includes(tab)) }
}

const itemTabPath = (runId: string, tab: TaskItemTab) => `/tasks/${runId}/${tab.kind}/${tab.number}`

/** An item tab's content: kind icon, `#n`, status glyph. The kind word is screen-reader text, so
 *  the accessible name is "Pull request #801" while the row stays as short as the design draws. */
function ItemTabLabel({ tab }: { tab: TaskItemTab }) {
  const KindIcon = tab.kind === 'pr' ? GitPullRequestIcon : CircleDotIcon
  return (
    <>
      <KindIcon aria-hidden="true" className="mr-1 size-3.5 shrink-0" />
      {/* The space stays OUTSIDE the sr-only span: accname drops it from inside, and a flex
          row trims it from the visible run, so it lands in the name alone. */}
      <span className="sr-only">{tab.kind === 'pr' ? 'Pull request' : 'Issue'}</span> #{tab.number}
      <ReferenceStatusGlyph kind={tab.kind === 'pr' ? 'PR' : 'Issue'} number={tab.number} className="ml-1" />
    </>
  )
}

/**
 * The preview pane's header toggle (#781): `Preview`, `Preview :5173`, `Preview :5173 +1`. The
 * entries are the registered servers and, while an agent drives the task's browser, the agent's
 * page (hearsay-tools/cezarion#784): alone it reads `Preview · agent`, beside servers it counts in
 * the `+N`. It only opens the pane, on the one entry or on the empty state when there are none or
 * several to pick from. It never asks to run a command; that approval lives on the card and in
 * the pane. The green dot means frames are flowing, not that a server is registered.
 */
export function previewToggleLabel(servers: readonly { port: number }[], agentLive: boolean): string {
  const first = servers[0]
  const entries = servers.length + (agentLive ? 1 : 0)
  if (!first) return agentLive ? 'Preview · agent' : 'Preview'
  return `Preview :${first.port}${entries > 1 ? ` +${entries - 1}` : ''}`
}

function PreviewToggle({ servers }: { servers: ApiRun['previewServers'] & object }) {
  const pane = usePreviewPane()
  if (pane === null) return null // no pane to open here (the git tabs)
  const agentLive = pane.agentLive === true
  const first = servers[0]
  const entries = servers.length + (agentLive ? 1 : 0)
  const request = entries !== 1 ? {} : first ? { port: first.port } : { agent: true as const }
  return (
    <Button
      variant="outline"
      size="sm"
      data-slot="preview-toggle"
      className="max-md:h-11"
      aria-pressed={pane.open}
      onClick={() => pane.openPane(request)}
    >
      <AppWindowIcon aria-hidden="true" />
      {previewToggleLabel(servers, agentLive)}
      {pane.live ? <StatusDot tone="success" aria-label="Preview is live" /> : null}
    </Button>
  )
}

export function RunHeader({
  run,
  tab = 'session',
  onMarkedUnread,
}: {
  run: ApiRun
  tab?: RunTab
  /** Fired the moment "Mark unread" is invoked, BEFORE the mutation — the Session tab uses it
   *  to suppress its auto-mark-read effect for the rest of the visit (#775). Optional because
   *  the three `task-git` tabs render this same header and run no such effect. */
  onMarkedUnread?: (() => void) | undefined
}) {
  const attention = deriveAttention(run)
  const flags = runActionFlags(run)
  const [notesOpen, setNotesOpen] = useState(false)
  const [openChooser, setOpenChooser] = useState(false)
  const actions = useRunActions(run, onMarkedUnread)

  // The queue position a parked run shows in its pill ("queued #2"). Reads the shared runs-list
  // query — already warm from the sidebar quick-list — because position is a property of the
  // whole queue, not of this record.
  const runs = useRuns()
  const health = useHealth()
  const queuePosition =
    run.status === 'queued' ? queuePositions(runs.data ?? []).get(run.id) : undefined
  // One status line for the pill and the Session activity card (hearsay-tools/cezarion#1333).
  const statusLine = runStatusLine(run, { queuePosition })

  // Below md, on a pushed task route, the shell's top bar carries the title, state line and run
  // actions (#621), so this header drops its own copy. Both halves are required: the slot exists
  // only inside the shell, and only phone width shows the bar — a bare render or a desktop
  // viewport keeps the header exactly as it was.
  const mobileSlot = useMobileRunBarSlot()
  const isDesktop = useIsDesktopViewport()
  const barSlot = mobileSlot !== null && !isDesktop ? mobileSlot : null
  // Below md the facets swap in place, so Back from the pushed screen returns to the list the
  // user came from rather than stepping through every tab they visited; desktop keeps its history.
  const phoneBar = barSlot !== null
  // One status batch for the whole header: the item tabs' glyphs read it (#692), and the Session
  // activity card's chips share the same registry entry.
  const { referenceProjectId, repoBase, requests: referenceRequests } = useRunReferenceRequests(run)
  // The linked own-repo issues and PRs, one tab each after Files (#692).
  const itemTabs = useMemo(() => taskItemTabs(run, repoBase), [run, repoBase])
  const activeItem = typeof tab === 'object' ? tab : null
  const { inline: inlineItemTabs, overflow: overflowItemTabs } = visibleItemTabs(itemTabs, activeItem)
  // Below md the tab row scrolls sideways rather than wrapping, so a tab can sit past the right
  // edge. The one the reader is on is brought into view — it may have been in the "+N" menu.
  const tabRowRef = useRef<HTMLDivElement>(null)
  // Keyed by the inline tab set too, not just the active item: a URL-only reference becomes a tab
  // only once `repoBase` resolves, so the active link can appear after mount (review g3 #2).
  const activeItemKey = activeItem ? `${activeItem.kind}#${activeItem.number}` : null
  const inlineItemSignature = inlineItemTabs.map((item) => `${item.kind}#${item.number}`).join(',')
  useEffect(() => {
    if (!activeItemKey || isDesktop) return
    tabRowRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeItemKey, inlineItemSignature, isDesktop])
  const previewToggle = run.worktreePath && health.data?.capabilities?.preview === true
    ? <PreviewToggle servers={run.previewServers ?? []} />
    : null
  const actionsKebab = (
    <ActionsKebab
      run={run}
      actions={actions}
      onOpenChooser={() => setOpenChooser(true)}
      onToggleNotes={() => setNotesOpen((open) => !open)}
    />
  )

  // #281: Archive out of the kebab. The Session tab's composer carries it — within a
  // thumb's reach, which this header is not on a phone, where it scrolls away by
  // design. The three git tabs have no composer, so the header carries it there, and
  // exactly one surface offers it on any given screen. Stop takes the composer's slot on a
  // failed run holding wait results (hearsay-tools/cezarion#1233), so the header carries
  // Archive on the Session tab too.
  const archiveButton = !run.archiveBlocker && flags.archive && (tab !== 'session' || !archiveInComposer(run)) ? <ArchiveButton run={run} /> : null
  const handoffVisible = useHandoffActionVisible(run)

  return (
    <ReferenceStatusProvider projectId={referenceProjectId} repoBase={repoBase} requests={referenceRequests}>
    <header
      data-slot="run-header"
      className={cn(
        // Pushed phone screen: the facet tabs sit directly under the shell's top bar (#621), so
        // the header has no top padding of its own there.
        'relative z-20 bg-background px-[18px] md:px-9 md:pt-7',
        phoneBar ? 'pt-0' : 'pt-[18px]',
        tab === 'session' && 'md:sticky md:top-0',
      )}
    >
      {run.archived && run.autoArchive?.reason === 'pull-requests-merged' && run.autoArchive.archivedAt === run.archivedAt ? <p data-slot="auto-archive-reason" className="text-[13px] text-muted-foreground">Archived automatically after all associated PRs merged.</p> : null}
      <CompletionStatus run={run} />
      <div className="w-full">
        {run.delegation?.role === 'worker' ? <ParentTaskLink id={run.delegation.parentRunId} /> : null}
        {/* Pushed phone screen (#621): the shell's top bar carries back, the title and the run
            actions. hearsay-tools/cezarion#1333 took the state line out of it: the run's status
            lives in Session activity, the one card both viewports read. */}
        {barSlot ? (
          <MobileRunBarPortal slot={barSlot}>
            <MobileRunTitle run={run} />
            {run.delegation?.role === 'worker' ? <CompactParentTaskLink id={run.delegation.parentRunId} /> : null}
            {actionsKebab}
          </MobileRunBarPortal>
        ) : (
          <div data-slot="run-title-row" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 md:flex-nowrap">
            <p data-slot="session-kind" className="text-[12px] font-semibold tracking-[0.14em] text-muted-foreground uppercase md:hidden">
              {run.delegation?.role === 'worker' ? 'Worker session' : run.delegation?.role === 'root' ? 'Parent session' : 'Task session'}
            </p>
            <EditableTitle run={run} />
            {/* Desktop only: below md the header shows no status at all (#1333). */}
            <Pill dot={attention.tone} shape={attention.shape} pulse={attention.pulse} className="max-md:hidden">
              {statusLineText(statusLine)}
            </Pill>
            <span className="ml-auto flex shrink-0 items-center gap-1 md:gap-2.5">
              {archiveButton}
              {previewToggle}
              <HandoffAction run={run} />
              {actionsKebab}
            </span>
          </div>
        )}

        {/* Pushed phone screen: the controls the dropped title row used to carry, in a row of
            their own — rendered only when one of them applies, so an empty row never sits
            between the top bar and the tabs. */}
        {barSlot && (archiveButton || previewToggle || handoffVisible) ? (
          <div data-slot="run-mobile-actions" className="flex flex-wrap items-center gap-2 pt-2">
            {archiveButton}
            {previewToggle}
            <HandoffAction run={run} />
          </div>
        ) : null}

        {/* Below md (#621): 13.5px labels and quiet counts, tabs spread across the row. The 44px
            floor stays — the touch-target sweep measures these links — so the design's 40px is the
            visual weight of the row, not a smaller hit area. The count is phone-only (desktop tabs are unchanged). Counts come only from data the record
            already carries: the changed-file tally. A commit count is not on the record, and one
            more query for a badge is not worth it, so Commits shows none. */}
        {/* Below md the row scrolls sideways instead of wrapping (#692): item tabs can push it past
            the viewport, and a wrapped second row of tabs reads as a second tab bar. The divider
            moves into an inset shadow there, because a scroll container clips the tabs' `-mb-px`
            overlap — the underline then sits ON the divider exactly as it does on desktop. */}
        <div
          ref={tabRowRef}
          data-slot="run-tabs"
          data-phone-bar={phoneBar || undefined}
          className="mt-3 flex flex-wrap items-end gap-1 border-b border-border md:mt-5 max-md:flex-nowrap max-md:overflow-x-auto max-md:border-b-0 max-md:shadow-[inset_0_-1px_0_var(--border)] max-md:gap-0 max-md:[&>*]:mb-0 max-md:[&>*]:shrink-0 max-md:[&>a]:min-h-11 max-md:[&>a]:px-3.5 max-md:[&>a]:text-[13.5px]"
        >
          <TabLink to={`/tasks/${run.id}`} active={tab === 'session'} replace={phoneBar}>
            Session
          </TabLink>
          <TabLink to={`/tasks/${run.id}/changes`} active={tab === 'changes'} replace={phoneBar} count={run.diffStat && run.diffStat.files > 0 ? run.diffStat.files : undefined}>
            Changes
          </TabLink>
          <TabLink to={`/tasks/${run.id}/commits`} active={tab === 'commits'} replace={phoneBar}>
            Commits
          </TabLink>
          <TabLink to={`/tasks/${run.id}/files`} active={tab === 'files'} replace={phoneBar}>
            Files
          </TabLink>
          {inlineItemTabs.map((item) => (
            <TabLink
              key={`${item.kind}-${item.number}`}
              to={itemTabPath(run.id, item)}
              active={activeItem !== null && sameItemTab(item, activeItem)}
              replace={phoneBar}
            >
              <ItemTabLabel tab={item} />
            </TabLink>
          ))}
          {overflowItemTabs.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                data-slot="run-tabs-more"
                aria-label={`${overflowItemTabs.length} more linked items`}
                className="-mb-px flex h-8 items-center rounded-t-md border-b-2 border-transparent px-3 text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-link-foreground max-md:min-h-11 max-md:px-3.5 max-md:text-[13.5px]"
              >
                +{overflowItemTabs.length}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {overflowItemTabs.map((item) => (
                  <DropdownMenuItem key={`${item.kind}-${item.number}`} asChild>
                    <Link to={itemTabPath(run.id, item)} replace={phoneBar}>
                      <ItemTabLabel tab={item} />
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>

        {notesOpen ? <NotesPanel runId={run.id} onClose={() => setNotesOpen(false)} /> : null}
        {openChooser ? <OpenInMenuForRun run={run} canResume={runActionFlags(run).terminal} onResume={() => actions.terminal.mutate()} onClose={() => setOpenChooser(false)} /> : null}
      </div>

      <ConfirmDialog run={run} actions={actions} />
    </header>
    </ReferenceStatusProvider>
  )
}

/** The mutations + confirm state, bundled so the desktop bar and the mobile kebab drive the
 *  exact same behavior. Every failure surfaces the server's own words as a danger toast. */
function useRunActions(run: ApiRun, onMarkedUnread?: () => void) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState<'delete' | null>(null)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
  const onError = (error: Error) => toast(error.message, { tone: 'danger' })

  // Pin/unpin (#935) — the shared hook rather than a local mutation, because the sidebar and the
  // Tasks table drive the same action and the cache rule belongs in one place. Toggling off the
  // record, exactly like archive above.
  const pinMutation = usePinRun()
  const pin = {
    isPending: pinMutation.isPending,
    mutate: () => pinMutation.mutate({ id: run.id, pinned: !run.pinned }),
  }
  // Mark unread (#775) drives the shared optimistic hook rather than a local mutation: the
  // cache choreography (clear `seenAt`, guarded rollback) belongs next to its read twin in
  // queries.ts, and no `invalidate` is wanted here — an invalidation would refetch the list
  // and reinstate the receipt before the server's own answer lands.
  const markUnreadMutation = useMarkRunUnseen()
  const markUnread = {
    isPending: markUnreadMutation.isPending,
    mutate: () => {
      // Before the mutation, so the Session tab's suppression is in place by the time the
      // optimistic write re-renders the thread and re-evaluates its auto-mark-read effect.
      onMarkedUnread?.()
      markUnreadMutation.mutate(run.id, { onError })
    },
  }
  const deleteMutation = useMutation({
    mutationFn: () => deleteRun(run.id),
    onSuccess: () => {
      invalidate()
      // The run is gone — so is this page. Home is the only honest destination.
      void navigate('/')
    },
    onError,
  })
  const terminal = useResumeInTerminal(run)

  return {
    pin,
    markUnread,
    delete: deleteMutation,
    terminal,
    confirming,
    setConfirming,
  }
}

type RunActions = ReturnType<typeof useRunActions>

/** The rename machine bound to a run, shared by the desktop h1 and the phone top bar. */
function useRunTitleEditor(run: ApiRun) {
  const patch = usePatchRun(run.id)
  const title = runTitle(run)
  const editor = useTitleEditor(title, (next) =>
    patch.mutate({ title: next }, { onError: (error) => toast(error.message, { tone: 'danger' }) }),
  )
  return { title, editor }
}

/**
 * The editable title (#389): a plain h1 with a pencil that only appears on hover (mockup
 * `.pencil-btn`), flipping into an inline input. Enter/blur commit through `usePatchRun`
 * (the server stores it as both `title` and `titleSummary`), Escape abandons the draft.
 * The rename machine itself is shared with the Tasks table (`components/editable-title.tsx`).
 */
function EditableTitle({ run }: { run: ApiRun }) {
  const { title, editor } = useRunTitleEditor(run)

  if (editor.editing) {
    return <TitleEditInput editor={editor} className="flex-1 text-[16px] font-semibold" />
  }

  return (
    <span className="group flex min-w-0 items-center gap-1">
      <h1 className="line-clamp-2 min-w-0 break-words text-2xl font-semibold tracking-tight" title={run.task}>
        {title}
      </h1>
      <button
        type="button"
        aria-label="Rename task"
        onClick={editor.begin}
        className="shrink-0 rounded-sm p-1 text-soft-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <PencilIcon className="size-3.5" aria-hidden="true" />
      </button>
    </span>
  )
}

/** The phone top bar's title (#621, #737): the 15px/600 title and, as its SIBLING, the 44px rename
 *  button. The bar shows no status (hearsay-tools/cezarion#1333): the Session activity card does.
 *  The 44px input cannot sit in the 56px bar, so renaming opens it in a popover anchored under the
 *  pencil; the same `useTitleEditor` machine (Enter/blur commit, Escape cancel). */
function MobileRunTitle({ run }: { run: ApiRun }) {
  const { title, editor } = useRunTitleEditor(run)
  return (
    <Popover
      open={editor.editing}
      onOpenChange={(open) => {
        if (open) editor.begin()
        else editor.commit()
      }}
    >
      <div data-slot="mobile-run-title" className="flex min-w-0 flex-1 flex-col gap-px">
        <h1 className="truncate text-[15px] leading-tight font-semibold text-foreground" title={run.task}>{title}</h1>
      </div>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Rename task"
          className="flex size-11 shrink-0 items-center justify-center rounded-sm text-soft-foreground hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <PencilIcon className="size-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-64 max-w-[calc(100vw-16px)] p-2"
        // Radix dismisses on a document-level Escape before the input's own handler runs, and a
        // dismissal commits. Escape must abandon the draft, so cancel here and stop the dismissal.
        onEscapeKeyDown={(event) => {
          event.preventDefault()
          editor.cancel()
        }}
      >
        <TitleEditInput editor={editor} className="text-[16px] font-semibold" />
      </PopoverContent>
    </Popover>
  )
}

/** One action menu for desktop and mobile, preserving the shared run action policy. */
function ActionsKebab({
  run,
  actions,
  onToggleNotes,
  onOpenChooser,
}: {
  run: ApiRun
  actions: RunActions
  onToggleNotes: () => void
  onOpenChooser: () => void
}) {
  const flags = runActionFlags(run)
  const command = resumeHint(run)
  const completionPatch = usePatchRun(run.id)
  const completionHelpId = useId()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="size-11" aria-label="Run actions">
          <EllipsisIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-slot="run-actions-menu" className="w-[270px] max-w-[calc(100vw-2rem)] p-3">
        <DropdownMenuLabel className="px-2 py-3 text-[12px] font-normal text-muted-foreground">TASK ACTIONS</DropdownMenuLabel>
        <DropdownMenuItem onSelect={onToggleNotes}>
          <FileTextIcon aria-hidden="true" /> Notes / handoff
        </DropdownMenuItem>
        <OpenInMenuForRun run={run} canResume={flags.terminal} onResume={() => actions.terminal.mutate()} onOpen={onOpenChooser} />
        {command ? <DropdownMenuItem onSelect={() => void copyToClipboard(command, 'Command copied to clipboard.')}>
          <CopyIcon aria-hidden="true" /> Copy resume command
        </DropdownMenuItem> : null}
        {flags.markUnread ? (
          <DropdownMenuItem
            disabled={actions.markUnread.isPending}
            onSelect={() => actions.markUnread.mutate()}
          >
            <MailIcon aria-hidden="true" /> Mark unread
          </DropdownMenuItem>
        ) : null}
        {flags.pin ? (
          <DropdownMenuCheckboxItem
            data-slot="pin-run"
            className="min-h-11"
            checked={Boolean(run.pinned)}
            disabled={actions.pin.isPending}
            onCheckedChange={() => actions.pin.mutate()}
          >
            {run.pinned ? <PinOffIcon aria-hidden="true" /> : <PinIcon aria-hidden="true" />}
            {run.pinned ? 'Unpin task' : 'Pin task'}
          </DropdownMenuCheckboxItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">AFTER DONE</DropdownMenuLabel>
        <DropdownMenuCheckboxItem data-slot="archive-when-done" className="min-h-11" checked={run.archiveWhenDone === true} disabled={completionPatch.isPending}
          onCheckedChange={(archiveWhenDone) => completionPatch.mutate({ archiveWhenDone }, { onError: error => toast(error.message, { tone: 'danger' }) })}>
          Archive when Done
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem data-slot="auto-merge-pr" className="min-h-11" checked={run.autoMergePr === true} disabled={completionPatch.isPending}
          aria-describedby={completionHelpId}
          onCheckedChange={(autoMergePr) => completionPatch.mutate({ autoMergePr }, { onError: error => toast(error.message, { tone: 'danger' }) })}>
          Auto-merge PR
        </DropdownMenuCheckboxItem>
        <p id={completionHelpId} className="text-xs text-muted-foreground [padding-inline:0.5rem] [padding-block:0.5rem]">
          After Done, auto-merge can mark a draft PR ready. It waits for current-head CI and GitHub rules. Merge comes before archive.
        </p>
        {flags.deleteRun ? <DropdownMenuSeparator /> : null}
        {flags.deleteRun ? (
          <DropdownMenuItem variant="destructive" onSelect={() => actions.setConfirming('delete')}>
            <Trash2Icon aria-hidden="true" /> Delete task…
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Deleting history and work still requires confirmation. */
function ConfirmDialog({ run, actions }: { run: ApiRun; actions: RunActions }) {
  const confirming = actions.confirming
  return (
    <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && actions.setConfirming(null)}>
      <AlertDialogContent data-slot="task-confirmation" className="sm:max-w-[660px]">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-danger">Delete task permanently?</AlertDialogTitle>
          <AlertDialogDescription>
              <>
                Delete “
                <span className="font-medium text-foreground" title={runTitle(run)}>{runTitle(run)}</span>
                ” and its transcript, worktree and branch. This cannot be undone.
              </>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-danger text-danger-foreground hover:brightness-[0.96]"
            onClick={() => {
              actions.delete.mutate()
              actions.setConfirming(null)
            }}
          >
            Delete task
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** The handoff journal (spec 007) as rendered markdown — fetched only while open. */
function NotesPanel({ runId, onClose }: { runId: string; onClose: () => void }) {
  const handoff = useRunHandoff(runId)
  return (
    <div
      data-slot="notes-panel"
      className="my-5 rounded-xl border border-border bg-card p-6"
    >
      <div className="mb-4 flex items-center justify-between gap-3"><h2 className="text-lg font-medium">Notes / handoff</h2><Button variant="ghost" size="icon" aria-label="Close notes" onClick={onClose}><XIcon /></Button></div>
      {handoff.isPending ? (
        <p className="text-xs text-soft-foreground">Loading notes…</p>
      ) : handoff.isError ? (
        <p className="text-xs text-danger">{handoff.error.message}</p>
      ) : handoff.data.trim().length > 0 ? (
        <TaskFileScope runId={runId}><Markdown>{handoff.data}</Markdown></TaskFileScope>
      ) : (
        <p className="text-xs text-soft-foreground">
          No notes yet — the handoff file is seeded when the task starts.
        </p>
      )}
      <div className="mt-4 flex gap-3"><Button variant="outline" disabled={!handoff.data?.trim()} onClick={() => void copyToClipboard(handoff.data ?? '', 'Notes copied')}>Copy notes</Button><Button variant="outline" onClick={onClose}>Close</Button></div>
    </div>
  )
}
