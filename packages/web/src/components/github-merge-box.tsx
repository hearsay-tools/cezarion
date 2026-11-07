import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LoaderCircleIcon } from 'lucide-react'
import { CheckIcon, CircleIcon, CircleXIcon, RefreshCwIcon, TriangleAlertIcon } from '@/components/design-icons'
import { useState } from 'react'

import { getGithubPrMergeState, mergeGithubPr } from '@/api/client'
import { GITHUB_PAGE_SIZE } from '@/api/github-pages'
import { queryKeys, useReferenceProjectId } from '@/api/queries'
import type {
  GithubMergeMethod,
  GithubPrCheck,
  GithubPrMergeState,
  GithubPrMergeStateResponse,
} from '@open-mercato/cezar-api-client'
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
import { cn, isHttpUrl } from '@/lib/utils'

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

function mergeBoxState(data: GithubPrMergeStateResponse | undefined): GithubPrMergeState | null {
  return data?.available ? data.mergeState : null
}

function mergeSelectedMethod(
  method: GithubMergeMethod | null,
  state: GithubPrMergeState | null,
): GithubMergeMethod | null {
  return method && state?.methods.includes(method)
    ? method
    : state?.defaultMethod ?? state?.methods[0] ?? null
}

function mergeBoxTitle(state: GithubPrMergeState): string {
  if (state.state === 'merged') return 'Merged'
  if (state.state === 'closed') return 'Closed'
  if (state.isDraft) return 'Draft'
  if (state.mergeable === 'conflicting') return 'Conflicts must be resolved'
  if (state.canMerge) return 'Ready to merge'
  if (state.eligibility === 'unknown') return 'Merge blocked · Requirements unknown'
  return 'Merge blocked'
}

function mergeReviewState(decision: GithubPrMergeState['reviewDecision']): MergeRequirementState {
  if (decision === 'approved' || decision === 'not-required') return 'passing'
  if (decision === 'unknown') return 'unknown'
  return 'failing'
}

function mergeConflictState(mergeable: GithubPrMergeState['mergeable']): MergeRequirementState {
  if (mergeable === 'mergeable') return 'passing'
  if (mergeable === 'conflicting') return 'failing'
  return 'unknown'
}

function mergeConflictLabel(mergeable: GithubPrMergeState['mergeable']): string {
  if (mergeable === 'conflicting') return 'present'
  if (mergeable === 'mergeable') return 'none'
  return 'unknown'
}

function mergeCheckRequiredSuffix(required: boolean | null): string {
  if (required === true) return ' · required'
  if (required === null) return ' · requiredness unknown'
  return ''
}

function mergeUnavailableReason(data: GithubPrMergeStateResponse | undefined): string {
  return data?.available === false ? data.reason : 'GitHub could not load merge requirements.'
}

function mergeIsEnabled(
  selectedMethod: GithubMergeMethod | null,
  state: GithubPrMergeState,
  overrideRules: boolean,
): boolean {
  return Boolean(selectedMethod && (state.canMerge || (state.canOverride && overrideRules)))
}

function mergeMethodLabel(method: GithubMergeMethod | null): string {
  return method ? mergeLabels[method] : 'Merge'
}

function mergeBoxConflictingAttr(mergeable: GithubPrMergeState['mergeable']): 'true' | undefined {
  return mergeable === 'conflicting' ? 'true' : undefined
}

function MergeCheckRow({ check }: { check: GithubPrCheck }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="flex min-w-0 items-center gap-2">
        <MergeRequirementIcon state={check.state} />
        <span>{check.name} · {check.state}{mergeCheckRequiredSuffix(check.required)}</span>
      </span>
      {check.url && isHttpUrl(check.url) ? <a href={check.url} target="_blank" rel="noopener noreferrer" className="text-muted-foreground underline">details</a> : null}
    </li>
  )
}

