import { useMutation } from '@tanstack/react-query'
import { SquareTerminalIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { ApiError, openRunIn, openRunInCli } from '@/api/client'
import { useOpenTargets, useProjectRepoBase, useProviderStatus, useReferenceProjectId } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { CopyIcon, XIcon } from '@/components/design-icons'
import { OpenInMenu, openInIcon, type OpenInChoice } from '@/components/open-in-menu'
import { ReferenceChip } from '@/components/reference-chip'
import { ResolveConflictsButton } from '@/components/reference-conflict-action'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { toast } from '@/components/ui/toaster'
import { usableRunners } from '@/lib/provider-status'
import { runTitle } from '@/lib/task-groups'
import {
  isOwnRepoReference,
  prNumber,
  referenceKey,
  taskIssueUrl,
  taskItemPath,
  taskPrUrl,
  taskReferences,
  type TaskReference,
} from '@/lib/tasks-table'
import { isHttpUrl } from '@/lib/utils'

import { cliTargetResumes, cliTargetRunner, lastSessionBackend, resumeHint } from './run-actions'

/**
 * The run's workspace tools and links (hearsay-tools/cezarion#1333): branch and worktree copy,
 * "Open in…" targets, the resume command, and the linked issue/PR chips. The header's kebab and the
 * Session activity card's Workspace row both use them, so a capability or availability rule lives
 * in one place.
 */

export async function copyToClipboard(text: string, doneMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast(doneMessage)
  } catch {
    // No clipboard access (permissions, http) — show the command itself; it is the payload.
    toast(`Run manually: ${text}`)
  }
}

/** The status batch for a run's own-repo references — what `ReferenceStatusProvider` takes. Both
 *  the header (tab glyphs) and the activity card (chips, conflict roll-up) mount one; the app
 *  root's registry unions them, so the second costs no request. */
export function useRunReferenceRequests(run: ApiRun) {
  const repoBase = useProjectRepoBase()
  const referenceProjectId = useReferenceProjectId()
  const references = useMemo(() => taskReferences(run, repoBase), [run, repoBase])
  const requests = useMemo(
    () =>
      referenceProjectId === undefined
        ? []
        : references.filter(reference => isOwnRepoReference(reference, repoBase)).map((reference) => ({
            projectId: referenceProjectId,
            kind: reference.kind,
            number: reference.number,
          })),
    [references, referenceProjectId, repoBase],
  )
  return { referenceProjectId, repoBase, references, requests }
}

/** Resume the session in a real terminal (#open-in). The legacy 409 fallback (no terminal emulator)
 *  puts the server's manual command on the clipboard. */
export function useResumeInTerminal(run: ApiRun) {
  return useMutation({
    mutationFn: () => openRunInCli(run.id),
    onError: (error: Error) => {
      if (error instanceof ApiError && error.command) {
        void copyToClipboard(error.command, 'No terminal found — command copied to clipboard.')
        return
      }
      toast(error.message, { tone: 'danger' })
    },
  })
}

