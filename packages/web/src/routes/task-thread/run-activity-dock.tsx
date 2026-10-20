import { useMemo, useState, type ReactNode } from 'react'
import { ChartColumnIcon, LoaderCircleIcon } from 'lucide-react'
import {
  BotIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleIcon,
  CircleXIcon,
  GitBranchIcon,
  LayersIcon,
  ListTodoIcon,
  TriangleAlertIcon,
  WorkflowIcon,
} from '@/components/design-icons'

import type { ApiRun, StepState } from '@open-mercato/cezar-api-client'
import { useHealth, useRuns } from '@/api/queries'
import { DirectionalUsage } from '@/components/directional-usage'
import { ReferenceStatusProvider, useConflictingPullRequests } from '@/components/reference-status'
import { StatusDot } from '@/components/status-dot'
import { Link } from '@/lib/project-router'
import { queuePositions } from '@/lib/task-groups'
import { formatCost, taskIssueUrl, taskPrUrl, workflowLabel } from '@/lib/tasks-table'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { cn } from '@/lib/utils'
import { useIsDesktop } from '@/lib/use-desktop'

import { AgentList } from './agents-dock'
import { PlanList, planCounts } from './plan-dock'
import { collectSubagents, subagentCounts } from './subagent-dock'
import { StepRail, activeStepIndex, railVisual } from './step-rail'
import { WorkerActivitySection, useWorkersVerdict } from './run-relationships'
import { ActivityRow, meterText } from './run-activity-row'
import { useAgentIdentity } from './run-agent-identity'
import { resumeHint, runActionFlags } from './run-actions'
import { runStatusLine } from './run-status'
import { RunWaitDetails, hasWaitDetails } from './run-waits'
import { BranchCopy, LinkedReferences, WorkspaceTools, useResumeInTerminal, useRunReferenceRequests } from './run-workspace'
import { latestPlanEntries, type ThreadState } from './thread-state'

/**
 * **Session activity** (#402, hearsay-tools/cezarion#1333) — the single card above the composer
 * that owns everything about the session apart from its title, actions and tabs. One summary row
 * (`Session activity · ◷ Waiting for CI · $1.26`); underneath, the current status with its waits,
 * then one row per section — workflow, subagents, workers, plan, usage & agent, workspace — each
 * opening its own detail in place.
 *
 * Folded it is exactly one line, on desktop and phone alike: the transcript keeps the screen and
 * the run's state is still a glance away. The card always renders, because the status and the
 * relocated header metadata always need a home; sections with nothing to show omit themselves.
 */

/** Collapse memory per run — the module-level map every dock this replaced kept, for the same
 *  reason: the route survives a task change and an explicit choice must survive a tab hop.
 *  Session-lifetime only; nothing is persisted server-side. */
const openByRun = new Map<string, boolean>()
/** The same memory, one level down: `${runId}:${section}`. */
const openSections = new Map<string, boolean>()

type SectionKey = 'status' | 'workflow' | 'subagents' | 'workers' | 'plan' | 'usage' | 'workspace'

export function RunActivityDock(props: {
  run: ApiRun
  currentThread: ThreadState
  hasPendingHumanAsk?: boolean
  onOpenWorker?: (id: string) => void
}) {
  // Own provider for the Workspace chips and the conflict roll-up. The app root's registry unions
  // its requests with the header's, so it costs no extra request.
  const { referenceProjectId, repoBase, references, requests } = useRunReferenceRequests(props.run)
  return (
    <ReferenceStatusProvider projectId={referenceProjectId} repoBase={repoBase} requests={requests}>
      <SessionActivityCard
        {...props}
        prNumbers={requests.filter((request) => request.kind === 'PR').map((request) => request.number)}
        hasReferences={references.length > 0 || Boolean(taskPrUrl(props.run)) || Boolean(taskIssueUrl(props.run, repoBase))}
      />
    </ReferenceStatusProvider>
  )
}

