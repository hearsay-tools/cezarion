import {
  activityToolSchema,
  activityWaitSchema,
  type ActivityProject,
  type ActivityRequest,
  type ActivityRun,
  type ActivitySnapshot,
  type ActivityWait,
  type ActivityWorker,
} from '@open-mercato/cezar-api-client/contract/activity'
import { RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'

export { RUN_STATUS }

/** Fixtures for the activity view's tests: one fixed clock and small builders. */

/** The activity wait kinds and tool statuses, named through the contract's schemas. */
export const ACTIVITY_WAIT_KIND = Object.fromEntries(activityWaitSchema.options.map((option) => [option.shape.kind.value, option.shape.kind.value])) as { [K in ActivityWait['kind']]: K }
export const TOOL_STATUS = activityToolSchema.shape.status.enum

export const NOW = Date.parse('2026-11-05T15:32:00.000Z')
export const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()
export const rate = (...values: number[]) => [...Array.from({ length: 30 - values.length }, () => 0), ...values]

let seq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

export function run(overrides: Partial<ActivityRun> = {}): ActivityRun {
  return {
    runId: overrides.runId ?? `run-${++seq}`,
    title: 'Implementing worker spawn',
    status: RUN_STATUS.running,
    rung: 'running',
    runner: 'claude',
    model: 'opus-5.5',
    currentStepId: 'implement',
    startedAt: iso(-42 * 60_000),
    rate: rate(),
    workers: [],
    ...overrides,
  }
}

export function worker(overrides: Partial<ActivityWorker> = {}): ActivityWorker {
  return {
    runId: overrides.runId ?? `worker-${++seq}`,
    title: 'Review branch against main',
    status: RUN_STATUS.running,
    rung: 'running',
    runner: 'codex',
    model: 'gpt-6.1-sol',
    rate: rate(),
    revision: 1,
    collected: false,
    ...overrides,
  }
}

export function request(overrides: Partial<ActivityRequest> & Pick<ActivityRequest, 'senderRunId' | 'recipientRunId'>): ActivityRequest {
  return {
    requestId: uuid(),
    relationship: 'peer',
    text: 'Does spawn.ts still own the lease file, or did it move to the worker store?',
    createdAt: iso(-250_000),
    deadline: iso(350_000),
    ...overrides,
  }
}

export function project(overrides: Partial<ActivityProject> = {}): ActivityProject {
  return { projectId: 'cezarion', name: 'cezarion', loaded: true, inReview: 0, tasks: [], requests: [], closed: [], ...overrides }
}

export function snapshot(...projects: ActivityProject[]): ActivitySnapshot {
  return { generatedAt: iso(0), projects }
}