function useOpenInChoices(run: ApiRun, canResume: boolean) {
  const targets = useOpenTargets()
  const providers = useProviderStatus()
  const open = useMutation({
    mutationFn: (target: string) => openRunIn(run.id, target),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const availableRunners = usableRunners(providers.data)
  // The action routes remain authoritative for a stale browser. Once the complete status has
  // arrived, hide only unavailable *agent* handoffs; editors, Finder, and file tools stay
  // available because they do not launch a provider.
  const agentAvailable = (runner: ApiRun['runner']) =>
    !providers.isSuccess || availableRunners.includes(runner ?? 'claude')
  const canResumeHere = canResume && agentAvailable(lastSessionBackend(run))
  const choices: OpenInChoice[] = run.worktreePath
    ? (targets.data?.targets ?? [])
        .filter((target) => {
          const runner = cliTargetRunner(target.id)
          return runner === undefined || agentAvailable(runner)
        })
        // Agent-CLI targets (#402): the one matching this run's own runner resumes THIS run's
        // session when one exists — label that explicitly so it reads as different from just
        // opening the editor/file-manager entries. Every other CLI (wrong backend, or no session
        // yet) still opens, just starts clean — no silent cross-backend resume attempt.
        .map((target) => {
          const resumes = cliTargetResumes(run, target.id)
          return {
            target,
            ...(resumes ? { suffix: ' (resume)', title: "Resume this run's session" } : {}),
          }
        })
    : []
  return { canResumeHere, choices, open }
}

/** Does the run offer anything to open (a resumable session or a worktree target)? */
export function useHasOpenInTargets(run: ApiRun, canResume: boolean): boolean {
  const { canResumeHere, choices } = useOpenInChoices(run, canResume)
  return canResumeHere || choices.length > 0
}

/** The target buttons, worktree-path copy and resume command, without a frame. Renders nothing
 *  when the session cannot be resumed and the machine offers no targets (hosted mode). */
export function OpenInTargets({ run, canResume, onResume }: { run: ApiRun; canResume: boolean; onResume: () => void }) {
  const { canResumeHere, choices, open } = useOpenInChoices(run, canResume)
  const hint = resumeHint(run)
  if (!canResumeHere && choices.length === 0 && !hint) return null
  const copyPath = () => {
    const path = run.worktreePath
    if (!path) return
    void navigator.clipboard
      .writeText(path)
      .then(() => toast('Worktree path copied'))
      .catch(() => toast(`Path: ${path}`))
  }
  return (
    <>
      {canResumeHere || choices.length > 0 ? (
        <div className="task-open-targets flex flex-wrap gap-3">
          {canResumeHere ? <Button variant="outline" data-target="terminal-resume" onClick={onResume}><SquareTerminalIcon />Terminal (resume session)</Button> : null}
          {choices.map(({ target, suffix, title }) => {
            const Icon = openInIcon(target)
            return <Button variant="outline" key={target.id} data-target={target.id} title={title} disabled={open.isPending} onClick={() => open.mutate(target.id)}><Icon aria-hidden="true" />{target.label}{suffix ?? ''}</Button>
          })}
          {run.worktreePath ? <Button variant="outline" onClick={copyPath}><CopyIcon />Copy worktree path</Button> : null}
        </div>
      ) : null}
      {hint ? <div data-slot="resume-command" className="mt-5 border-t border-border pt-5">
        <h3 className="text-base font-medium">Resume in a terminal</h3>
        <pre className="my-4 whitespace-pre-wrap break-all rounded-lg border border-border bg-background p-4 text-xs">{hint}</pre>
        <Button variant="outline" onClick={() => void copyToClipboard(hint, 'Command copied to clipboard.')}><CopyIcon />Copy resume command</Button>
      </div> : null}
    </>
  )
}

/** The Session activity card's Workspace tools (hearsay-tools/cezarion#1333 mockup): "Open in…"
 *  as one menu (the resume item first, then the targets), and compact copies of the worktree path
 *  and the resume command. The full chooser panel stays behind the header's ··· menu. */
export function WorkspaceTools({ run, canResume, onResume }: { run: ApiRun; canResume: boolean; onResume: () => void }) {
  const { canResumeHere, choices, open } = useOpenInChoices(run, canResume)
  const hint = resumeHint(run)
  const path = run.worktreePath
  if (!canResumeHere && choices.length === 0 && !hint && !path) return null
  const compact = 'max-md:min-h-11'
  return (
    <div data-slot="workspace-tools" className="flex min-w-0 flex-wrap gap-2">
      {canResumeHere || choices.length > 0 ? (
        <OpenInMenu
          choices={choices}
          onPick={(target) => open.mutate(target)}
          disabled={open.isPending}
          triggerVariant="outline"
          className={compact}
          leading={canResumeHere ? (
            <DropdownMenuItem data-target="terminal-resume" onSelect={onResume}><SquareTerminalIcon aria-hidden="true" />Terminal (resume session)</DropdownMenuItem>
          ) : undefined}
        />
      ) : null}
      {path ? (
        <Button variant="outline" size="sm" className={compact} onClick={() => void copyToClipboard(path, 'Worktree path copied')}>
          <CopyIcon aria-hidden="true" />Copy worktree path
        </Button>
      ) : null}
      {hint ? (
        <Button variant="outline" size="sm" data-slot="resume-command" title={hint} className={compact} onClick={() => void copyToClipboard(hint, 'Command copied to clipboard.')}>
          <CopyIcon aria-hidden="true" />Copy resume command
        </Button>
      ) : null}
    </div>
  )
}

/**
 * "Open in…" session takeover (#open-in): resume the session in a real terminal, open the run's
 * worktree in a local editor / Finder / terminal / agent CLI, or copy its path.
 *
 * The menu itself is the shared `OpenInMenu` (components/open-in-menu.tsx); what lives here is
 * everything run-SPECIFIC — the resume item, which agent handoffs are currently usable, the
 * `(resume)` labelling, and the copy-path row. Renders when the session can be resumed OR the
 * machine offers worktree targets (both empty in hosted mode → nothing to show).
 */
export function OpenInMenuForRun({
  run,
  canResume,
  onResume,
  onOpen,
  onClose,
}: {
  run: ApiRun
  canResume: boolean
  onResume: () => void
  onOpen?: () => void
  onClose?: () => void
}) {
  const { canResumeHere, choices } = useOpenInChoices(run, canResume)
  if (!canResumeHere && choices.length === 0) return null
  if (onOpen) return <DropdownMenuItem onSelect={onOpen}>Open in…</DropdownMenuItem>
  return (
    <section aria-label="Open task worktree in…" className="task-action-panel my-5 rounded-xl border border-border bg-card p-6">
      <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-medium">Open task worktree in…</h2><Button variant="ghost" size="icon" aria-label="Close worktree chooser" onClick={onClose}><XIcon /></Button></div>
      {run.worktreePath ? <p className="my-4 break-all text-xs text-muted-foreground">{run.worktreePath}</p> : null}
      <div className="mt-4"><OpenInTargets run={run} canResume={canResume} onResume={onResume} /></div>
    </section>
  )
}

export function BranchCopy({ branch }: { branch: string }) {
  const [copiedBranch, setCopiedBranch] = useState<string | null>(null)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (resetTimer.current !== null) clearTimeout(resetTimer.current)
  }, [])

  const copied = copiedBranch === branch
  const copy = async () => {
    if (resetTimer.current !== null) clearTimeout(resetTimer.current)
    setCopiedBranch(null)
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(branch)
      setCopiedBranch(branch)
      resetTimer.current = setTimeout(() => setCopiedBranch(null), 2000)
    } catch {
      toast(`Could not copy branch. Select and copy: ${branch}`)
    }
  }

  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1">
      <span
        data-slot="branch-chip"
        className="min-w-0 rounded-sm border border-border bg-card px-1.5 py-px font-mono text-[11px] font-medium break-all"
      >
        {branch}
      </span>
      <button
        type="button"
        aria-label={copied ? 'Copied branch name' : 'Copy branch name'}
        onClick={() => void copy()}
        className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-sm px-2 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link-foreground md:min-h-8"
      >
        <CopyIcon className="size-3.5" aria-hidden="true" />
        <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </span>
  )
}

