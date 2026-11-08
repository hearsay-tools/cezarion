import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunnerId } from '../../core/agent-runner.ts';
import { RunStore } from '../../runs/store.ts';
import { createActiveRun } from '../active-run.ts';
import { beginUsageInvocation, recordReportedCost } from './usage-accounting.ts';

// Swap the declared cost report of claude and codex, so the test proves usage accounting reads
// the declaration and not the runner id (hearsay-tools/cezarion#2991).
vi.mock('../../core/runner-facts.ts', async (load) => {
  const actual = await load<typeof import('../../core/runner-facts.ts')>();
  return { ...actual, RUNNER_FACTS: {
    ...actual.RUNNER_FACTS,
    claude: { ...actual.RUNNER_FACTS.claude, costReport: 'per-turn' },
    codex: { ...actual.RUNNER_FACTS.codex, costReport: 'cumulative' },
  } };
});

describe('reported cost follows the runner\'s declared cost report', () => {
  let root: string;
  let store: RunStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-cost-report-'));
    store = RunStore.open(join(root, '.ai/cezar'));
  });
  afterEach(() => { store.flush(); rmSync(root, { recursive: true, force: true }); });

  function report(runId: string, stepId: string, state: ReturnType<typeof createActiveRun>, backend: RunnerId, usd: number) {
    store.appendEvent(runId, { type: 'cost', stepId, usd });
    recordReportedCost(store, runId, stepId, state, backend, usd);
  }

  it.each([
    ['codex', 3],
    ['claude', 4],
  ] as const)('turns reports of 1 then 3 from %s into a step cost of %s', (backend, total) => {
    const run = store.createRun({ title: 'cost', task: 'cost', workflow: 'quick-task',
      steps: [{ id: 'work', name: 'Work', kind: STEP_KIND.agent }] });
    store.updateStep(run.id, 'work', { backend, sessionId: 'session-1' });
    const state = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
    beginUsageInvocation(store, run.id, state, 'work');
    report(run.id, 'work', state, backend, 1);
    report(run.id, 'work', state, backend, 3);
    expect(store.getRun(run.id)!.steps[0]!.costUsd).toBe(total);
  });

  it('rebuilds a cumulative session baseline from the earlier steps of the same session after a restart', () => {
    const run = store.createRun({ title: 'cost', task: 'cost', workflow: 'quick-task', steps: [
      { id: 'work', name: 'Work', kind: STEP_KIND.agent },
      { id: 'continue', name: 'Continue', kind: STEP_KIND.agent },
    ] });
    store.updateStep(run.id, 'work', { backend: 'codex', sessionId: 'session-1' });
    store.updateStep(run.id, 'continue', { backend: 'codex', sessionId: 'session-1' });
    const first = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
    beginUsageInvocation(store, run.id, first, 'work');
    report(run.id, 'work', first, 'codex', 2);
    // A new process holds no cost checkpoint: the Continue step's report of 5 adds only 3.
    const second = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
    beginUsageInvocation(store, run.id, second, 'continue');
    report(run.id, 'continue', second, 'codex', 5);
    expect(store.getRun(run.id)!.steps.map(step => step.costUsd)).toEqual([2, 3]);
  });
});
