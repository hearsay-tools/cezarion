import { LoaderCircleIcon } from 'lucide-react'
import { CircleCheckIcon, CircleIcon, CircleXIcon } from '@/components/design-icons'

import type { ApiRun, RunStatus, StepState, StepStatus } from '@open-mercato/cezar-api-client'
import { cn } from '@/lib/utils'

/**
 * The WORKFLOW step rail (spec §"Task thread" — steps ≠ plan: these are the run's own
 * `RunRecord.steps`, not the agent's todo checklist). Mercato startup-checklist style
 * (mockup `.step-rail`): one row per step — emerald check / amber spinner / faint circle /
 * danger X — over a thin amber progress bar. Check-step OUTPUT renders in the thread as
 * command cards (`thread-state.ts` `check-output`); this rail is only the state summary.
 */

/** The four rail glyphs. Pure so the status → glyph table is testable without rendering. */
export type RailVisual = 'done' | 'active' | 'pending' | 'failed'

export function railVisual(status: StepStatus): RailVisual {
  switch (status) {
    case 'done':
      return 'done'
    case 'running':
    case 'waiting': // the agent paused mid-step — the step is still the live one
    case 'review': // parked at the review gate — same: in flight until accepted
      return 'active'
    case 'failed':
    case 'cancelled':
      return 'failed'
    case 'pending':
    case 'skipped': // never ran — an empty circle is the honest glyph
      return 'pending'
  }
}

/** Mercato's bar formula, `(done + 0.5·running) / total`, generalized over the real status
 *  set: any TERMINAL step counts 1 (the bar measures progress through the workflow, not
 *  success), any ACTIVE one ½, pending 0. */
export function railProgress(steps: ReadonlyArray<Pick<StepState, 'status'>>): number {
  if (steps.length === 0) return 0
  const TERMINAL: ReadonlySet<StepStatus> = new Set(['done', 'failed', 'cancelled', 'skipped'])
  const ACTIVE: ReadonlySet<StepStatus> = new Set(['running', 'waiting', 'review'])
  let score = 0
  for (const step of steps) {
    if (TERMINAL.has(step.status)) score += 1
    else if (ACTIVE.has(step.status)) score += 0.5
  }
  return score / steps.length
}

export function StepRail({ steps }: { steps: StepState[] }) {
  if (steps.length === 0) return null
  const pct = railProgress(steps) * 100
  return (
    <div data-slot="step-rail" className="flex min-w-0 flex-col gap-1">
      {steps.map((step, index) => (
        <div
          key={step.id}
          data-slot="step-row"
          data-visual={railVisual(step.status)}
          className="flex min-h-[22px] min-w-0 items-center gap-2 text-[13px] text-muted-foreground"
        >
          <RailIcon visual={railVisual(step.status)} />
          <span className="min-w-0 truncate font-medium text-foreground">{step.name}</span>
          {step.iterations > 1 ? (
            <span data-slot="step-iterations" className="shrink-0 text-xs text-soft-foreground tabular-nums">
              ×{step.iterations}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 pl-2 text-[11px] text-soft-foreground tabular-nums">
            {step.kind} · step {index + 1} of {steps.length}
          </span>
        </div>
      ))}
      <div data-slot="step-progress" className="mt-1 h-0.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-pending" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function RailIcon({ visual }: { visual: RailVisual }) {
  const base = 'size-[13px] shrink-0'
  switch (visual) {
    case 'done':
      return <CircleCheckIcon aria-hidden className={cn(base, 'text-success')} />
    case 'active':
      return (
        <LoaderCircleIcon
          role="status"
          aria-label="Step running"
          // stroke-pending, not text-*: amber is a dot & spinner color only (guardian rule).
          className={cn(base, 'animate-spin stroke-pending motion-reduce:animate-none')}
        />
      )
    case 'failed':
      return <CircleXIcon aria-hidden className={cn(base, 'text-danger')} />
    case 'pending':
      return <CircleIcon aria-hidden className={cn(base, 'text-soft-foreground')} />
  }
}

/** A run the rail reads: its steps, its status and the step it runs. */
export type RailRun = Pick<ApiRun, 'status' | 'currentStepId' | 'steps'>

/** The step status a finished run's open steps take: its own outcome. */
const OUTCOME: Partial<Record<RunStatus, StepStatus>> = { done: 'done', failed: 'failed', cancelled: 'cancelled' }

/** The steps as the rail draws them. A finished run has no live step: an open step takes the run's
 *  outcome, and a step it never reached never runs. The server leaves open steps on finished runs
 *  (a failed run keeps its waiting step for Continue; older records keep them all), so the cockpit
 *  must not draw them as running (hearsay-tools/squawk#2589, hearsay-tools/squawk#2590). */
export function railSteps(run: RailRun): StepState[] {
  const outcome = OUTCOME[run.status]
  if (!outcome) return run.steps
  return run.steps.map((step) =>
    railVisual(step.status) === 'active' ? { ...step, status: outcome }
      : step.status === 'pending' ? { ...step, status: 'skipped' }
        : step)
}

/** The step the Workflow row speaks for, in `steps` as `railSteps` returns them: the run's current
 *  step; else the last ACTIVE step, as a parked step stays `waiting` while a later one runs; else the
 *  next step still to run, so a run between steps reads honestly; else the last step that ran. */
export function activeStepIndex(currentStepId: string | undefined, steps: ReadonlyArray<Pick<StepState, 'id' | 'status'>>): number {
  const current = steps.findIndex((step) => step.id === currentStepId)
  if (current >= 0) return current
  const active = steps.reduce((last, step, index) => railVisual(step.status) === 'active' ? index : last, -1)
  if (active >= 0) return active
  // `pending` itself, not the pending VISUAL: a skipped step shares the empty circle but never
  // runs, so it is not the next step (hearsay-tools/cezarion#1478 review).
  const pending = steps.findIndex((step) => step.status === 'pending')
  if (pending >= 0) return pending
  // 0 for an empty list keeps every caller's `steps[index]` undefined, never a -1.
  return steps.reduce((last, step, index) => step.status === 'skipped' ? last : index, 0)
}