function SessionActivityCard({
  run,
  currentThread,
  hasPendingHumanAsk = false,
  onOpenWorker,
  prNumbers,
  hasReferences,
}: {
  run: ApiRun
  currentThread: ThreadState
  hasPendingHumanAsk?: boolean
  onOpenWorker?: (id: string) => void
  prNumbers: number[]
  hasReferences: boolean
}) {
  const desktop = useIsDesktop()
  const [open, setOpen] = useState(() => openByRun.get(run.id) ?? desktop)
  // Nested rows start closed on every viewport — the expanded card is a list of section heads,
  // and a reader opens the one they came for. Workers are the exception, open by default so
  // their task links stay directly reachable: they are navigation, not detail.
  const [sections, setSections] = useState<Record<string, boolean>>({})
  const health = useHealth()
  const metrics = usageMetricVisibility(health.data)
  const runs = useRuns()
  const queuePosition = run.status === 'queued' ? queuePositions(runs.data ?? []).get(run.id) : undefined
  const line = runStatusLine(run, { hasPendingHumanAsk, queuePosition })
  const conflicts = useConflictingPullRequests(prNumbers)
  const sessionOpen = run.status === 'running' || run.status === 'waiting'
  const runIsTerminal = !sessionOpen && run.status !== 'queued'
  const workflow = run.steps
  const agents = useMemo(() => collectSubagents(currentThread.turns, runIsTerminal), [currentThread.turns, runIsTerminal])
  const planEntries = latestPlanEntries(currentThread) ?? []
  // `invalid` is the contract's parking spot for unreadable delegation metadata, and
  // carries no usable worker links, so it is not a section to count or frame.
  const hasWorkers = run.delegation !== undefined && run.delegation.role !== 'invalid'
  // Mounted for every run so the hook order never changes; it only fetches for a delegated one.
  const workers = useWorkersVerdict(run)
  // Complete means SUCCEEDED, not merely settled: a failed or cancelled step keeps the green
  // summary away, matching `subagentCounts` (which counts only `completed`) and the danger X
  // the rail shows one click below. `skipped` stays complete — it never ran and never failed.
  const workflowSucceeded =
    workflow.length === 0 || workflow.every((step) => step.status === 'done' || step.status === 'skipped')
  const agentCounts = subagentCounts(agents)
  const planCountsValue = planCounts(planEntries)
  const workflowName = workflowLabel(run)
  const flags = runActionFlags(run)
  const resume = useResumeInTerminal(run)
  const hasWorkspace = Boolean(run.branch || run.worktreePath || hasReferences || resumeHint(run))

  const isOpen = (key: SectionKey) => sections[key] ?? openSections.get(`${run.id}:${key}`) ?? key === 'workers'
  const toggle = (key: SectionKey) => {
    const next = !isOpen(key)
    openSections.set(`${run.id}:${key}`, next)
    setSections((state) => ({ ...state, [key]: next }))
  }

  // Completeness is a claim about the RUN, not only about the rows on screen. A parent parked
  // on its workers carries no workflow, agent or plan rows at all, and a running run's visible
  // items settle between turns — both would otherwise read "All complete" mid-flight.
  // ...and settled is not succeeded, one level up either: only a `done` run earns the green
  // line; a run that failed or was cancelled says which, through the shared status line.
  const allComplete =
    run.status === 'done' &&
    workflowSucceeded &&
    workers === 'complete' &&
    agentCounts.done === agentCounts.total &&
    planCountsValue.done === planCountsValue.total
  // Withholding the green line is only half the job: a run that is OVER must never be
  // described as in progress (#402 feedback). Once the run is `done`, the only thing that can
  // still change is a worker the lookup has not settled — the thread's own rows are final, so
  // a stalled sub-agent, an abandoned plan entry or a failed worker leaves the run finished
  // and `Incomplete`, a terminal word. A lookup that FAILED says what it cannot see instead.
  const statusText = allComplete
    ? 'All complete'
    : run.status !== 'done'
      ? line.label
      : workers === 'unknown'
        ? 'Workers unavailable'
        : workers === 'pending'
          ? 'In progress'
          : 'Incomplete'
  const failed = line.attention.tone === 'danger' || run.status === 'cancelled'
  const cost = metrics.cost && run.costUsd !== undefined ? formatCost(run.costUsd) : undefined
  const glyph = allComplete
    ? <CircleCheckIcon aria-hidden className="size-3.5 shrink-0 text-success" />
    : <StatusDot tone={line.attention.tone} shape={line.attention.shape} pulse={line.attention.pulse} />
  const conflictText = conflicts.length === 1 ? `PR #${conflicts[0]} conflicts` : `${conflicts.length} PRs conflict`

  return (
    <section
      data-slot="run-activity-dock"
      data-state={open ? 'open' : 'collapsed'}
      className="min-w-0 overflow-hidden rounded-xl border border-border bg-card shadow-xs"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Session activity: ${statusText}${conflicts.length ? '; pull request conflicts' : ''}${cost ? `; cost ${cost}` : ''}`}
        onClick={() => {
          openByRun.set(run.id, !open)
          setOpen(!open)
        }}
        className="flex min-h-11 w-full min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 px-3.5 py-2 text-left text-[14px] hover:bg-muted/40"
      >
        <LayersIcon aria-hidden className="size-4 shrink-0 text-accent-text" />
        <span className="shrink-0 font-semibold">Session activity</span>
        {/* Folded only: once open, the first row carries the status (and its next check). The
            status and a conflict travel together; `flex-auto` sizes the group to its whole text, so
            on a phone row without room for it the group wraps under the label instead of being
            squeezed to an ellipsis or clipped. */}
        {open ? null : (
          <span className="flex min-w-0 flex-auto items-center gap-2.5">
            <span
              data-slot="run-activity-status"
              className={cn(
                'flex min-w-0 shrink items-center gap-1.5 text-[13px]',
                allComplete ? 'text-success' : failed ? 'text-danger' : 'text-muted-foreground',
              )}
            >
              {glyph}
              <span className="truncate">{statusText}</span>
            </span>
            {conflicts.length > 0 ? (
              <span data-slot="run-activity-conflict" className="flex shrink-0 items-center gap-1 text-[13px] font-medium text-conflict">
                <TriangleAlertIcon aria-hidden className="size-3.5" />
                Conflicts
              </span>
            ) : null}
          </span>
        )}
        {cost ? <span data-slot="run-activity-cost" className="ml-auto shrink-0 text-[13px] text-muted-foreground tabular-nums">{cost}</span> : null}
        <ChevronDownIcon
          aria-hidden
          className={cn('size-4 shrink-0 text-soft-foreground transition-transform motion-reduce:transition-none', !cost && 'ml-auto', open && 'rotate-180')}
        />
      </button>
      {open ? (
        <div className="flex min-w-0 flex-col border-t border-border">
          <ActivityRow
            slot="status-row"
            icon={glyph}
            // The same slot the folded summary used: the status text moves here, it is not a second copy.
            // The next check is its own line, never a truncating meter: at 320px a one-line row
            // cut the appointment off, and the phone has no other place that shows it.
            title={
              <span className="flex min-w-0 flex-col">
                <span data-slot="run-activity-status" className={cn('truncate', allComplete ? 'text-success' : failed && 'text-danger')}>{statusText}</span>
                {line.nextCheck ? (
                  <span data-slot="run-activity-next-check" className="whitespace-normal text-[13px] font-normal text-muted-foreground">
                    Next check <time dateTime={line.nextCheck.at}>{line.nextCheck.text}</time>
                  </span>
                ) : null}
              </span>
            }
            open={isOpen('status')}
            onToggle={hasWaitDetails(run) ? () => toggle('status') : undefined}
          >
            <RunWaitDetails run={run} />
          </ActivityRow>
          {workflowName || workflow.length > 0 ? (
            <ActivityRow
              slot="workflow"
              icon={workflow.length > 0 ? <WorkflowGlyph steps={workflow} /> : <WorkflowIcon className="size-4" />}
              title={<>Workflow{workflowName ? <span className="font-normal text-muted-foreground"> · {workflowName}</span> : null}</>}
              meta={workflow.length > 0
                ? `${workflow[activeStepIndex(workflow)]!.name} · ${meterText(activeStepIndex(workflow) + 1, workflow.length, desktop, 'step')}`
                : undefined}
              open={isOpen('workflow')}
              onToggle={() => toggle('workflow')}
            >
              {workflow.length > 0 ? <StepRail steps={workflow} /> : null}
              <AutomationOrigin run={run} available={health.data?.capabilities?.automations === true} />
            </ActivityRow>
          ) : null}
          {agents.length > 0 ? (
            <ActivityRow
              slot="subagents"
              icon={<BotIcon className="size-4" />}
              title="Subagents"
              meta={meterText(agentCounts.done, agentCounts.total, desktop)}
              open={isOpen('subagents')}
              onToggle={() => toggle('subagents')}
            >
              <AgentList agents={agents} onSelect={onOpenWorker} />
            </ActivityRow>
          ) : null}
          {hasWorkers ? (
            <WorkerActivitySection run={run} open={isOpen('workers')} onToggle={() => toggle('workers')} />
          ) : null}
          {planEntries.length > 0 ? (
            <ActivityRow
              slot="plan"
              icon={<ListTodoIcon className="size-4" />}
              title="Plan"
              meta={meterText(planCountsValue.done, planCountsValue.total, desktop)}
              open={isOpen('plan')}
              onToggle={() => toggle('plan')}
            >
              <PlanList entries={planEntries} />
            </ActivityRow>
          ) : null}
          <ActivityRow
            slot="usage"
            icon={<ChartColumnIcon className="size-4" />}
            title="Usage & agent"
            meta={<UsageMeta run={run} showTokens={metrics.tokens} cost={cost} />}
            open={isOpen('usage')}
            onToggle={() => toggle('usage')}
          >
            <AgentDetails run={run} />
          </ActivityRow>
          {hasWorkspace ? (
            <ActivityRow
              slot="workspace"
              icon={<GitBranchIcon className="size-4" />}
              title="Workspace"
              meta={conflicts.length > 0
                ? <span className="inline-flex items-center gap-1 font-medium text-conflict"><TriangleAlertIcon aria-hidden className="size-3.5" />{conflictText}</span>
                : run.branch ? <span className="font-mono text-[12px]">{run.branch}</span> : undefined}
              open={isOpen('workspace')}
              onToggle={() => toggle('workspace')}
            >
              <div className="flex min-w-0 flex-col gap-3 text-[13px] text-muted-foreground">
                <LinkedReferences run={run} />
                {run.branch ? <DetailLine label="Branch"><BranchCopy branch={run.branch} /></DetailLine> : null}
                {run.worktreePath ? (
                  <DetailLine label="Worktree"><span className="min-w-0 break-all font-mono text-[12px] text-foreground">{run.worktreePath}</span></DetailLine>
                ) : null}
                <WorkspaceTools run={run} canResume={flags.terminal} onResume={() => resume.mutate()} />
              </div>
            </ActivityRow>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function DetailLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="w-20 shrink-0 font-medium text-foreground">{label}</span>
      {children}
    </div>
  )
}

function UsageMeta({ run, showTokens, cost }: { run: ApiRun; showTokens: boolean; cost?: string }) {
  const tokens = showTokens && (run.inputTokens !== undefined || run.outputTokens !== undefined)
  if (!tokens && !cost) return null
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {tokens ? <DirectionalUsage inputTokens={run.inputTokens} outputTokens={run.outputTokens} /> : null}
      {tokens && cost ? <span aria-hidden className="text-soft-foreground">·</span> : null}
      {cost ? <span>{cost}</span> : null}
    </span>
  )
}

/** Runner, account, model, effort and identity (#416, #546), as labelled lines rather than the
 *  header badge's hover menu. Same `data-slot`s as that menu, so readers keep their anchors. */
function AgentDetails({ run }: { run: ApiRun }) {
  const { runner, account, model, effort, identity } = useAgentIdentity(run)
  return (
    <dl data-slot="agent-details" className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
      <dt className="font-medium text-foreground">Runner</dt><dd className="min-w-0 break-all font-mono text-[12px]">{runner}</dd>
      {account ? <><dt className="font-medium text-foreground">Account</dt><dd data-slot="agent-badge-account" className="min-w-0 break-all font-mono text-[12px]">{account}</dd></> : null}
      <dt className="font-medium text-foreground">Model</dt><dd className="min-w-0 break-all font-mono text-[12px]">{model}</dd>
      <dt className="font-medium text-foreground">Effort</dt><dd data-slot="agent-badge-effort" className="min-w-0 break-all font-mono text-[12px]">{effort}</dd>
      {identity ? <><dt className="font-medium text-foreground">Identity</dt><dd data-slot="agent-badge-identity" className="min-w-0 break-all font-mono text-[12px]">{identity}</dd></> : null}
    </dl>
  )
}

/** Automation provenance (#801): history, so always shown; only the LINK is gated, because with
 *  the capability off it would land on the disabled `/automations` state. */
function AutomationOrigin({ run, available }: { run: ApiRun; available: boolean }) {
  if (!run.automation) return null
  const className = 'inline-flex min-h-11 items-center rounded-sm text-[13px] font-medium md:min-h-8'
  return (
    <p className="mt-2 text-[13px] text-muted-foreground">
      Launched by{' '}
      {available ? (
        <Link to={`/automations/${encodeURIComponent(run.automation.automationId)}/log`} className={cn(className, 'text-foreground underline underline-offset-2')}>
          Automation
        </Link>
      ) : (
        <span data-slot="automation-origin" title="Automations are off on this server (CEZ_AUTOMATIONS)" className={className}>
          Automation
        </span>
      )}
    </p>
  )
}

/** The workflow row's glyph: the rail's own state language, so the row and the list it opens
 *  never disagree — a green check for a finished workflow, the amber spinner while it runs, a
 *  danger X for a failed or cancelled one, a faint circle for one that has not started. All
 *  four, not just the spinner: falling through to the check mark told a reader that a step
 *  which failed, or never ran, had gone fine. */
function WorkflowGlyph({ steps }: { steps: StepState[] }) {
  const visual = railVisual(steps[activeStepIndex(steps)]!.status)
  const base = 'size-4 shrink-0'
  switch (visual) {
    case 'active':
      return (
        <LoaderCircleIcon
          role="status"
          aria-label="Step running"
          data-slot="workflow-glyph"
          data-visual={visual}
          // stroke-pending, not text-*: amber is a dot & spinner color only (guardian rule).
          className={cn(base, 'animate-spin stroke-pending motion-reduce:animate-none')}
        />
      )
    case 'failed':
      return <CircleXIcon aria-hidden data-slot="workflow-glyph" data-visual={visual} className={cn(base, 'text-danger')} />
    case 'pending':
      return (
        <CircleIcon aria-hidden data-slot="workflow-glyph" data-visual={visual} className={cn(base, 'text-soft-foreground')} />
      )
    case 'done':
      return <CircleCheckIcon aria-hidden data-slot="workflow-glyph" data-visual={visual} className={cn(base, 'text-success')} />
  }
}
