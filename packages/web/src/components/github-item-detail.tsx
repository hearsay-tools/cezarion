import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeftIcon, ExternalLinkIcon, MessageSquareIcon, LoaderCircleIcon } from 'lucide-react'
import { ArrowLeftIcon, CheckIcon, CircleIcon, CircleXIcon, ChevronRightIcon, RefreshCwIcon, TriangleAlertIcon } from '@/components/design-icons'
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { Link } from '@/lib/project-router'

import { getGithubPrChanges, getGithubPrMergeState, mergeGithubPr } from '@/api/client'
import { queryKeys, useGithubComments, useGithubPrChanges, useReferenceProjectId } from '@/api/queries'
import type {
  GithubComment,
  GithubItem,
  GithubTimelineEvent,
  GithubTimelineEventKind,
  GithubMergeMethod,
} from '@open-mercato/cezar-api-client'
import { Diff, type DiffFileChange } from '@/components/diff'
import { TabLink } from '@/components/tab-link'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
import { shortAge } from '@/lib/format'
import { cn, isHttpUrl } from '@/lib/utils'

import { Markdown } from '@/routes/task-thread/markdown'
import { labelChipStyle } from '@/routes/github/github-filter'
import { GITHUB_LIST_LIMIT, githubFilterPath, type GithubFilter } from '@/routes/github/github-sidebar-model'

/** A single label pill, tinted with its GitHub color (or neutral when unknown). */
export function LabelChip({ label, color, plain = false }: { label: string; color: string | undefined; plain?: boolean }) {
  return (
    <span
      data-slot="gh-label"
      data-label={label}
      style={plain ? undefined : labelChipStyle(color)}
      className={plain ? "text-[11px] font-normal text-muted-foreground" : "rounded-full border px-1.5 py-px text-[12px] font-medium"}
    >
      {label}
    </span>
  )
}

/**
 * One issue or PR in full — description, labels, checks, thread, merge box — shared by the GitHub
 * view and the task page's item tabs (#692). The GitHub view passes its list as `backLink` and its
 * Conversation/Changes state as `subNav`; a task tab passes `null` for both, so it always shows the
 * conversation and links a PR's diff out to the GitHub view instead.
 */
export function GithubItemDetail({
  item,
  colors,
  checks,
  backLink,
  subNav,
  onRunAgent,
  children,
}: {
  item: GithubItem
  colors: Record<string, string>
  /** Resolved checks glyph — the lazily-hydrated value overrides the list's `null` (#664). */
  checks?: GithubItem['checks']
  /** The phone-only "Back to the list" target; `null` renders no back link. */
  backLink: { to: string } | null
  /** The PR Conversation/Changes tabs, keeping the list's `?filter=`; `null` renders a
   *  "Files changed" link to the GitHub view instead and always shows the conversation. */
  subNav: { filter: GithubFilter | null; changes: boolean } | null
  /** The merge box's "Run agent on this PR" on a conflicting PR; absent renders no button, so a
   *  surface with no agent panel never offers an inert control. */
  onRunAgent?: () => void
  children?: ReactNode
}) {
  const changes = subNav?.changes ?? false
  const kindWord = item.kind === 'pr' ? 'pull request' : 'issue'
  const hasDiffStat = item.kind === 'pr' && Boolean(item.additions || item.deletions)
  return (
    <article data-slot="gh-detail-inner" className="min-w-0 px-4 py-4 md:px-7 md:py-5">
      {backLink ? (
        <Link
          to={backLink.to}
          data-slot="gh-back"
          className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground md:hidden"
        >
          <ArrowLeftIcon size={16} aria-hidden="true" className="size-3.5" />
          Back to the list
        </Link>
      ) : null}

      <div data-slot="gh-description-card" className={item.kind === 'pr' ? 'rounded-xl border border-border bg-card p-6' : undefined}>
      {item.kind === 'pr' ? <h2 className="mb-4 text-[22px] leading-snug font-normal">#{item.number} {item.title}</h2> : null}
      <p data-slot="gh-meta" className="flex flex-wrap items-center gap-x-1.5 font-mono text-[11px] text-soft-foreground">
        <span>#{item.number}</span>·<span>{kindWord}</span>·<span>opened by {item.author}</span>·
        <span>{shortAge(item.createdAt)} ago</span>
        {item.comments ? (
          <>
            ·<CommentCount count={item.comments} />
          </>
        ) : null}
        {hasDiffStat ? (
          <>
            ·
            <span data-slot="gh-diffstat">
              <span className="text-success">+{item.additions ?? 0}</span>{' '}
              <span className="text-danger">−{item.deletions ?? 0}</span>
            </span>
          </>
        ) : null}
        ·
        {/* href protocol guard (#431): link only for http(s) URLs. */}
        {isHttpUrl(item.url) ? (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            data-slot="gh-open-link"
            className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground hover:underline"
          >
            open on GitHub
            <ExternalLinkIcon aria-hidden="true" className="size-2.5" />
          </a>
        ) : (
          <span data-slot="gh-open-link" className="text-muted-foreground">
            open on GitHub
          </span>
        )}
      </p>

      {item.kind !== 'pr' ? <h2 className="mt-2 text-[22px] leading-snug font-normal">{item.title}</h2> : null}

      {item.kind === 'pr' && subNav ? (
        <nav aria-label="Pull request detail" className="mt-4 flex border-b border-border">
          <TabLink to={githubFilterPath('prs', subNav.filter, item.number)} active={!changes}>Conversation</TabLink>
          <TabLink to={githubFilterPath('prs', subNav.filter, item.number, '/changes')} active={changes}>Changes</TabLink>
        </nav>
      ) : item.kind === 'pr' ? (
        <Link
          to={githubFilterPath('prs', null, item.number, '/changes')}
          data-slot="gh-files-changed"
          className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
        >
          Files changed
        </Link>
      ) : null}

      {item.labels.length > 0 || checks ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {item.labels.map((label) => (
            <LabelChip key={label} label={label} color={colors[label]} />
          ))}
          {checks ? <ChecksBadge checks={checks} url={item.url} /> : null}
        </div>
      ) : null}

      {changes && item.kind === 'pr' ? <GithubPrChanges item={item} /> : <>
      <div data-slot="gh-body" className="mt-5 text-sm">
        {item.body ? (
          <Markdown>{item.body}</Markdown>
        ) : (
          <p className="text-soft-foreground">(no description)</p>
        )}
      </div>

      <GithubThread item={item} colors={colors} />

      </>}
      </div>
      {item.kind === 'pr' ? <GithubMergeBox number={item.number} onRunAgent={onRunAgent} /> : null}
      {children}
    </article>
  )
}

