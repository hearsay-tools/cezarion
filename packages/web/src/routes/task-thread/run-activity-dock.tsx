import { ChevronDownIcon } from '@/components/design-icons'
import { useMemo, useState } from 'react'

import type { ApiRun } from '@open-mercato/cezar-api-client'
import { cn } from '@/lib/utils'
import { useIsDesktop } from '@/lib/use-desktop'

import { AgentsDock } from './agents-dock'
import { PlanDock, planCounts } from './plan-dock'
import { collectSubagents, subagentCounts } from './subagent-dock'
import { WorkflowSteps } from './step-rail'
import { RunRelationshipsPanel } from './run-relationships'
import { latestPlanEntries, type ThreadState } from './thread-state'

const openByRun = new Map<string, boolean>()

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
  const sessionOpen = run.status === 'running' || run.status === 'waiting'
  const runIsTerminal = !sessionOpen && run.status !== 'queued'
  const workflow = run.steps.length > 0 ? run.steps : []
  const agents = useMemo(() => collectSubagents(currentThread.turns, runIsTerminal), [currentThread.turns, runIsTerminal])
  const planEntries = latestPlanEntries(currentThread) ?? []
  // `invalid` is the contract's parking spot for unreadable delegation metadata, and
  // RunRelationshipsPanel renders nothing for it — so it is not a section to count or frame.
  const workerSection =
    run.delegation && run.delegation.role !== 'invalid' ? <RunRelationshipsPanel run={run} /> : undefined
  const workflowComplete =
    workflow.length === 0 ||
    workflow.every((step) => step.status === 'done' || step.status === 'failed' || step.status === 'cancelled' || step.status === 'skipped')
  const agentCounts = subagentCounts(agents)
  const planCountsValue = planCounts(planEntries)
  const parts = [
    workflow.length > 0 ? 'workflow' : undefined,
    agents.length > 0 ? 'subagents' : undefined,
    workerSection !== undefined ? 'workers' : undefined,
    planEntries.length > 0 ? 'plan' : undefined,
  ].filter(Boolean) as string[]

  if (parts.length === 0) return null

  // Completeness is a claim about the RUN, not only about the rows on screen. A parent parked
  // on its workers carries no workflow, agent or plan rows at all, and a running run's visible
  // items settle between turns — both would otherwise read "All complete" mid-flight.
  const allComplete =
    runIsTerminal && workflowComplete && agentCounts.done === agentCounts.total && planCountsValue.done === planCountsValue.total

  const summary = `${allComplete ? 'All complete' : run.status === 'running' ? 'Working' : 'In progress'}`

  return (
    <section data-slot="run-activity-dock" data-state={open ? 'open' : 'collapsed'} className="min-w-0 overflow-hidden rounded-lg border border-border bg-card shadow-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          openByRun.set(run.id, !open)
          setOpen(!open)
        }}
        className={cn('flex min-h-11 w-full items-center gap-2 px-3.5 py-2 text-left text-[13px]')}
      >
        <span className="shrink-0 font-semibold">Run activity</span>
        <span data-slot="run-activity-count" className="shrink-0 text-muted-foreground tabular-nums">
          · {parts.length} sections
        </span>
        <span data-slot="run-activity-status" className="min-w-0 truncate text-muted-foreground">
          — {summary}
        </span>
        <ChevronDownIcon aria-hidden className={cn('ml-auto size-3.5 shrink-0 text-soft-foreground transition-transform', !open && 'rotate-180')} />
      </button>
      {open ? (
        <div className="flex flex-col gap-2 px-3.5 pb-3">
          {workflow.length > 0 ? (
            <div data-slot="run-activity-workflow" className="rounded-md border border-border bg-background p-2">
              <WorkflowSteps runId={run.id} steps={workflow} />
            </div>
          ) : null}
          {agents.length > 0 ? (
            <div data-slot="run-activity-subagents" className="rounded-md border border-border bg-background p-2">
              <AgentsDock runId={run.id} agents={agents} onSelect={onOpenWorker} />
            </div>
          ) : null}
          {workerSection !== undefined ? (
            <div data-slot="run-activity-workers" className="rounded-md border border-border bg-background p-2">
              {workerSection}
            </div>
          ) : null}
          {planEntries.length > 0 ? (
            <div data-slot="run-activity-plan" className="rounded-md border border-border bg-background p-2">
              <PlanDock runId={run.id} entries={planEntries} />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
