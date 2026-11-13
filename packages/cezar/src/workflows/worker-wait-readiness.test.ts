import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { type RunRecord } from '../runs/store.ts';
import * as runnerFactory from '../core/runner-factory.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { COMPLETION_WILL_WAIT } from './run.ts';
import { fixtureUpdateRun, manager, parent, register, restart, root, store, until, useWorkerWaitFixture, waitOf, worker } from './worker-wait.testkit.ts';
import { setRunStatus, readPersistedRuns } from '../runs/run-store.testkit.ts';
import { completionNudges, idleClose, observeIdleClose, sessionOf } from './worker-wait-readiness.testkit.ts';

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.

// Real Git, durable checkpoints and native process shutdown retain their original budgets.
describe('worker waits: readiness', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  it('fixture status seeding commits worker execution completion before publication is consumed', async () => {
    const p = await parent();
    const w = await worker(p.id);
    expect(store.readWorkerExecution(w.id)?.phase).toBe('queued');
    fixtureUpdateRun(w.id, { status: RUN_STATUS.done });
    expect(store.getRun(w.id)?.status).toBe(RUN_STATUS.done);
    expect(store.readWorkerExecution(w.id)?.phase).toBe('complete');
  });

it('readiness closed session reopens to refuse a successful done with outstanding workers', async () => {
    const p = await parent(); const w = await worker(p.id);
    sessionOf(p.id).end();
    const refusal = (run: RunRecord | undefined) => run?.agentInputs?.find(input => input.source === 'lifecycle' && input.text.includes(`Workers are still live: ${w.id}.`));
    await until(() => !!refusal(store.getRun(p.id))?.deliveredAt && store.getRun(p.id)?.steps.some(step => step.id === 'continue-1') === true);
    expect(refusal(store.getRun(p.id))?.text).toContain(COMPLETION_WILL_WAIT);
    expect(completionNudges(p.id)).toHaveLength(1);
    expect(store.getRun(p.id)?.status).not.toBe('done');
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(store.getRun(w.id)?.status).toBe('queued');
  });
it('readiness collects a markerless worker after its idle timer closes the session', async () => {
    const p = await parent();
    const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    const clock = observeIdleClose();
    manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    await idleClose(clock, w.id, manager, store, until);

    await until(() => store.getRun(w.id)?.status === 'done');
    await until(() => store.getRun(p.id)?.agentInputs?.some(input => input.id === wait.id && !!input.deliveredAt) === true);
    expect(store.readWorkerExecution(w.id)?.phase).toBe('complete');
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
  });
it('readiness fails rather than collects success for a worker with a rejected ASK marker', async () => {
    const p = await parent();
    const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    const clock = observeIdleClose();
    manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    store.updateRun(w.id, { invalidAsk: true });
    await idleClose(clock, w.id, manager, store, until);

    await until(() => store.getRun(w.id)?.status === 'failed');
    await until(() => store.getRun(p.id)?.agentInputs?.some(input => input.id === wait.id && !!input.deliveredAt) === true);
    expect(store.getRun(w.id)?.error).toBe('invalid structured question');
  });
it('readiness public cancellation does not wake until private completion is durable', async () => {
    const p = await parent(); const w = await worker(p.id);
    const generation = store.commitWorkerExecutionStart(w.id);
    const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    setRunStatus(store, w.id, RUN_STATUS.cancelled); manager.reconcileWorkerWaits();
    expect(waitOf(store.getRun(p.id))?.phase).toBe('parked');
    expect(store.getRun(p.id)?.agentInputs).toBeUndefined();
    expect(store.commitWorkerExecutionComplete(w.id, generation)).toBe(true);
    await until(() => !waitOf(store.getRun(p.id)));
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id && input.deliveredAt)).toHaveLength(1);
  });
it('readiness real stopped process wakes its parent only after actual exit and finalization', async () => {
    const p = await parent(); const w = await worker(p.id);
    let child: ReturnType<typeof spawn> | undefined; let ready = false;
    const runner = vi.spyOn(runnerFactory, 'createRunner').mockReturnValue({ backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent', interrupt: async () => undefined,
      run: async () => { throw Error('unused'); }, startSession: () => {
        child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout!.once('data', () => { ready = true; });
        const result = new Promise<never>((_resolve, reject) => child!.once('close', () => reject(Error('stopped'))));
        return { pid: child.pid, result, open: true, sendMessage: () => false, sendAgentMessage: () => false, discardQueuedMessages: () => {}, holdsHumanInput: () => false,
          interrupt: () => { child!.kill('SIGTERM'); }, end: () => { child!.kill('SIGTERM'); } };
      } });
    try {
      const wait = register(p.id, [w.id]); manager.enqueueOwnedRun(w.id);
      await until(() => ready);
      expect(manager.requestWorkerStop(w.id).state).toBe('stopping');
      expect(store.getRun(w.id)?.status).toBe('cancelled');
      expect(await manager.awaitRunTermination(w.id, 30)).toBe(false);
      expect(waitOf(store.getRun(p.id))?.phase).toBe('parked');
      expect(manager.finish(p.id)).toBe(false);
      child!.kill('SIGKILL');
      await until(() => store.getRun(p.id)?.agentInputs?.some(input => input.id === wait.id && !!input.deliveredAt) === true);
      expect(store.readWorkerExecution(w.id)?.phase).toBe('complete');
      expect(waitOf(store.getRun(p.id))).toBeUndefined();
    } finally { child?.kill('SIGKILL'); runner.mockRestore(); }
  });
it('readiness review cancels a live worker, live and through recovery', async () => {
    const p = await parent(); const w = await worker(p.id);
    await until(() => store.getRun(p.id)?.status === RUN_STATUS.waiting);
    store.flush(); const disk = readPersistedRuns(join(root, '.ai/cezar')) as Array<{ id: string; status: string }>;
    for (const run of disk) if (run.id === p.id) run.status = RUN_STATUS.review;
    setRunStatus(store, p.id, RUN_STATUS.review); manager.reconcileWorkerWaits();
    expect(store.getRun(w.id)?.status).toBe('cancelled');
    // A reviewing parent holds no session, but this one is live: the old manager stops the session
    // from the park it really has (hearsay-tools/cezarion#1804).
    setRunStatus(store, p.id, RUN_STATUS.waiting);
    await restart(false, disk);
    await until(() => store.getRun(w.id)?.status === 'cancelled');
  });
});
