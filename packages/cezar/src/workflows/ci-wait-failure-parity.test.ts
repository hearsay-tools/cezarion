import { runInternals } from './run-internals.testkit.ts';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CiWaitResult, Wait } from '@open-mercato/cezar-contract';
import { RUNNER_IDS, type AgentSession, type RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { supportsProfiles } from '../core/agent-profiles.ts';
import { acceptedWorkerIdentitySchema, workerWorkflowHash } from '../delegation/execution-identity.ts';
import { planOwnedWorkspace } from '../delegation/workspace.ts';
import { eventCheckpoint, manager, restart, root, store, until, useWorkerWaitFixture } from './worker-wait.testkit.ts';
import { QUICK_TASK_WORKFLOW, stepKind, type WorkflowDef } from './types.ts';
import { gatedProviderFailure } from './waits-parity.testkit.ts';

// hearsay-tools/cezarion#1233: CI waits live in the run's wait list; a parked one is an open wait
// on a waiting run.
const ciWaitOf = (id: string) => store.getRun(id)?.waits?.find(entry => entry.kind === 'pr');
const lastCiWaitOf = (id: string) => [...(store.getRun(id)?.lastWaits ?? [])].reverse().find(entry => entry.kind === 'pr');
const parked = (id: string) => ciWaitOf(id)?.phase === 'open' && store.getRun(id)?.status === 'waiting';

const externalResource = vi.hoisted(() => ({ supervisor: {} }));
vi.mock('../ci-wait/resources.ts', () => ({ acquireCiResources: () => ({
  supervisor: externalResource.supervisor, controller: async () => undefined, release() {},
}) }));

const identity = { prUrl: 'https://github.com/acme/repo/pull/12', repository: 'acme/repo', prNumber: 12, headSha: 'a'.repeat(40) };
function github() {
  let settle!: (result: CiWaitResult) => void;
  const result = new Promise<CiWaitResult>(resolve => { settle = resolve; });
  const supervisor = { resolve: async () => identity, watch: async () => result, close() {} };
  externalResource.supervisor = supervisor;
  Object.assign(manager, { ciSupervisor: supervisor });
  return () => settle({ outcome: 'passed', headSha: identity.headSha, observedAt: new Date().toISOString(), checks: [], totalChecks: 0, truncated: false });
}

function active(id: string) {
  return (manager as unknown as { active: Map<string, { session: AgentSession; ciGeneration: string }> }).active.get(id);
}
// An earlier step completes only on its done (hearsay-tools/cezarion#1620): a turn that signals
// it replaces the plain session close these cells once used to run the tail.
function signalDone(id: string, runner: RunnerId): void {
  expect(manager.sendMessage(id, [{ type: 'text', text: HARNESS_ADAPTERS[runner].scenarios.done! }])).toBe(true);
}
function register(id: string): Promise<Wait> {
  return manager.registerWait(id, { kind: 'pr', pr: identity.prUrl, timeout_seconds: 30 }, 'cezar_wait', active(id)!.ciGeneration);
}

async function ownedChain(runner: RunnerId, workflow: WorkflowDef) {
  const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
  store.updateRun(parent.id, { status: 'waiting', delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const workspace = await planOwnedWorkspace(root, randomUUID(), sha);
  const account = { provider: runner, profileId: 'default',
    ...(supportsProfiles(runner) ? { homePath: root } : {}),
    ...(runner === 'claude' ? { claudeLayout: { kind: 'relocated' as const } } : {}) };
  const identity = acceptedWorkerIdentitySchema.parse({ kind: 'accepted', account, grants: {},
    workflowHash: workerWorkflowHash(workflow),
    steps: workflow.steps.filter(step => stepKind(step) === 'agent').map(step => ({ stepId: step.id, account, grants: {} })),
  });
  const run = store.createOwnedRun({ title: 'CI worker', task: 'Recover CI and run the remaining workflow',
    runner, agentProfile: 'default', workflow: workflow.name, workflowDef: workflow,
    steps: workflow.steps.map(step => ({ id: step.id, name: step.id, kind: stepKind(step) })),
  }, parent.id, randomUUID(), { role: 'worker', permissions: [], parentRunId: parent.id, workspace }, 'a'.repeat(64), identity);
  manager.enqueueOwnedRun(run.id);
  return run;
}

describe('CI wait failure history through every native runner (hearsay-tools/cezarion#994)', { timeout: 45_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());

  for (const runner of RUNNER_IDS) for (const mode of ['fresh', 'continued'] as const) {
    const cell = mode === 'fresh' ? 'R72' : 'R73';
    it(`${runner} ${cell} preserves a failed CI attempt through automatic recovery and final success`, async () => {
      const settle = github();
      const wire = gatedProviderFailure(root, runner);
      // A failure that owes the CI result retries after the wake backoff (hearsay-tools/cezarion#1233);
      // the cell is about the failure history, so the retry need not wait out production cadence.
      runInternals(manager).retries.wakeRetryBackoff = { fastMs: 0, fastCount: 1, capMs: 0 };
      const adapter = HARNESS_ADAPTERS[runner];
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: adapter.scenarios[mode === 'fresh' ? 'provider-error' : 'baseline']! });
      let wait: Wait;
      if (mode === 'fresh') {
        await until(wire.held);
        wait = await register(run.id);
      } else {
        await until(() => store.getRun(run.id)?.status === 'waiting');
        wait = await register(run.id);
        active(run.id)!.session.end();
        await until(() => !manager.isActive(run.id));
        // Clean CI parking must survive a close, without fabricating failure.
        expect(store.getRun(run.id)).toMatchObject({ status: 'waiting' });
        expect(store.getRun(run.id)?.waits?.find(open => open.id === wait.id)?.phase).toBe('open');
        expect(store.getRun(run.id)?.error).toBeUndefined();
        settle();
        await until(wire.held);
      }
      const failedStepId = store.getRun(run.id)!.currentStepId!;
      const failedState = active(run.id);
      wire.release();
      await until(() => store.readEvents(run.id).some(event => event.type === 'error' && event.stepId === failedStepId));
      await until(() => active(run.id) !== failedState);
      const failedStep = structuredClone(store.getRun(run.id)!.steps.find(step => step.id === failedStepId)!);
      expect.soft(failedStep.status).toBe('failed');
      expect.soft(failedStep.error?.trim()).toBeTruthy();
      expect.soft(failedStep.finishedAt).toBeTruthy();
      const providerError = store.readEvents(run.id).find(event => event.type === 'error' && event.stepId === failedStepId)!;
      expect.soft(failedStep.error).toBe(providerError.message);
      expect.soft(store.readEvents(run.id)).toContainEqual(expect.objectContaining({ type: 'session.ended', stepId: failedStepId, reason: 'error', message: providerError.message }));
      expect.soft(store.readEvents(run.id)).toContainEqual(expect.objectContaining({ type: 'step-end', stepId: failedStepId, status: 'failed' }));
      expect(ciWaitOf(run.id)?.id).toBe(wait.id);
      expect(store.getRun(run.id)?.agentInputs?.find(input => input.id === wait.id)?.deliveredAt).toBeUndefined();
      if (mode === 'fresh') settle();
      await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
      await until(() => store.getRun(run.id)?.status === 'waiting');
      expect(manager.finish(run.id)).toBe(true);
      await until(() => !manager.isActive(run.id));
      expect(store.getRun(run.id)?.status).toBe('done');
      expect(store.getRun(run.id)?.steps.find(step => step.id === failedStepId)).toMatchObject({ status: 'failed', error: failedStep.error, finishedAt: failedStep.finishedAt });
      expect(ciWaitOf(run.id)).toBeUndefined();
      expect(lastCiWaitOf(run.id)?.id).toBe(wait.id);
    });
  }

  for (const runner of RUNNER_IDS) for (const outcome of ['passed', 'failed', 'restarted', 'source-retry'] as const) {
    const cell = outcome === 'source-retry' ? 'R76' : 'R74';
    it(`${runner} ${cell} resumes a failed nonfinal CI agent with ${outcome} checks and preserves failure history`, async () => {
      const settle = github();
      const wire = gatedProviderFailure(root, runner);
      const adapter = HARNESS_ADAPTERS[runner];
      const command = outcome === 'failed'
        ? 'node -e "process.exit(1)"'
        : 'node -e "const fs=require(\'node:fs\');if(!fs.existsSync(\'check-retried\')){fs.writeFileSync(\'check-retried\',\'\');process.exit(1)}"';
      const run = manager.startRun({ name: 'ci-failure-chain', source: 'built-in', steps: [
        { id: 'first', prompt: adapter.scenarios['provider-error']! },
        { id: 'later', prompt: adapter.scenarios.done! },
        { id: 'check', command, onFail: { retry: outcome === 'source-retry' ? 'first' : 'later', max: 1 } },
      ] }, { runner, task: 'Recover CI and run the remaining workflow', worktree: false });
      await until(wire.held);
      const wait = await register(run.id);
      wire.release();
      await until(() => !manager.isActive(run.id));
      const failed = structuredClone(store.getRun(run.id)!.steps.find(step => step.id === 'first')!);
      expect(failed).toMatchObject({ status: 'failed', iterations: 1 });
      expect(failed.error?.trim()).toBeTruthy();
      expect(failed.finishedAt).toBeTruthy();
      expect(store.getRun(run.id)?.steps.slice(1).map(step => step.status)).toEqual(['pending', 'pending']);
      if (outcome === 'restarted') {
        await restart(false, undefined, eventCheckpoint());
      }
      settle();
      const refusal = () => store.readEvents(run.id).find(event => event.type === 'note' && typeof event.message === 'string' && event.message.includes('continuation unavailable'));
      await until(() => !!lastCiWaitOf(run.id)?.deliveredAt || !!refusal());
      expect(refusal()).toBeUndefined();
      await until(() => store.getRun(run.id)?.status === 'waiting');
      // Signal done in the recovered native session; Finish would intentionally skip the tail.
      signalDone(run.id, runner);
      if (outcome === 'source-retry') {
        // The check retries the source step, whose new iteration also completes only on its done.
        await until(() => store.getRun(run.id)?.steps.find(step => step.id === 'first')?.iterations === 2 &&
          store.getRun(run.id)?.status === 'waiting' && !!active(run.id)?.session.open);
        signalDone(run.id, runner);
      }
      await until(() => ['done', 'failed'].includes(store.getRun(run.id)?.status ?? '') && !manager.isActive(run.id));
      expect(store.getRun(run.id)?.status).toBe(outcome === 'failed' ? 'failed' : 'done');
      if (outcome === 'source-retry') {
        // A deliberate check retry starts a real new iteration; the logical step
        // may advance, but the failed attempt stays in the append-only transcript.
        expect(store.getRun(run.id)?.steps.find(step => step.id === 'first')).toMatchObject({ status: 'done', iterations: 2 });
        expect(store.readEvents(run.id)).toContainEqual(expect.objectContaining({ type: 'session.ended', stepId: 'first', reason: 'error', message: failed.error }));
      } else {
        expect(store.getRun(run.id)?.steps.find(step => step.id === 'first')).toMatchObject({
          status: 'failed', iterations: 1, error: failed.error, finishedAt: failed.finishedAt,
        });
      }
      expect(store.readEvents(run.id).filter(event => event.type === 'step-end' && event.stepId === 'first').map(event => event.status)).toEqual(outcome === 'source-retry' ? ['failed', 'done'] : ['failed']);
      expect(store.getRun(run.id)?.steps.find(step => step.id === 'later')).toMatchObject({ status: 'done', iterations: 2 });
      expect(store.getRun(run.id)?.steps.find(step => step.id === 'check')).toMatchObject({
        status: outcome === 'failed' ? 'failed' : 'done', iterations: 2, retriesUsed: 1,
      });
      expect(ciWaitOf(run.id)).toBeUndefined();
      expect(lastCiWaitOf(run.id)).toMatchObject({ id: wait.id, phase: 'delivered' });
      expect(store.getRun(run.id)?.agentInputs?.filter(input => input.id === wait.id && input.deliveredAt)).toHaveLength(1);
    });
  }

  for (const runner of RUNNER_IDS) for (const boundary of ['CI acknowledgement', 'queued tail'] as const) {
    it(`${runner} R75 resumes the owned workflow after restart at ${boundary} without rewriting its failed source`, async () => {
      const settle = github();
      const wire = gatedProviderFailure(root, runner);
      const adapter = HARNESS_ADAPTERS[runner];
      const run = await ownedChain(runner, { name: 'owned-ci-chain', source: 'built-in', steps: [
        { id: 'first', prompt: adapter.scenarios['provider-error']!, runner, agentProfile: 'default' },
        { id: 'later', prompt: adapter.scenarios.done!, runner, agentProfile: 'default' },
        { id: 'check', command: 'node -e "const fs=require(\'node:fs\');if(!fs.existsSync(\'check-retried\')){fs.writeFileSync(\'check-retried\',\'\');process.exit(1)}"', onFail: { retry: 'later', max: 1 } },
      ] });
      await until(wire.held);
      await register(run.id);
      wire.release();
      await until(() => !manager.isActive(run.id));
      const failed = structuredClone(store.getRun(run.id)!.steps.find(step => step.id === 'first')!);
      settle();
      await until(() => !!lastCiWaitOf(run.id)?.deliveredAt && store.getRun(run.id)?.status === 'waiting');
      expect(ciWaitOf(run.id)).toBeUndefined();
      if (boundary === 'queued tail') {
        // Hold only scheduler dispatch, after the real CI input ACK. Native teardown
        // durably queues the workflow remainder before any next execute can start.
        const pump = vi.spyOn(runInternals(manager).line, 'pump').mockResolvedValue();
        signalDone(run.id, runner);
        await until(() => store.getRun(run.id)?.status === 'queued' && !active(run.id) && store.readWorkerExecution(run.id)?.phase === 'complete');
        expect(store.getRun(run.id)?.steps.find(step => step.id === 'later')?.status).toBe('pending');
        expect(pump).toHaveBeenCalled(); pump.mockRestore();
      }
      await restart(false, undefined, eventCheckpoint());
      await until(() => ['done', 'failed'].includes(store.getRun(run.id)?.status ?? '') || store.getRun(run.id)?.status === 'waiting' && !!active(run.id)?.session.open);
      if (manager.isActive(run.id) && store.getRun(run.id)?.status === 'waiting') signalDone(run.id, runner);
      await until(() => store.getRun(run.id)?.status === 'done' && !manager.isActive(run.id));
      expect(store.getRun(run.id)?.steps.find(step => step.id === 'first')).toMatchObject({
        status: 'failed', iterations: 1, error: failed.error, finishedAt: failed.finishedAt,
      });
      expect(store.getRun(run.id)?.steps.find(step => step.id === 'later')).toMatchObject({ status: 'done', iterations: 2 });
      expect(store.getRun(run.id)?.steps.find(step => step.id === 'check')).toMatchObject({ status: 'done', iterations: 2, retriesUsed: 1 });
      expect(store.readEvents(run.id).filter(event => event.type === 'step-end' && event.stepId === 'first').map(event => event.status)).toEqual(['failed']);
    });
  }
});
