import { useMemo, useState } from 'react'
import { LoaderCircleIcon } from 'lucide-react'
import {
  BotIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleIcon,
  CircleXIcon,
  LayersIcon,
  ListTodoIcon,
} from '@/components/design-icons'

import type { ApiRun, StepState } from '@open-mercato/cezar-api-client'
import { cn } from '@/lib/utils'
import { useIsDesktop } from '@/lib/use-desktop'

import { AgentList } from './agents-dock'
import { PlanList, planCounts } from './plan-dock'
import { collectSubagents, subagentCounts } from './subagent-dock'
import { StepRail, activeStepIndex, railVisual } from './step-rail'
import { WorkerActivitySection, useWorkersVerdict } from './run-relationships'
import { ActivityRow, meterText } from './run-activity-row'
import { latestPlanEntries, type ThreadState } from './thread-state'

/**
 * **Run activity** (#402, mockups `pasted-1..3.png`) — the single card above the composer that
 * replaced four stacked docks (workflow rail, agents, workers, plan). One header row naming
 * how many sections a run has and whether it is finished; underneath, one row per section —
 * glyph, title, meter, chevron — each opening its own list in place.
 *
 * Collapsed it is exactly one line (`Run activity · 4 sections · All complete`), which is the
 * whole point on a phone: the transcript keeps the screen and the run's state is still a
 * glance away. Sections with nothing to show omit themselves; a run with no sections at all
 * renders nothing rather than an empty frame.
 */

/** Collapse memory per run — the module-level map every dock this replaced kept, for the same
 *  reason: the four task routes mount their own dock, so an explicit expand must survive a
 *  Session → Changes → Commits hop. Session-lifetime only; nothing is persisted server-side. */
const openByRun = new Map<string, boolean>()
/** The same memory, one level down: `${runId}:${section}`. */
const openSections = new Map<string, boolean>()

type SectionKey = 'workflow' | 'subagents' | 'workers' | 'plan'

export function RunActivityDock({
  run,
  currentThread,
  onOpenWorker,
}: {
  run: ApiRun
  currentThread: ThreadState
  onOpenWorker?: (id: string) => void
}) {
  const desktop = useIsDesktop()
  const [open, setOpen] = useState(() => openByRun.get(run.id) ?? desktop)
  // Nested rows start closed on every viewport — the mockup's expanded card is a list of
  // section heads, and a reader opens the one they came for. Workers are the exception, open
  // by default in the mockup and load-bearing before it: the header panel this replaced
  // listed the worker links on desktop without a click, and they are navigation, not detail.
  const [sections, setSections] = useState<Record<string, boolean>>({})
  const sessionOpen = run.status === 'running' || run.status === 'waiting'
  const runIsTerminal = !sessionOpen && run.status !== 'queued'
  const workflow = run.steps
  const agents = useMemo(() => collectSubagents(currentThread.turns, runIsTerminal), [currentThread.turns, runIsTerminal])
  const planEntries = latestPlanEntries(currentThread) ?? []
  // `invalid` is the contract's parking spot for unreadable delegation metadata, and
  // RunRelationshipsPanel renders nothing for it — so it is not a section to count or frame.
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
  const present: SectionKey[] = [
    workflow.length > 0 ? 'workflow' : undefined,
    agents.length > 0 ? 'subagents' : undefined,
    hasWorkers ? 'workers' : undefined,
    planEntries.length > 0 ? 'plan' : undefined,
  ].filter((key): key is SectionKey => key !== undefined)

  if (present.length === 0) return null

  const isOpen = (key: SectionKey) => sections[key] ?? openSections.get(`${run.id}:${key}`) ?? key === 'workers'
  const toggle = (key: SectionKey) => {
    const next = !isOpen(key)
    openSections.set(`${run.id}:${key}`, next)
    setSections((state) => ({ ...state, [key]: next }))
  }

  // Completeness is a claim about the RUN, not only about the rows on screen. A parent parked
  // on its workers carries no workflow, agent or plan rows at all, and a running run's visible
  // items settle between turns — both would otherwise read "All complete" mid-flight.
  // ...and settled is not succeeded, one level up either: `runIsTerminal` covers `failed`,
  // `cancelled` and the `review` park, none of which finished well (or at all). Only a `done`
  // run earns the green line; a run that failed or was cancelled says which, rather than
  // claiming completion or hiding behind "In progress".
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
  // and `Incomplete`, a terminal word. Not "with issues": unchecked todos under a finished
  // run are ordinary, and the failing row itself carries the red X one click below.
  const unresolved = workers === 'pending'
  const summary = allComplete
    ? 'All complete'
    : run.status === 'failed'
      ? 'Failed'
      : run.status === 'cancelled'
        ? 'Cancelled'
        : run.status === 'running'
          ? 'Working'
          : run.status === 'done' && !unresolved
            ? 'Incomplete'
            : 'In progress'
  const failed = run.status === 'failed' || run.status === 'cancelled'

  return (
    <section
      data-slot="run-activity-dock"
      data-state={open ? 'open' : 'collapsed'}
      className="min-w-0 overflow-hidden rounded-xl border border-border bg-card shadow-xs"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          openByRun.set(run.id, !open)
          setOpen(!open)
        }}
        className="flex min-h-11 w-full min-w-0 items-center gap-2.5 px-3.5 py-2 text-left text-[13.5px] hover:bg-muted/40"
      >
        <LayersIcon aria-hidden className="size-4 shrink-0 text-accent-text" />
        <span className="shrink-0 font-semibold">Run activity</span>
        <span data-slot="run-activity-count" className="shrink-0 text-[12.5px] text-muted-foreground tabular-nums">
          · {present.length} {present.length === 1 ? 'section' : 'sections'}
        </span>
        <span
          data-slot="run-activity-status"
          className={cn(
            'ml-auto flex min-w-0 shrink items-center gap-1.5 truncate text-[12.5px]',
            allComplete ? 'text-success' : failed ? 'text-danger' : 'text-muted-foreground',
          )}
        >
          {allComplete ? <CircleCheckIcon aria-hidden className="size-3.5 shrink-0" /> : null}
          <span className="truncate">{summary}</span>
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn('size-4 shrink-0 text-soft-foreground transition-transform', open && 'rotate-180')}
        />
      </button>
      {open ? (
        <div className="flex min-w-0 flex-col">
          {workflow.length > 0 ? (
            <ActivityRow
              slot="workflow"
              icon={<WorkflowGlyph steps={workflow} />}
              title={workflow[activeStepIndex(workflow)]!.name}
              meta={meterText(activeStepIndex(workflow) + 1, workflow.length, desktop, 'step')}
              open={isOpen('workflow')}
              onToggle={() => toggle('workflow')}
            >
              <StepRail steps={workflow} />
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
        </div>
      ) : null}
    </section>
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
