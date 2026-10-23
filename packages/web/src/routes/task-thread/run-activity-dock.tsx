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
import { formatCost, referenceKey, taskIssueUrl, taskPrUrl, workflowLabel, type TaskReference } from '@/lib/tasks-table'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { cn } from '@/lib/utils'
import { useIsDesktop } from '@/lib/use-desktop'

import { AgentList } from './agents-dock'
import { PlanList, planCounts } from './plan-dock'
import { collectSubagents, subagentCounts } from './subagent-dock'
import { StepRail, activeStepIndex, railVisual } from './step-rail'
import { Cleanup, WorkerActivitySection, WorkerWaitDetails, hasCleanupDetails, hasWorkerWaitDetails, useWorkersVerdict } from './run-relationships'
import { ActivityRow, meterText } from './run-activity-row'
import { ActivitySummary, type SummaryItem } from './activity-summary'
import { ActivityReferences } from './activity-references'
import { useAgentIdentity } from './run-agent-identity'
import { isSessionOpen, resumeHint, runActionFlags } from './run-actions'
import { runStatusLine } from './run-status'
import { RunWaitDetails, ciWaitReferences, hasWaitDetails } from './run-waits'
import { BranchCopy, LinkedReferences, WorkspaceTools, useResumeInTerminal, useRunReferenceRequests } from './run-workspace'
import { latestPlanEntries, type ThreadState } from './thread-state'

/**
 * **Session activity** (#402, hearsay-tools/cezarion#1333) — the single card above the composer
 * that owns everything about the session apart from its title, actions and tabs. One summary row
 * (`Activity · ◷ Waiting for CI · ⟳ Do the task · $1.26`); underneath, the current status with its waits,
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

/** Test seam (hearsay-tools/cezarion#1358): both maps outlive a test, so a toggle in one case
 *  would set the next case's starting state for the same run id. */
export function resetActivityDisclosureForTests(): void {
  openByRun.clear()
  openSections.clear()
}

type SectionKey = 'status' | 'workflow' | 'subagents' | 'workers' | 'plan' | 'usage' | 'workspace'

export function RunActivityDock(props: {
  run: ApiRun
  currentThread: ThreadState
  onOpenWorker?: (id: string) => void
}) {
  // Own provider for the Workspace chips and the conflict roll-up. The app root's registry unions
  // its requests with the header's, so it costs no extra request.
  const { referenceProjectId, repoBase, references, requests } = useRunReferenceRequests(props.run)
  return (
    <ReferenceStatusProvider projectId={referenceProjectId} repoBase={repoBase} requests={requests}>
      <SessionActivityCard
        {...props}
        references={references}
        prNumbers={requests.filter((request) => request.kind === 'PR').map((request) => request.number)}
        hasReferences={references.length > 0 || Boolean(taskPrUrl(props.run)) || Boolean(taskIssueUrl(props.run, repoBase))}
      />
    </ReferenceStatusProvider>
  )
}

