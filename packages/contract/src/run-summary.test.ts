import { describe, expect, it } from 'vitest';
import { isAutomationTask, runIndexEntrySchema, runSummarySchema, toRunSummary, type RunRecord } from './runs.ts';
import {
  RUN_STATUS,
  STEP_KIND,
  STEP_STATUS,
  WAIT_KIND,
  WAIT_PHASE,
  WAIT_SOURCE,
  makeHumanWait,
  makePrWait,
  makeRunRecord,
  makeStepState,
  makeTimerWait,
} from './test-factories.testkit.ts';

/**
 * The slim list row (#817). `toRunSummary` is the ONE projection the list route, the workspace
 * runs-index and the cockpit's stream patches share, so what it drops and what it keeps is pinned
 * here rather than in each reader.
 */

const PARENT = '11111111-1111-4111-8111-111111111111';
const REQUEST = '22222222-2222-4222-8222-222222222222';

function record(over: Partial<RunRecord> = {}): RunRecord {
  return makeRunRecord({
    id: 'run-1',
    title: 'Fix the thing',
    task: 'a very long prompt '.repeat(100),
    status: RUN_STATUS.running,
    createdAt: '2026-10-04T10:00:00.000Z',
    tokensUsed: 12,
    steps: [makeStepState({ id: 's1', name: 'Implement', status: STEP_STATUS.running, tokensUsed: 12 })],
    ...over,
  });
}