/**
 * Every issue and PR the task points at, as status chips (#416, #692): own-repo chips open the
 * task's item tab, a foreign reference keeps its GitHub link, and a conflicting PR offers Resolve
 * conflicts in its panel. Statuses come from the nearest `ReferenceStatusProvider`.
 */
export function LinkedReferences({ run }: { run: ApiRun }) {
  // #526: the issue chip may be synthesized from the CEZ:ISSUE marker, and the only repository
  // such a link may name is the one on screen — never the transcript's.
  const repoBase = useProjectRepoBase()
  const referenceProjectId = useReferenceProjectId()
  const itemPath = (reference: TaskReference) =>
    referenceProjectId === undefined ? undefined : taskItemPath(referenceProjectId, run.id, reference, repoBase)
  const references = useMemo(() => taskReferences(run, repoBase), [run, repoBase])
  const prChips: ReactNode[] = []
  const issueChips: ReactNode[] = []
  // EVERY PR the task points at, in `taskReferences` order — the same order, and the same
  // statuses, the global Tasks table paints. A task opened on someone else's PR that pushes a
  // follow-up of its own is about both, and its own page is the last place that should have to
  // pick one.
  //
  // A reference with no URL still gets its chip, exactly as All tasks paints it: a number-only
  // reference is what a `CEZ:PR` declaration looks like before any link is scraped, and the two
  // pages read their repository from DIFFERENT places (this one from health's remote, All tasks
  // from the project registry's `repoUrl`) — so "no URL here" never means "nothing to show".
  // `ReferenceChip` degrades such a chip to inert text on its own.
  const prReferences = references.filter((reference) => reference.kind === 'PR')
  for (const reference of prReferences) {
    prChips.push(
      <ReferenceChip
        key={referenceKey(reference)}
        reference={reference}
        to={itemPath(reference)}
        taskTitle={runTitle(run)}
        // 44px on touch (#617 01b): the sidebar row shows references as plain text there, so
        // this header is where they are tapped. CSS px, not `min-h-11`: spacing units follow
        // density, and ultra would make that 33px.
        className="h-5 no-hover:min-h-[44px] no-hover:min-w-[44px]"
        // Shown only on a chip that IS conflicting — the chip decides that, being the thing that
        // knows — and mounted only while its panel is open. The same component the Tasks table
        // hands its chips, so both send the same prompt on the same seam.
        conflictAction={<ResolveConflictsButton run={run} prNumber={reference.number} />}
      />,
    )
  }
  // The one PR chip `taskReferences` cannot express: a forge URL whose last segment is not a
  // number (`taskPrUrl`'s own tolerance — an unrecognized forge still gets a working link, just
  // without a number cezar would be inventing). Gated on that URL not being painted already,
  // NOT on there being no chips at all: today every `pullRequestUrl` is a GitHub `…/pull/N` and
  // the two are the same test, but a forge whose PR URLs do not end in a number (#847's GitLab
  // adapter) would have a `prNumber` chip standing in front of a link that then never rendered.
  const prUrl = taskPrUrl(run)
  if (prUrl && isHttpUrl(prUrl) && !prReferences.some((reference) => reference.url === prUrl)) {
    prChips.push(
      <ReferenceChip
        key="pr"
        reference={{ kind: 'PR', url: prUrl }}
        taskTitle={runTitle(run)}
        className="h-5 no-hover:min-h-[44px] no-hover:min-w-[44px]"
      />,
    )
  }
  const issueReferences = references.filter(reference => reference.kind === 'Issue')
  for (const reference of issueReferences) {
    issueChips.push(
      <ReferenceChip
        key={referenceKey(reference)}
        reference={reference}
        to={itemPath(reference)}
        taskTitle={runTitle(run)}
        className="h-5 no-hover:min-h-[44px] no-hover:min-w-[44px]"
      />,
    )
  }
  const issueUrl = taskIssueUrl(run, repoBase)
  if (issueUrl && isHttpUrl(issueUrl) && !issueReferences.some(reference => reference.url === issueUrl)) {
    const number = prNumber(issueUrl)
    issueChips.push(
      <ReferenceChip
        key="issue"
        reference={{ kind: 'Issue', ...(number ? { number: Number(number) } : {}), url: issueUrl }}
        to={number ? itemPath({ kind: 'Issue', number: Number(number), url: issueUrl }) : undefined}
        taskTitle={runTitle(run)}
        className="h-5 no-hover:min-h-[44px] no-hover:min-w-[44px]"
      />,
    )
  }
  if (prChips.length === 0 && issueChips.length === 0) return null
  return <div data-slot="linked-references" className="flex min-w-0 flex-col gap-3">
    {([['PR', 'PRs', prChips], ['Issue', 'Issues', issueChips]] as const).map(([kind, label, chips]) => chips.length > 0 ? (
      <div key={kind} data-reference-kind={kind} className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
        <span className="font-medium text-foreground">{label}</span>
        <div className="flex min-w-0 flex-wrap items-center gap-2">{chips}</div>
      </div>
    ) : null)}
  </div>
}