function SessionActivityCard({
  run,
  currentThread,
  onOpenWorker,
  prNumbers,
  hasReferences,
  references,
}: {
  run: ApiRun
  currentThread: ThreadState
  onOpenWorker?: (id: string) => void
  prNumbers: number[]
  hasReferences: boolean
  references: TaskReference[]
}) {
  const desktop = useIsDesktop()
  const identity = useAgentIdentity(run)
  const [open, setOpen] = useState(() => openByRun.get(run.id) ?? desktop)
  // Nested rows start closed on every viewport — the expanded card is a list of section heads,
  // and a reader opens the one they came for. Workers are the exception, open by default so
  // their task links stay directly reachable: they are navigation, not detail.
  const [sections, setSections] = useState<Record<string, boolean>>({})
  const health = useHealth()
  const metrics = usageMetricVisibility(health.data)
  const runs = useRuns()
  const queuePosition = run.status === 'queued' ? queuePositions(runs.data ?? []).get(run.id) : undefined
  const line = runStatusLine(run, { queuePosition })
  const conflicts = useConflictingPullRequests(prNumbers)
  const sessionOpen = isSessionOpen(run)
  const runIsTerminal = !sessionOpen && run.status !== 'queued'
  const workflow = run.steps
  const agents = useMemo(() => collectSubagents(currentThread.turns, runIsTerminal), [currentThread.turns, runIsTerminal])
  const planEntries = latestPlanEntries(currentThread) ?? []
  // Only roots own workers. A worker's parent link is always visible in the task header.
  const hasWorkers = run.delegation?.role === 'root'
  const cleanup = run.delegation?.role === 'worker' ? run.delegation.destroy : undefined
  const workerWait = hasWorkerWaitDetails(run)
  // Mounted for every run so the hook order never changes; it only fetches for a root.
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
  const hasWorkspace = Boolean(run.branch || run.worktreePath || hasReferences || resumeHint(run) || hasCleanupDetails(cleanup))

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
  const tokens = metrics.tokens && (run.inputTokens !== undefined || run.outputTokens !== undefined)
    ? <DirectionalUsage inputTokens={run.inputTokens} outputTokens={run.outputTokens} />
    : undefined
  const glyph = allComplete
    ? <CircleCheckIcon aria-hidden className="size-3.5 shrink-0 text-success" />
    : <StatusDot tone={line.attention.tone} shape={line.attention.shape} pulse={line.attention.pulse} />
  const conflictText = conflicts.length === 1 ? `PR #${conflicts[0]} conflicts` : `${conflicts.length} PRs conflict`
  const waitReferences = ciWaitReferences(run)
  const summaryReferences = [...new Map([...references, ...waitReferences].map(reference => [referenceKey(reference), reference])).values()]
  // The saved canonical identity names the provider. The display helper can omit an identity
  // that repeats the model, and a runner name does not identify who served the model.
  const provider = run.modelIdentity?.includes('/') ? run.modelIdentity.split('/')[0] : undefined
  const agentSummary: SummaryItem[] = [
    ...(provider ? [{ id: 'provider', priority: 2, content: provider }] : []),
    { id: 'model', priority: 4, content: identity.model },
    { id: 'effort', priority: 3, content: identity.effort },
    ...(cost ? [{ id: 'cost', priority: 1, content: cost }] : []),
    ...(tokens ? [{ id: 'tokens', priority: 0, content: tokens }] : []),
  ]
  // The folded header names the step the Workflow row would show, through the same index and glyph,
  // so the two can never disagree (hearsay-tools/cezarion#1478).
  const activeStep = workflow.length > 0 ? workflow[activeStepIndex(workflow)]! : undefined
  const activeStepState = activeStep ? railVisual(activeStep.status) : undefined
  const stepLabel = activeStep ? `; step ${activeStep.name}, ${activeStepState === 'active' ? 'running' : activeStepState}` : ''
  // Status and step sit before the summary, outside its priority list, in priority order. The status
  // keeps its own width; the step grows from nothing up to its whole name; the summary grows only
  // into what the step leaves and drops its own items. When even that is too much, the status
  // shortens too. Each keeps its glyph and two characters, so the chevron never leaves the card.
  const foldedSummary: SummaryItem[] = [
    { id: 'runner', priority: 2, content: identity.runner },
    { id: 'model', priority: 4, content: identity.model },
    { id: 'effort', priority: 3, content: identity.effort },
    ...(cost ? [{ id: 'cost', priority: 1, content: <span data-slot="run-activity-cost">{cost}</span> }] : []),
    ...(summaryReferences.length || conflicts.length ? [{ id: 'chips', priority: 0, content: <>
      <ActivityReferences run={run} references={summaryReferences} />
      {conflicts.length > 0 ? <span data-slot="run-activity-conflict" className="inline-flex items-center gap-1 font-medium text-conflict"><TriangleAlertIcon aria-hidden className="size-3.5" />Conflicts</span> : null}
    </> }] : []),
  ]

  return (
    <section
      data-slot="run-activity-dock"
      data-state={open ? 'open' : 'collapsed'}
      className="min-w-0 overflow-hidden rounded-xl border border-border bg-card shadow-xs"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Session activity: ${statusText}${conflicts.length ? '; pull request conflicts' : ''}${cost ? `; cost ${cost}` : ''}${!open ? `${stepLabel}; runner ${identity.runner}; model ${identity.model}; effort ${identity.effort}${summaryReferences.length ? `; ${summaryReferences.map(reference => `${reference.kind} #${reference.number}`).join('; ')}` : ''}` : ''}`}
        onClick={() => {
          openByRun.set(run.id, !open)
          setOpen(!open)
        }}
        // Folded, the row holds five values; 8px gaps leave a phone's status whole beside the step.
        className={cn('flex min-h-11 w-full min-w-0 items-center px-3.5 py-2 text-start text-[14px] hover:bg-muted/40 active:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring', open ? 'gap-2.5' : 'gap-2')}
      >
        <LayersIcon aria-hidden className="size-4 shrink-0 text-accent-text" />
        {/* "Activity", not "Session activity": the whole page is the session, and the shorter
            label leaves a phone room for the step. The accessible name keeps the full one. */}
        <span className="shrink-0 font-semibold">Activity</span>
        {open ? null : (
          <>
            <span data-slot="run-activity-status" title={statusText} className={cn('inline-flex min-w-[calc(0.875rem+3ch)] flex-[0_1_auto] items-center gap-1.5 text-[13px] whitespace-nowrap text-muted-foreground', allComplete ? 'text-success' : failed && 'text-danger')}>{glyph}<span data-slot="run-activity-status-label" className="min-w-0 truncate">{statusText}</span></span>
            {activeStep ? (
              <span data-slot="run-activity-step" className="flex max-w-max min-w-[calc(1.375rem+2ch)] flex-[1000_1_0] items-center gap-1.5 text-[13px] text-muted-foreground">
                <WorkflowGlyph steps={workflow} decorative />
                <span data-slot="run-activity-step-name" title={activeStep.name} className="min-w-0 truncate">{activeStep.name}</span>
              </span>
            ) : null}
            {/* Grow 1 against the step's 1000: the step takes the free space first, up to its whole
                name, and the summary then takes all that is left. Factors summing below 1 would
                hand out only that fraction of it. While the summary shows nothing, a negative
                margin returns its gap to the status and step. */}
            <span className="-ms-2 flex min-w-0 flex-[1_1_0] has-[[data-hidden=false]]:ms-0"><ActivitySummary items={foldedSummary} /></span>
          </>
        )}
        {open && cost ? <span data-slot="run-activity-cost" className="ms-auto shrink-0 text-[13px] text-muted-foreground tabular-nums">{cost}</span> : null}
        <ChevronDownIcon
          aria-hidden
          className={cn('size-4 shrink-0 text-soft-foreground motion-safe:transition-transform motion-reduce:transition-none', open && !cost && 'ms-auto', open && 'rotate-180')}
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
            summary={!isOpen('status') && waitReferences.length > 0 ? <ActivitySummary items={[
              { id: 'chips', priority: 0, content: <ActivityReferences run={run} references={waitReferences} /> },
            ]} /> : undefined}
            open={isOpen('status')}
            onToggle={hasWaitDetails(run) || workerWait ? () => toggle('status') : undefined}
          >
            <RunWaitDetails run={run} />
            {workerWait ? <WorkerWaitDetails run={run} /> : null}
          </ActivityRow>
          {workflowName || workflow.length > 0 ? (
            <ActivityRow
              slot="workflow"
              icon={workflow.length > 0 ? <WorkflowGlyph steps={workflow} /> : <WorkflowIcon className="size-4" />}
              title={<>Workflow{workflowName ? <span className="font-normal text-muted-foreground"> · {workflowName}</span> : null}</>}
              meta={workflow.length > 0
                ? { drop: workflow[activeStepIndex(workflow)]!.name, keep: meterText(activeStepIndex(workflow) + 1, workflow.length, desktop, 'step') }
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
            summary={<span data-slot="run-activity-meta" className="contents"><ActivitySummary items={agentSummary} /></span>}
            open={isOpen('usage')}
            onToggle={() => toggle('usage')}
          >
            <AgentDetails run={run} tokens={tokens} cost={cost} />
          </ActivityRow>
          {hasWorkspace ? (
            <ActivityRow
              slot="workspace"
              icon={<GitBranchIcon className="size-4" />}
              title="Workspace"
              summary={!isOpen('workspace') && references.length > 0 ? <span data-slot="run-activity-meta" className="contents"><ActivitySummary items={[
                ...(run.branch ? [{ id: 'branch', priority: 0, content: <span className="font-mono text-[12px]">{run.branch}</span> }] : []),
                { id: 'chips', priority: 1, content: <ActivityReferences run={run} references={references} /> },
                ...(conflicts.length > 0 ? [{ id: 'conflicts', priority: 2, content: <span className="font-medium text-conflict">{conflictText}</span> }] : []),
              ]} /></span> : undefined}
              meta={conflicts.length > 0
                ? <span className="inline-flex items-center gap-1 font-medium text-conflict"><TriangleAlertIcon aria-hidden className="size-3.5" />{conflictText}</span>
                : run.branch ? <span className="font-mono text-[12px]">{run.branch}</span> : undefined}
              open={isOpen('workspace')}
              onToggle={() => toggle('workspace')}
            >
              <div className="flex min-w-0 flex-col gap-3 text-[13px] text-muted-foreground">
                {cleanup ? <Cleanup state={cleanup} /> : null}
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

/** Runner, account, model, effort and identity (#416, #546), as labelled lines rather than the
 *  header badge's hover menu. Same `data-slot`s as that menu, so readers keep their anchors. */
function AgentDetails({ run, tokens, cost }: { run: ApiRun; tokens: ReactNode; cost?: string }) {
  const { runner, account, model, effort, identity } = useAgentIdentity(run)
  return (
    <dl data-slot="agent-details" className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
      {tokens ? <><dt className="font-medium text-foreground">Tokens</dt><dd className="min-w-0 text-[12px]">{tokens}</dd></> : null}
      {cost ? <><dt className="font-medium text-foreground">Cost</dt><dd className="min-w-0 font-mono text-[12px] tabular-nums">{cost}</dd></> : null}
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
function WorkflowGlyph({ steps, decorative = false }: { steps: StepState[]; decorative?: boolean }) {
  const visual = railVisual(steps[activeStepIndex(steps)]!.status)
  const base = 'size-4 shrink-0'
  switch (visual) {
    case 'active':
      return (
        <LoaderCircleIcon
          // Decorative inside the folded header: its button already names the step and its state.
          {...(decorative ? { 'aria-hidden': true } : { role: 'status', 'aria-label': 'Step running' })}
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