describe('toRunSummary', () => {
  it('preserves every PR in the summary and workspace index', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ number: 812 + i, source: 'declared' as const }));
    const summary = toRunSummary(record({ pullRequests: entries } as Partial<RunRecord>));
    expect(summary).toHaveProperty('pullRequests', entries);
    expect(runSummarySchema.parse(summary)).toHaveProperty('pullRequests', entries);
    expect(runIndexEntrySchema.parse({ projectId: 'p1', ...summary })).toHaveProperty('pullRequests', entries);
    expect('pullRequests' in toRunSummary(record())).toBe(false);
    expect(toRunSummary(record({ pullRequests: [] } as Partial<RunRecord>))).toHaveProperty('pullRequests', []);
  });

  it('carries automation origin from either origin field, and only from those (#1332)', () => {
    const github = toRunSummary(record({
      automation: { automationId: 'gh-1', automationRevision: 2, receiptId: 'r1', event: 'issue.opened', githubUrl: 'https://github.com/o/r/issues/1' },
    }));
    expect(github).toHaveProperty('automationId', 'gh-1');
    for (const trigger of ['schedule', 'catch-up', 'manual'] as const) {
      const scheduled = toRunSummary(record({
        automationTrigger: { automationId: 'sched-1', automationRevision: 1, receiptId: 'r2', trigger, occurrenceAt: '2026-10-04T09:00:00.000Z' },
      }));
      expect(scheduled).toHaveProperty('automationId', 'sched-1');
      expect(isAutomationTask(scheduled)).toBe(true);
    }
    expect(runSummarySchema.parse(github)).toHaveProperty('automationId', 'gh-1');
    const manual = toRunSummary(record({ autonomous: true }));
    expect('automationId' in manual).toBe(false);
    expect(isAutomationTask(manual)).toBe(false);
  });

  it('omits detail-only fields', () => {
    const summary = toRunSummary(record({
      systemPrompt: 'be brief',
      queuedMessages: [{ id: 'q1', text: 'more', createdAt: '2026-10-04T10:01:00.000Z' }],
      taskImages: ['/api/v1/runs/run-1/images/a.png'],
      workflowDef: { name: '(planned)', steps: [] } as unknown as RunRecord['workflowDef'],
      agentInputs: [] as RunRecord['agentInputs'],
    }));
    for (const key of ['task', 'steps', 'systemPrompt', 'agentInputs', 'workflowDef', 'queuedMessages', 'taskImages']) {
      expect(Object.keys(summary)).not.toContain(key);
    }
    expect(runSummarySchema.parse(summary)).toEqual(summary);
  });

  it('slims delegation and keeps the worker parent', () => {
    const delegation = {
      role: 'worker',
      parentRunId: PARENT,
      permissions: { anything: true },
      workspace: { path: '/secret/worktree' },
      wait: { phase: 'parked', requestIds: [REQUEST], outcomes: [], deadline: '2026-10-04T10:10:00.000Z' },
    } as unknown as RunRecord['delegation'];
    expect(toRunSummary(record({ delegation })).delegation).toEqual({
      role: 'worker',
      parentRunId: PARENT,
      wait: { phase: 'parked', requestIds: [REQUEST] },
    });
  });

  it('keeps a root wait\'s worker ids and reported ids for the counted label', () => {
    const worker = '33333333-3333-4333-8333-333333333333';
    const delegation = {
      role: 'root', permissions: [], receipts: [],
      wait: { id: REQUEST, workerIds: [PARENT, worker], deadline: '2026-10-04T10:10:00.000Z', phase: 'parked',
        // A worker outcome's own status, inside a delegation that is loose on purpose (cast below).
        // ast-grep-ignore: test-enum-literal
        outcomes: [{ workerId: worker, status: 'done', observedAt: '2026-10-04T10:05:00.000Z', summary: 'secret' }] },
    } as unknown as RunRecord['delegation'];
    expect(toRunSummary(record({ delegation })).delegation).toEqual({
      role: 'root',
      wait: { phase: 'parked', workerIds: [PARENT, worker], outcomes: [{ workerId: worker }] },
    });
  });

  it('keeps an invalid delegation role-only', () => {
    expect(toRunSummary(record({ delegation: { role: 'invalid' } })).delegation).toEqual({ role: 'invalid' });
  });

  it('quarantines a delegation that does not parse instead of throwing', () => {
    const delegation = { role: 'worker' } as unknown as RunRecord['delegation'];
    expect(toRunSummary(record({ delegation })).delegation).toEqual({ role: 'invalid' });
  });

  it('derives workflowLabel from the first agent step of a planned chain', () => {
    const planned = (steps: RunRecord['steps']) => toRunSummary(record({ workflow: '(planned)', steps })).workflowLabel;
    const lint = makeStepState({ id: 'c', name: 'Lint', kind: STEP_KIND.check, status: STEP_STATUS.pending, iterations: 0 });
    const fix = makeStepState({ id: 'a', name: 'Fix bug', kind: STEP_KIND.agent, status: STEP_STATUS.pending, iterations: 0 });
    expect(planned([lint, fix])).toBe('Fix bug');
    expect(planned([lint])).toBe('(planned)');
    expect(toRunSummary(record()).workflowLabel).toBe('quick-task');
  });

  it('names the current step backend and keeps the worktree path', () => {
    const summary = toRunSummary(record({
      currentStepId: 's1',
      worktreePath: '/repo/.ai/cezar/worktrees/run-1',
      steps: [makeStepState({ id: 's1', name: 'Implement', status: STEP_STATUS.running, backend: 'codex' })],
    }));
    expect(summary.currentStepBackend).toBe('codex');
    expect(summary.worktreePath).toBe('/repo/.ai/cezar/worktrees/run-1');
    expect('currentStepBackend' in toRunSummary(record())).toBe(false);
  });

  it('carries live usage when present and omits the key when absent', () => {
    const usage = { cpuPct: 5, rssBytes: 100, procCount: 2 };
    expect(toRunSummary({ ...record(), usage }).usage).toEqual(usage);
    expect('usage' in toRunSummary(record())).toBe(false);
  });

  it('names the top open wait as waitingOn and leaves the wait list on the record', () => {
    const waits = [makePrWait({
      id: '33333333-3333-4333-8333-333333333333',
      registeredAt: '2026-10-04T10:00:00.000Z', deadline: '2026-10-04T10:30:00.000Z',
      prUrl: 'https://github.com/o/r/pull/12', repository: 'o/r', prNumber: 12, generation: 'gen-1',
    })];
    const summary = toRunSummary(record({ status: RUN_STATUS.waiting, waits, lastWaits: waits }));
    expect(summary.waitingOn).toEqual({
      kind: WAIT_KIND.pr, until: 'checks', waitId: '33333333-3333-4333-8333-333333333333', prUrl: 'https://github.com/o/r/pull/12',
      repository: 'o/r', prNumber: 12, deadline: '2026-10-04T10:30:00.000Z',
    });
    expect(Object.keys(summary)).not.toContain('waits');
    expect(Object.keys(summary)).not.toContain('lastWaits');
    expect(runSummarySchema.parse(summary)).toEqual(summary);
    expect('waitingOn' in toRunSummary(record())).toBe(false);
  });

  it('a summary of a run with an open human wait reads waitingOn human', () => {
    const waits = [makeHumanWait({ id: '66666666-6666-4666-8666-666666666666', registeredAt: '2026-10-04T10:00:00.000Z' })];
    const summary = toRunSummary(record({ status: RUN_STATUS.waiting, waits }));
    expect(summary.waitingOn).toEqual({ kind: WAIT_KIND.human });
    expect(runSummarySchema.parse(summary)).toEqual(summary);
  });

  it('flags a resolved wait as an owed wake, and only then', () => {
    const resolved = [makeTimerWait({
      id: '44444444-4444-4444-8444-444444444444', source: WAIT_SOURCE.cezar,
      registeredAt: '2026-10-04T10:00:00.000Z', deadline: '2026-10-04T10:05:00.000Z', phase: WAIT_PHASE.resolved,
      resolvedAt: '2026-10-04T10:05:00.000Z', seconds: 300,
    })];
    const summary = toRunSummary(record({ status: RUN_STATUS.waiting, waits: resolved }));
    expect(summary.waitWakePending).toBe(true);
    expect('waitingOn' in summary).toBe(false);
    expect(runSummarySchema.parse(summary)).toEqual(summary);
    expect('waitWakePending' in toRunSummary(record({ status: RUN_STATUS.waiting, waits: [{ ...resolved[0]!, phase: WAIT_PHASE.delivered }] }))).toBe(false);
    expect('waitWakePending' in toRunSummary(record())).toBe(false);
    expect(() => toRunSummary(record({ waits: [null] as unknown as RunRecord['waits'] }))).not.toThrow();
  });

  it('derives waitingOn without throwing from a streamed record whose waits or delegation are malformed', () => {
    expect(() => toRunSummary(record({ waits: 'nope' as unknown as RunRecord['waits'] }))).not.toThrow();
    expect(() => toRunSummary(record({ waits: [null] as unknown as RunRecord['waits'] }))).not.toThrow();
    const delegation = { role: 'root', wait: { phase: 'parked', workerIds: [PARENT], outcomes: 5 } } as unknown as RunRecord['delegation'];
    const summary = toRunSummary(record({ status: RUN_STATUS.waiting, delegation }));
    expect(summary.delegation).toEqual({ role: 'invalid' });
    expect('waitingOn' in summary).toBe(false);
  });

  it('never writes an undefined-valued key', () => {
    const summary = toRunSummary(record());
    expect(Object.values(summary).every((value) => value !== undefined)).toBe(true);
  });
});

describe('runIndexEntrySchema', () => {
  it('is the summary plus its project', () => {
    const entry = { projectId: 'p1', ...toRunSummary(record()) };
    expect(runIndexEntrySchema.parse(entry)).toEqual(entry);
  });
});
