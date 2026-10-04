import { describe, expect, it } from 'vitest';
import { runIndexEntrySchema, runSummarySchema, toRunSummary, type RunRecord } from './runs.ts';

/**
 * The slim list row (#817). `toRunSummary` is the ONE projection the list route, the workspace
 * runs-index and the cockpit's stream patches share, so what it drops and what it keeps is pinned
 * here rather than in each reader.
 */

const PARENT = '11111111-1111-4111-8111-111111111111';
const REQUEST = '22222222-2222-4222-8222-222222222222';

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    title: 'Fix the thing',
    workflow: 'quick-task',
    task: 'a very long prompt '.repeat(100),
    status: 'running',
    createdAt: '2026-10-04T10:00:00.000Z',
    tokensUsed: 12,
    archived: false,
    steps: [{ id: 's1', name: 'Implement', kind: 'agent', status: 'running', iterations: 1, tokensUsed: 12 }],
    ...over,
  };
}

describe('toRunSummary', () => {
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
    expect(planned([
      { id: 'c', name: 'Lint', kind: 'check', status: 'pending', iterations: 0, tokensUsed: 0 },
      { id: 'a', name: 'Fix bug', kind: 'agent', status: 'pending', iterations: 0, tokensUsed: 0 },
    ])).toBe('Fix bug');
    expect(planned([{ id: 'c', name: 'Lint', kind: 'check', status: 'pending', iterations: 0, tokensUsed: 0 }])).toBe('(planned)');
    expect(toRunSummary(record()).workflowLabel).toBe('quick-task');
  });

  it('names the current step backend and keeps the worktree path', () => {
    const summary = toRunSummary(record({
      currentStepId: 's1',
      worktreePath: '/repo/.ai/cezar/worktrees/run-1',
      steps: [{ id: 's1', name: 'Implement', kind: 'agent', status: 'running', iterations: 1, tokensUsed: 0, backend: 'codex' }],
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