function GithubMergeUnavailable({ reason }: { reason: string }) {
  return (
    <section data-slot="gh-merge-unavailable" className="mt-6 rounded-lg border border-border bg-card p-4 text-sm">
      <p className="font-medium">Merge status unavailable</p>
      <p className="mt-1 text-xs text-soft-foreground">{reason}</p>
    </section>
  )
}

function GithubMergeBoxBody({
  state,
  selectedMethod,
  overrideRules,
  mergeEnabled,
  refreshPending,
  onRefresh,
  onRunAgent,
  onConfirm,
  onMethodChange,
  onOverrideChange,
}: {
  state: GithubPrMergeState
  selectedMethod: GithubMergeMethod | null
  overrideRules: boolean
  mergeEnabled: boolean
  refreshPending: boolean
  onRefresh: () => void
  onRunAgent?: (() => void) | undefined
  onConfirm: () => void
  onMethodChange: (method: GithubMergeMethod) => void
  onOverrideChange: (next: boolean) => void
}) {
  const title = mergeBoxTitle(state)
  const reviewState = mergeReviewState(state.reviewDecision)
  const conflictState = mergeConflictState(state.mergeable)
  return (
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
            disabled={refreshPending}
            onClick={onRefresh}
          >
            <RefreshCwIcon size={16} aria-hidden="true" className={cn('size-3.5', refreshPending && 'animate-spin')} />
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
            <span>Conflicts: {mergeConflictLabel(state.mergeable)}</span>
          </li>
          {state.checks.length === 0 ? <li>No checks configured</li> : state.checks.map((check) => (
            <MergeCheckRow key={check.name} check={check} />
          ))}
          {state.blockers.map((blocker) => <li key={blocker.code} className="text-soft-foreground">{blocker.message}</li>)}
        </ul>
        {state.mergeable === 'conflicting' && onRunAgent ? <Button className="mt-4" onClick={onRunAgent}>Run agent on this PR</Button> : null}
        {state.canOverride ? (
          <label className="mt-4 flex cursor-pointer items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs">
            <input
              type="checkbox"
              checked={overrideRules}
              onChange={(event) => onOverrideChange(event.target.checked)}
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
          <div className="mt-4 flex flex-col flex-wrap gap-2 sm:flex-row">
            <select
              aria-label="Merge method"
              value={selectedMethod ?? ''}
              onChange={(event) => onMethodChange(event.target.value as GithubMergeMethod)}
              className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
            >
              {state.methods.map((candidate) => <option key={candidate} value={candidate}>{mergeLabels[candidate]}</option>)}
            </select>
            <Button disabled={!mergeEnabled} onClick={onConfirm}>
              {mergeMethodLabel(selectedMethod)}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function GithubMergeConfirm({
  number,
  state,
  selectedMethod,
  confirming,
  overrideRules,
  mergePending,
  mergeError,
  onOpenChange,
  onMerge,
}: {
  number: number
  state: GithubPrMergeState
  selectedMethod: GithubMergeMethod | null
  confirming: boolean
  overrideRules: boolean
  mergePending: boolean
  mergeError: Error | null
  onOpenChange: (open: boolean) => void
  onMerge: () => void
}) {
  return (
    <Dialog open={confirming} onOpenChange={onOpenChange}>
      <DialogContent data-slot="gh-merge-confirm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{mergeMethodLabel(selectedMethod)} pull request #{number}?</DialogTitle>
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
        {mergeError ? <p className="text-sm text-danger">{mergeError.message}</p> : null}
        <DialogFooter>
          <Button variant="outline" disabled={mergePending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={mergePending} onClick={onMerge}>
            {mergePending ? 'Merging…' : mergeMethodLabel(selectedMethod)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function GithubMergeBox({ number, onRunAgent }: { number: number; onRunAgent?: (() => void) | undefined }) {
  const queryClient = useQueryClient()
  // Ref-status batches are keyed by the explicit project, not `queryScope()` (queries.ts).
  const referenceProjectId = useReferenceProjectId()
  const mergeState = useQuery({
    queryKey: queryKeys.githubMergeState(number),
    queryFn: ({ signal }) => getGithubPrMergeState(number, {}, { signal }),
    retry: false,
  })
  const state = mergeBoxState(mergeState.data)
  const [method, setMethod] = useState<GithubMergeMethod | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [overrideRules, setOverrideRules] = useState(false)
  // The key is taken when Refresh is PRESSED, like the merge's below: a reader who left for another
  // project before the answer landed must not get this repository's merge state under theirs.
  const refreshMergeState = useMutation({
    mutationFn: (_key: ReturnType<typeof queryKeys.githubMergeState>) => getGithubPrMergeState(number, { refresh: true }),
    onSuccess: (data, key) => queryClient.setQueryData(key, data),
    onError: (error) => toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }),
  })
  const selectedMethod = mergeSelectedMethod(method, state)
  // Every key this merge touches, taken when it STARTS: `queryKeys` reads the live project scope,
  // and a merge that lands after the reader switched projects must refresh the project it merged
  // in, not the one now on screen (review g3 #1).
  const mergeKeys = () => ({
    mergeState: queryKeys.githubMergeState(number),
    list: queryKeys.githubPages(GITHUB_PAGE_SIZE),
    comments: queryKeys.githubComments('pr', number),
    item: queryKeys.githubItem('pr', number),
    refStatus: referenceProjectId === undefined ? undefined : queryKeys.githubRefStatusOf(referenceProjectId),
  })
  const merge = useMutation({
    mutationFn: (_keys: ReturnType<typeof mergeKeys>) => {
      if (!state || !selectedMethod) throw new Error('No merge method is available.')
      return mergeGithubPr(number, {
        method: selectedMethod,
        expectedHeadSha: state.headSha,
        ...(overrideRules && state.canOverride ? { overrideRules: true } : {}),
      })
    },
    onSuccess: (_data, keys) => {
      setConfirming(false)
      toast(`Pull request #${number} merged`)
      void queryClient.invalidateQueries({ queryKey: keys.mergeState })
      // The paged list (hearsay-tools/cezarion#1183) — a merged PR drops out of the open set on
      // the next read of its pages.
      void queryClient.invalidateQueries({ queryKey: keys.list })
      void queryClient.invalidateQueries({ queryKey: keys.comments })
      // The task tab's item (#692), and every chip and tab glyph of this project: the server
      // forgot its cached status on merge, so a reread answers `merged` without a reload.
      void queryClient.invalidateQueries({ queryKey: keys.item })
      if (keys.refStatus) void queryClient.invalidateQueries({ queryKey: keys.refStatus })
    },
    onError: (error, keys) => {
      toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
      void queryClient.invalidateQueries({ queryKey: keys.mergeState })
    },
  })

  if (mergeState.isPending) {
    return <Skeleton data-slot="gh-merge-loading" className="mt-6 h-32 w-full" />
  }
  if (!state) {
    return <GithubMergeUnavailable reason={mergeUnavailableReason(mergeState.data)} />
  }

  return (
    <section data-slot="gh-merge-box" data-eligibility={state.eligibility} data-conflicting={mergeBoxConflictingAttr(state.mergeable)} aria-live="polite" className="mt-6 rounded-lg border border-border bg-card p-4">
      <GithubMergeBoxBody
        state={state}
        selectedMethod={selectedMethod}
        overrideRules={overrideRules}
        mergeEnabled={mergeIsEnabled(selectedMethod, state, overrideRules)}
        refreshPending={refreshMergeState.isPending}
        onRefresh={() => refreshMergeState.mutate(queryKeys.githubMergeState(number))}
        onRunAgent={onRunAgent}
        onConfirm={() => setConfirming(true)}
        onMethodChange={setMethod}
        onOverrideChange={setOverrideRules}
      />
      <GithubMergeConfirm
        number={number}
        state={state}
        selectedMethod={selectedMethod}
        confirming={confirming}
        overrideRules={overrideRules}
        mergePending={merge.isPending}
        mergeError={merge.error}
        onOpenChange={setConfirming}
        onMerge={() => merge.mutate(mergeKeys())}
      />
    </section>
  )
}