const mergeLabels: Record<GithubMergeMethod, string> = {
  squash: 'Squash and merge',
  merge: 'Create a merge commit',
  rebase: 'Rebase and merge',
}

type MergeRequirementState = 'passing' | 'failing' | 'pending' | 'unknown'

function MergeRequirementIcon({ state }: { state: MergeRequirementState }) {
  const iconClass = 'size-4 shrink-0'
  if (state === 'passing') return <CheckIcon size={16} aria-hidden="true" data-slot="gh-merge-status-passing" className={cn(iconClass, 'text-success')} />
  if (state === 'failing') return <CircleXIcon size={16} aria-hidden="true" data-slot="gh-merge-status-failing" className={cn(iconClass, 'text-danger')} />
  if (state === 'pending') return <LoaderCircleIcon aria-hidden="true" data-slot="gh-merge-status-pending" className={cn(iconClass, 'animate-spin text-warning')} />
  return <CircleIcon size={16} aria-hidden="true" data-slot="gh-merge-status-unknown" className={cn(iconClass, 'text-soft-foreground')} />
}

function GithubMergeBox({ number, onRunAgent }: { number: number; onRunAgent?: () => void }) {
  const queryClient = useQueryClient()
  // Ref-status batches are keyed by the explicit project, not `queryScope()` (queries.ts).
  const referenceProjectId = useReferenceProjectId()
  const mergeState = useQuery({
    queryKey: queryKeys.githubMergeState(number),
    queryFn: ({ signal }) => getGithubPrMergeState(number, {}, { signal }),
    retry: false,
  })
  const state = mergeState.data?.available ? mergeState.data.mergeState : null
  const [method, setMethod] = useState<GithubMergeMethod | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [overrideRules, setOverrideRules] = useState(false)
  const refreshMergeState = useMutation({
    mutationFn: () => getGithubPrMergeState(number, { refresh: true }),
    onSuccess: (data) => queryClient.setQueryData(queryKeys.githubMergeState(number), data),
    onError: (error) => toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }),
  })
  const selectedMethod = method && state?.methods.includes(method)
    ? method
    : state?.defaultMethod ?? state?.methods[0] ?? null
  const merge = useMutation({
    mutationFn: () => {
      if (!state || !selectedMethod) throw new Error('No merge method is available.')
      return mergeGithubPr(number, {
        method: selectedMethod,
        expectedHeadSha: state.headSha,
        ...(overrideRules && state.canOverride ? { overrideRules: true } : {}),
      })
    },
    onSuccess: () => {
      setConfirming(false)
      toast(`Pull request #${number} merged`)
      void queryClient.invalidateQueries({ queryKey: queryKeys.githubMergeState(number) })
      // The single list query (#664) — a merged PR drops out of the open set on the next fetch.
      void queryClient.invalidateQueries({ queryKey: queryKeys.github({ limit: GITHUB_LIST_LIMIT }) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.githubComments('pr', number) })
      // The task tab's item (#692), and every chip and tab glyph of this project: the server
      // forgot its cached status on merge, so a reread answers `merged` without a reload.
      void queryClient.invalidateQueries({ queryKey: queryKeys.githubItem('pr', number) })
      if (referenceProjectId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.githubRefStatusOf(referenceProjectId) })
      }
    },
    onError: (error) => {
      toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
      void queryClient.invalidateQueries({ queryKey: queryKeys.githubMergeState(number) })
    },
  })

  if (mergeState.isPending) {
    return <Skeleton data-slot="gh-merge-loading" className="mt-6 h-32 w-full" />
  }
  if (!state) {
    return (
      <section data-slot="gh-merge-unavailable" className="mt-6 rounded-lg border border-border bg-card p-4 text-sm">
        <p className="font-medium">Merge status unavailable</p>
        <p className="mt-1 text-xs text-soft-foreground">
          {mergeState.data?.available === false ? mergeState.data.reason : 'GitHub could not load merge requirements.'}
        </p>
      </section>
    )
  }

  const title =
    state.state === 'merged' ? 'Merged'
      : state.state === 'closed' ? 'Closed'
        : state.isDraft ? 'Draft'
          : state.mergeable === 'conflicting' ? 'Conflicts must be resolved'
            : state.canMerge ? 'Ready to merge'
              : state.eligibility === 'unknown' ? 'Merge blocked · Requirements unknown' : 'Merge blocked'
  const reviewState: MergeRequirementState =
    state.reviewDecision === 'approved' ? 'passing'
      : state.reviewDecision === 'unknown' ? 'unknown'
        : 'failing'
  const conflictState: MergeRequirementState =
    state.mergeable === 'mergeable' ? 'passing'
      : state.mergeable === 'conflicting' ? 'failing'
        : 'unknown'
  const mergeEnabled = Boolean(selectedMethod && (state.canMerge || (state.canOverride && overrideRules)))

  return (
    <section data-slot="gh-merge-box" data-eligibility={state.eligibility} data-conflicting={state.mergeable === 'conflicting' ? 'true' : undefined} aria-live="polite" className="mt-6 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        {state.canMerge ? (
          <CheckIcon size={16} aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-success" />
        ) : (
          <TriangleAlertIcon size={16} aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">{title}</h3>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={refreshMergeState.isPending}
              onClick={() => refreshMergeState.mutate()}
            >
              <RefreshCwIcon size={16} aria-hidden="true" className={cn('size-3.5', refreshMergeState.isPending && 'animate-spin')} />
              Refresh
            </Button>
          </div>
          <p className="mt-1 font-mono text-[11px] text-soft-foreground">
            {state.headRef} ({state.headSha.slice(0, 7)}) → {state.baseRef}
          </p>
          <ul className="mt-3 space-y-2 text-xs">
            <li className="flex items-center gap-2">
              <MergeRequirementIcon state={reviewState} />
              <span>Reviews: {state.reviewDecision.replaceAll('-', ' ')}</span>
            </li>
            <li className="flex items-center gap-2">
              <MergeRequirementIcon state={conflictState} />
              <span>Conflicts: {state.mergeable === 'conflicting' ? 'present' : state.mergeable === 'mergeable' ? 'none' : 'unknown'}</span>
            </li>
            {state.checks.length === 0 ? <li>No checks configured</li> : state.checks.map((check) => (
              <li key={check.name} className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <MergeRequirementIcon state={check.state} />
                  <span>{check.name} · {check.state}{check.required === true ? ' · required' : check.required === null ? ' · requiredness unknown' : ''}</span>
                </span>
                {check.url && isHttpUrl(check.url) ? <a href={check.url} target="_blank" rel="noopener noreferrer" className="text-muted-foreground underline">details</a> : null}
              </li>
            ))}
            {state.blockers.map((blocker) => <li key={blocker.code} className="text-soft-foreground">{blocker.message}</li>)}
          </ul>
          {state.mergeable === 'conflicting' && onRunAgent ? <Button className="mt-4" onClick={onRunAgent}>Run agent on this PR</Button> : null}
          {state.canOverride ? (
            <label className="mt-4 flex cursor-pointer items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs">
              <input
                type="checkbox"
                checked={overrideRules}
                onChange={(event) => setOverrideRules(event.target.checked)}
                className="mt-0.5 size-4 accent-accent-strong"
              />
              <span>
                <span className="block font-medium">Merge without waiting for requirements</span>
                <span className="mt-0.5 block text-soft-foreground">GitHub will allow this only if your permissions can bypass the repository rules.</span>
              </span>
            </label>
          ) : null}
          {state.eligibility === 'unknown' ? (
            <p className="mt-4 text-xs text-muted-foreground">
              GitHub could not confirm review and branch-protection requirements. Passing checks do not establish merge readiness.
            </p>
          ) : null}
          {state.state === 'open' && state.methods.length > 0 ? (
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <select
                aria-label="Merge method"
                value={selectedMethod ?? ''}
                onChange={(event) => setMethod(event.target.value as GithubMergeMethod)}
                className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
              >
                {state.methods.map((candidate) => <option key={candidate} value={candidate}>{mergeLabels[candidate]}</option>)}
              </select>
              <Button disabled={!mergeEnabled} onClick={() => setConfirming(true)}>
                {selectedMethod ? mergeLabels[selectedMethod] : 'Merge'}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent data-slot="gh-merge-confirm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{selectedMethod ? mergeLabels[selectedMethod] : 'Merge'} pull request #{number}?</DialogTitle>
            <DialogDescription asChild>
              <div>
                <p>This will merge “{state.title}” into {state.baseRef}. GitHub will re-check the exact reviewed head before changing the repository.</p>
                {overrideRules && state.canOverride ? (
                  <p data-slot="gh-bypass-warning" className="mt-4 text-sm text-warning">
                    You are asking GitHub to bypass unmet repository requirements; GitHub may refuse if your permissions do not allow it.
                  </p>
                ) : null}
              </div>
            </DialogDescription>
          </DialogHeader>
          {merge.error ? <p className="text-sm text-danger">{merge.error.message}</p> : null}
          <DialogFooter>
            <Button variant="outline" disabled={merge.isPending} onClick={() => setConfirming(false)}>Cancel</Button>
            <Button disabled={merge.isPending} onClick={() => merge.mutate()}>
              {merge.isPending ? 'Merging…' : selectedMethod ? mergeLabels[selectedMethod] : 'Merge'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function GithubPrChanges({ item }: { item: GithubItem }) {
  const queryClient = useQueryClient()
  const query = useGithubPrChanges(item.number)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const data = query.data
  const files = data?.available
    ? data.files.filter((file) => file.path.toLowerCase().includes(filter.toLowerCase()))
    : []
  const current = files.findIndex((file) => file.path === selected)
  useEffect(() => {
    if (files.length > 0 && !files.some((file) => file.path === selected)) setSelected(files[0]!.path)
  }, [data?.available ? data.headSha : '', filter])
  const refresh = async () => {
    const oldHead = data?.available ? data.headSha : null
    const next = await getGithubPrChanges(item.number, { refresh: true })
    queryClient.setQueryData(['github', 'pr-changes', item.number], next)
    if (next.available && oldHead && oldHead !== next.headSha) {
      setSelected(next.files[0]?.path ?? null)
      toast('The reviewed revision changed.')
    }
  }
  if (query.isPending) return <p aria-live="polite" className="mt-6 text-sm text-muted-foreground">Loading changed files…</p>
  if (query.isError || !data) return <p className="mt-6 text-sm text-danger">Changed files could not be loaded.</p>
  if (!data.available) return <p className="mt-6 text-sm text-muted-foreground">{data.reason}</p>
  const diffFiles: DiffFileChange[] = files.map((file) => ({
    path: file.path,
    ...(file.previousPath ? { oldPath: file.previousPath } : {}),
    status: file.status === 'removed' ? 'deleted' : file.status === 'changed' ? 'modified' : file.status,
    adds: file.additions,
    dels: file.deletions,
    binary: file.patchUnavailableReason === 'binary',
    patch: file.patch ?? '',
  }))
  const fallback = isHttpUrl(item.url) ? `${item.url}/files` : null
  const active = files.find((file) => file.path === selected)
  return (
    <section data-slot="gh-pr-changes" className="mt-5 min-w-0">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <strong>{data.files.length} changed files</strong>
        <span className="text-success">+{data.additions}</span>
        <span className="text-danger">−{data.deletions}</span>
        <span className="font-mono text-muted-foreground" title={data.headSha}>head {data.headSha.slice(0, 8)}</span>
        <Button type="button" variant="outline" size="sm" className="ml-auto min-h-11" onClick={() => void refresh()}>Refresh</Button>
      </div>
      {data.truncated ? <p role="status" className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">{data.reason ?? 'This response is incomplete.'} {fallback ? <a href={fallback} target="_blank" rel="noopener noreferrer" className="underline">Open all files on GitHub</a> : null}</p> : null}
      <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="min-w-0">
          <input aria-label="Filter changed files" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files…" className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm" />
          <select aria-label="Select changed file" value={selected ?? ''} onChange={(e) => setSelected(e.target.value)} className="mt-2 min-h-11 w-full rounded-md border border-input bg-background px-2 text-sm lg:hidden">
            {files.map((file) => <option key={file.path}>{file.path}</option>)}
          </select>
          <ul className="mt-2 hidden max-h-[60vh] overflow-auto lg:block">
            {files.map((file) => <li key={file.path}><button type="button" onClick={() => setSelected(file.path)} className={cn('min-h-11 w-full truncate rounded px-2 text-left text-xs', selected === file.path && 'bg-muted font-medium')} title={file.path}>{file.status} · {file.path} <span className="text-success">+{file.additions}</span> <span className="text-danger">−{file.deletions}</span></button></li>)}
          </ul>
        </aside>
        <div className="min-w-0">
          <div className="mb-2 flex justify-end gap-1">
            <Button aria-label="Previous file" variant="outline" size="icon" className="min-h-11 min-w-11" disabled={current <= 0} onClick={() => setSelected(files[current - 1]?.path ?? null)}><ChevronLeftIcon /></Button>
            <Button aria-label="Next file" variant="outline" size="icon" className="min-h-11 min-w-11" disabled={current < 0 || current >= files.length - 1} onClick={() => setSelected(files[current + 1]?.path ?? null)}><ChevronRightIcon size={16} /></Button>
          </div>
          {files.length === 0 ? <p className="text-sm text-muted-foreground">No changed files match this filter.</p> : <>
            <Diff files={diffFiles.filter((file) => file.path === selected)} wrap className="min-w-0" />
            {active && !active.patch ? <p className="rounded-b border border-border p-3 text-xs text-muted-foreground">Patch unavailable: {active.patchUnavailableReason ?? 'not-provided'}.</p> : null}
          </>}
        </div>
      </div>
    </section>
  )
}

/** The conversation thread (#499): comments (+ PR review summaries) rendered under the body, each
 *  body through the shared `Markdown` component so images and code fences render exactly as the
 *  issue body does. Lazy — only fetched while this detail view is mounted. Everything degrades:
 *  loading → skeleton, unreachable → one-line reason + "open on GitHub", empty → nothing (the
 *  count badge already said there were none). */
function GithubThread({ item, colors }: { item: GithubItem; colors: Record<string, string> }) {
  const thread = useGithubComments(item.kind, item.number)
  const data = thread.data

  // Interleave client-side (#525): the server returns comments and events as two independently
  // capped arrays and deliberately does NOT merge them — ordering is presentation, and a
  // server-side merge would either reshape the §2-protected response or force a combined cap.
  const entries = useMemo(() => {
    const merged: ThreadRow[] = [
      ...(data?.comments ?? []).map((comment) => ({ row: 'comment' as const, comment })),
      ...(data?.events ?? []).map((event) => ({ row: 'event' as const, event })),
    ]
    // Compare parsed instants, not the raw strings. Both streams are UTC, but at DIFFERENT
    // precisions: events go through `toISOString()` (always milliseconds, `…00.000Z`) while
    // comments keep GitHub's second-precision `…00Z`. A string compare puts `.` (46) before `Z`
    // (90), so an event would always sort above a comment made in the same second — not a
    // tie-break, a systematic bias. Array.prototype.sort is stable, so equal instants keep
    // insertion order (comments first, matching pre-#525 behavior).
    //
    // `normalizeReviews` emits `createdAt: ''` for a review with no `submitted_at` (a pending
    // one), and `Date.parse('')` is NaN. An NaN comparator result coerces to +0, which makes the
    // sort inconsistent rather than crashing — so those rows are pinned to the top explicitly
    // instead of landing wherever the engine happens to leave them.
    const key = (entry: ThreadRow): number => {
      const parsed = Date.parse(at(entry))
      return Number.isNaN(parsed) ? -Infinity : parsed
    }
    return merged.sort((a, b) => key(a) - key(b))
  }, [data?.comments, data?.events])

  if (thread.isPending) {
    return (
      <section data-slot="gh-thread-loading" className="mt-6 border-t border-border pt-5">
        <Skeleton className="mb-3 h-3 w-24" />
        <div className="flex flex-col gap-3">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      </section>
    )
  }

  if (!data || !data.available) {
    const reason = data?.reason ?? (thread.error instanceof Error ? thread.error.message : 'could not load comments')
    return (
      <section data-slot="gh-thread-error" className="mt-6 border-t border-border pt-5 text-xs text-soft-foreground">
        <span>Couldn’t load comments — {reason}. </span>
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground hover:underline"
        >
          open on GitHub
          <ExternalLinkIcon aria-hidden="true" className="size-2.5" />
        </a>
      </section>
    )
  }

  // An empty thread renders nothing: the count badge already communicated "no discussion", and an
  // empty "Activity" section would be noise on the many quiet issues/PRs. Counts BOTH streams
  // (#525) — keyed on comments alone this would hide the whole feature on its motivating case, a
  // merged PR with commits, labels and a merge event but no conversation.
  if (entries.length === 0) return null

  return (
    <section data-slot="gh-thread" className="mt-6 border-t border-border pt-5">
      <h3
        data-slot="gh-thread-header"
        className="mb-4 text-[11px] font-semibold tracking-wide text-soft-foreground uppercase"
      >
        {/* "Activity", not "Comments": heading a twenty-row list `Comments · 2` would be
            incoherent once events render. The comment count stays as a secondary. This is a
            different surface from the row badge, which still counts comments only. */}
        Activity · {data.comments.length} comment{data.comments.length === 1 ? '' : 's'}
      </h3>
      <ul className="flex flex-col gap-5">
        {groupCommitRuns(entries).map((grouped) =>
          grouped.group === 'commits' ? (
            <CommitGroup key={grouped.commits[0]!.id} commits={grouped.commits} colors={colors} />
          ) : grouped.entry.row === 'comment' ? (
            <ThreadEntry
              key={`${grouped.entry.comment.kind}-${grouped.entry.comment.id}`}
              comment={grouped.entry.comment}
            />
          ) : (
            <EventRow key={grouped.entry.event.id} event={grouped.entry.event} colors={colors} />
          ),
        )}
      </ul>
      {data.truncated ? (
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          data-slot="gh-thread-truncated"
          className="mt-4 inline-flex items-center gap-0.5 text-xs text-soft-foreground hover:text-foreground hover:underline"
        >
          thread truncated — open on GitHub
          <ExternalLinkIcon aria-hidden="true" className="size-2.5" />
        </a>
      ) : null}
    </section>
  )
}

/** One row in the interleaved thread (#525) — a conversation comment/review, or a timeline event.
 *  A discriminated union rather than a widened `GithubComment['kind']`, so each branch keeps its
 *  own narrowing. */
export type ThreadRow =
  | { row: 'comment'; comment: GithubComment }
  | { row: 'event'; event: GithubTimelineEvent }

/** Sort key for either row shape. */
const at = (entry: ThreadRow): string =>
  entry.row === 'comment' ? entry.comment.createdAt : entry.event.createdAt

/** A rendered row after commit-run grouping: either a single row, or a run of consecutive commits
 *  by one author that collapses behind an expander. */
export type GroupedRow =
  | { group: 'single'; entry: ThreadRow }
  | { group: 'commits'; commits: GithubTimelineEvent[] }

/**
 * Collapse runs of consecutive `committed` events by the same author (#525), the way github.com
 * does — otherwise a 40-commit PR buries the discussion.
 *
 * Entirely client-side and purely presentational: the wire stays a flat list where every commit
 * keeps its own message and CI glyph, so nothing is lost to a collapse and the heuristic can
 * change without a §2 conversation.
 *
 * A run ends at an author change or at any non-commit row. A run of one is not a group — a lone
 * commit should render as a plain row, not a "1 commit" expander. Exported for unit tests.
 */
export function groupCommitRuns(entries: ThreadRow[]): GroupedRow[] {
  const out: GroupedRow[] = []
  let run: GithubTimelineEvent[] = []

  const flush = () => {
    if (run.length === 0) return
    // A single commit is not a group.
    if (run.length === 1) out.push({ group: 'single', entry: { row: 'event', event: run[0]! } })
    else out.push({ group: 'commits', commits: run })
    run = []
  }

  for (const entry of entries) {
    const isCommit = entry.row === 'event' && entry.event.kind === 'committed'
    if (isCommit && entry.row === 'event') {
      const prev = run[run.length - 1]
      if (prev && prev.actor !== entry.event.actor) flush() // author change ends the run
      run.push(entry.event)
      continue
    }
    flush() // any non-commit row interrupts the run
    out.push({ group: 'single', entry })
  }
  flush()
  return out
}

/** A collapsed run of consecutive commits — `{actor} added {n} commits`, expanding to the
 *  individual rows, each of which keeps its own message and CI glyph. */
function CommitGroup({ commits, colors }: { commits: GithubTimelineEvent[]; colors: Record<string, string> }) {
  const [open, setOpen] = useState(false)
  const actor = commits[0]?.actor ?? '?'

  if (open) {
    return (
      <>
        <li data-slot="gh-commit-group" data-open="true" className="min-w-0">
          <button
            type="button"
            aria-expanded={true}
            onClick={() => setOpen(false)}
            className="flex items-center gap-1.5 font-mono text-[11px] text-soft-foreground hover:text-foreground"
          >
            <span aria-hidden="true">{EVENT_GLYPH.committed}</span>
            <span className="font-sans font-medium text-foreground">{actor}</span>
            <span>added {commits.length} commits</span>
          </button>
        </li>
        {commits.map((commit) => (
          <EventRow key={commit.id} event={commit} colors={colors} />
        ))}
      </>
    )
  }

  return (
    <li data-slot="gh-commit-group" data-open="false" className="min-w-0">
      <button
        type="button"
        aria-expanded={false}
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 font-mono text-[11px] text-soft-foreground hover:text-foreground"
      >
        <span aria-hidden="true">{EVENT_GLYPH.committed}</span>
        <span className="font-sans font-medium text-foreground">{actor}</span>
        <span>added {commits.length} commits</span>
        <span className="shrink-0">{shortAge(commits[commits.length - 1]!.createdAt)}</span>
      </button>
    </li>
  )
}

/** Per-kind glyph. Deliberately text glyphs rather than icon components: `EventRow` is a single
 *  muted line and an icon set would pull it visually level with the comment cards it sits
 *  between. */
const EVENT_GLYPH: Record<GithubTimelineEventKind, string> = {
  committed: '⚙',
  labeled: '◆',
  unlabeled: '◇',
  assigned: '◍',
  unassigned: '◌',
  merged: '⑃',
  closed: '⊘',
  reopened: '⊙',
  head_ref_force_pushed: '↻',
  'cross-referenced': '↗',
  renamed: '✎',
}

/**
 * One timeline event — deliberately NOT a `ThreadEntry`: single line, muted, no card, no avatar
 * block, so events read as connective tissue between comments rather than competing with them.
 * Mirrors github.com's density.
 */
function EventRow({ event, colors }: { event: GithubTimelineEvent; colors: Record<string, string> }) {
  return (
    <li
      data-slot="gh-event-row"
      data-kind={event.kind}
      className={cn(
        'flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-soft-foreground',
        event.kind === 'merged' && 'text-accent-foreground',
      )}
    >
      <span aria-hidden="true" className="shrink-0">
        {EVENT_GLYPH[event.kind]}
      </span>
      <span className="font-sans font-medium text-foreground">{event.actor}</span>
      <EventPhrase event={event} colors={colors} />
      <span className="shrink-0">{shortAge(event.createdAt)}</span>
      {event.url ? (
        <a
          href={event.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`open ${event.kind} on GitHub`}
          className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
        >
          <ExternalLinkIcon aria-hidden="true" className="size-2.5" />
        </a>
      ) : null}
    </li>
  )
}

/** The kind-specific middle of an event row. Split out so `EventRow` stays a layout shell and
 *  each phrase can be asserted on its own in tests. */
function EventPhrase({ event, colors }: { event: GithubTimelineEvent; colors: Record<string, string> }) {
  switch (event.kind) {
    case 'committed':
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">committed</span>
          {event.sha ? <span className="shrink-0 text-muted-foreground">{event.sha.slice(0, 7)}</span> : null}
          {event.message ? (
            <span className="truncate font-sans text-foreground">{event.message}</span>
          ) : null}
          <CommitChecks checks={event.checks} />
        </span>
      )
    case 'labeled':
    case 'unlabeled':
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">{event.kind === 'labeled' ? 'added the' : 'removed the'}</span>
          {event.label ? (
            <span
              data-slot="gh-event-label"
              style={labelChipStyle(event.label.color ?? colors[event.label.name])}
              className="max-w-[12rem] truncate rounded-full border px-1.5 py-px font-sans text-[12px]"
            >
              {event.label.name}
            </span>
          ) : null}
          <span className="shrink-0">label</span>
        </span>
      )
    case 'assigned':
    case 'unassigned':
      return (
        <span className="truncate">
          {event.kind === 'assigned' ? 'assigned' : 'unassigned'} {event.subject ?? 'someone'}
        </span>
      )
    case 'merged':
      return <span>merged this</span>
    case 'closed':
      return <span>closed this</span>
    case 'reopened':
      return <span>reopened this</span>
    case 'head_ref_force_pushed':
      return <span>force-pushed</span>
    case 'renamed':
      return <span className="truncate">renamed this to {event.subject ?? '—'}</span>
    case 'cross-referenced':
      return (
        <span className="truncate">
          referenced this in {event.refNumber ? `#${event.refNumber}` : 'another thread'}
          {event.refTitle ? ` ${event.refTitle}` : ''}
        </span>
      )
  }
}

/** The rolled-up CI glyph on a commit row (#525) — reuses `CHECKS_GLYPH`/`CHECKS_TONE`, the same
 *  source of truth as the list row's indicator and the detail pane's badge.
 *
 *  Renders nothing for BOTH `null` (the commit has no CI configured) and `undefined` (the rollup
 *  query failed or was skipped). The two are deliberately distinct values on the wire even though
 *  they look identical here — absence of a glyph should not have to mean "we know there is no CI". */
function CommitChecks({ checks }: { checks: GithubTimelineEvent['checks'] }) {
  if (!checks) return null
  return (
    <span
      data-slot="gh-commit-checks"
      data-checks={checks}
      aria-label={`checks ${checks}`}
      className={cn('shrink-0', CHECKS_TONE[checks])}
    >
      {CHECKS_GLYPH[checks]}
    </span>
  )
}

/** Review-state chip tones — the same success/danger/muted vocabulary the checks badge uses, so
 *  approved reads green and changes-requested reads red without a new color system. */
const REVIEW_CHIP: Record<NonNullable<GithubComment['reviewState']>, { label: string; tone: string }> = {
  approved: { label: 'approved', tone: 'border-success/40 text-success' },
  changes_requested: { label: 'changes requested', tone: 'border-danger/40 text-danger' },
  commented: { label: 'commented', tone: 'border-border text-muted-foreground' },
  dismissed: { label: 'dismissed', tone: 'border-border text-muted-foreground' },
}

/** One thread entry: avatar (letter fallback), author, age, an optional review-state chip, and the
 *  body via the shared `Markdown` component (images/code fences render as in the issue body). */
function ThreadEntry({ comment }: { comment: GithubComment }) {
  const chip = comment.reviewState ? REVIEW_CHIP[comment.reviewState] : null
  return (
    <li data-slot="gh-thread-entry" data-kind={comment.kind} className="min-w-0">
      <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[11px] text-soft-foreground">
        <Avatar url={comment.avatarUrl} login={comment.author} />
        <span className="font-sans font-medium text-foreground">{comment.author}</span>
        <span>{shortAge(comment.createdAt)}</span>
        {chip ? (
          <span
            data-slot="gh-review-chip"
            data-review-state={comment.reviewState}
            className={cn('rounded-full border px-1.5 py-px font-sans text-[12px] font-medium', chip.tone)}
          >
            {chip.label}
          </span>
        ) : null}
        <a
          href={comment.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="open comment on GitHub"
          className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
        >
          <ExternalLinkIcon aria-hidden="true" className="size-2.5" />
        </a>
      </div>
      <div data-slot="gh-thread-body" className="text-sm">
        {comment.body ? <Markdown>{comment.body}</Markdown> : <p className="text-soft-foreground">(no body)</p>}
      </div>
    </li>
  )
}

/** A 16 px comment avatar. Falls back to a letter block when no URL is known or the image fails to
 *  load (private-repo attachments, deleted avatars) — never a broken-image glyph. */
function Avatar({ url, login }: { url?: string; login: string }) {
  const [failed, setFailed] = useState(false)
  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        width={16}
        height={16}
        loading="lazy"
        onError={() => setFailed(true)}
        data-slot="gh-avatar"
        className="size-4 shrink-0 rounded-full"
      />
    )
  }
  return (
    <span
      data-slot="gh-avatar-fallback"
      aria-hidden="true"
      className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[8px] font-semibold text-muted-foreground uppercase"
    >
      {login.slice(0, 1) || '?'}
    </span>
  )
}

/** Glyph + tone shared by the list row's compact indicator and the detail pane's full badge
 *  (#400) — one source of truth so the two surfaces can't drift out of sync. */
type Checks = NonNullable<GithubItem['checks']>
const CHECKS_GLYPH: Record<Checks, string> = { passing: '✓', failing: '✗', pending: '○' }
const CHECKS_TONE: Record<Checks, string> = {
  passing: 'text-success',
  failing: 'text-danger',
  pending: 'text-muted-foreground',
}

/** The comment-count badge (#499): a muted speech-bubble glyph + count, shown on issue/PR rows
 *  and in the detail meta line. Renders nothing for a zero (or absent) count, so quiet items look
 *  exactly as they did before real counts arrived. Shared so the row and detail can't drift. */
export function CommentCount({ count }: { count: number }) {
  if (!count) return null
  return (
    <span
      data-slot="gh-comment-count"
      data-count={count}
      aria-label={`${count} comment${count === 1 ? '' : 's'}`}
      className="inline-flex shrink-0 items-center gap-0.5"
    >
      <MessageSquareIcon aria-hidden="true" className="size-3" />
      {count}
    </span>
  )
}

/** The checks badge — the legacy tab's three phrases, tinted by outcome. Links out
 *  to the PR's checks tab on GitHub (issue #415) when a URL is available. */
function ChecksBadge({ checks, url }: { checks: Checks; url?: string }) {
  const className = cn('text-[11px] font-medium', CHECKS_TONE[checks], url && 'hover:underline')
  const label = `${CHECKS_GLYPH[checks]} checks ${checks}`

  if (!url) {
    return (
      <span data-slot="gh-checks" data-checks={checks} className={className}>
        {label}
      </span>
    )
  }

  return (
    <a
      href={`${url}/checks`}
      target="_blank"
      rel="noopener noreferrer"
      data-slot="gh-checks"
      data-checks={checks}
      className={className}
    >
      {label}
    </a>
  )
}

/** The PR row's compact checks indicator (#400) — same tones as `ChecksBadge`, just the glyph
 *  (the row is too narrow for the full phrase). Issues never have `checks`, so this only ever
 *  shows up on PR rows. */
export function ChecksGlyph({ checks }: { checks: Checks }) {
  return (
    <span
      data-slot="gh-row-checks"
      data-checks={checks}
      title={`checks ${checks}`}
      aria-label={`checks ${checks}`}
      className={cn('shrink-0 font-sans text-[11px] font-semibold', CHECKS_TONE[checks])}
    >
      {CHECKS_GLYPH[checks]}
    </span>
  )
}
