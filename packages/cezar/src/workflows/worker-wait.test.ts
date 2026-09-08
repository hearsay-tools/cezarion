import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest';
import { workerWaitRequestSchema, type WorkerWait } from '@open-mercato/cezar-contract';
import { RunStore, type RunRecord } from '../runs/store.ts';
import * as runnerFactory from '../core/runner-factory.ts';
import { collectWorkerEvidence } from '../delegation/results.ts';
import { planOwnedWorkspace } from '../delegation/workspace.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import { currentUsage } from '../core/process-usage.ts';
import type { AgentSession } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { withDelayedCommand } from '../core/owned-input-delivery.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

import {
  bookkeeping, captureState, checkpoint, collect, controlledWire, executions, fixtureUpdateRun,
  manager, parent, queuedWake, register, reopenRuntime, restart, root, semaphore, setFailureState,
  store, terminal, track, until, useWorkerWaitFixture, waitOf, worker,
} from './worker-wait.testkit.ts';

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.
describe('worker waits through RunManager', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  for (const mode of ['fresh', 'continuation'] as const) {
    it(`readiness ${mode}: DONE waits for live workers without accepting human Finish`, async () => {
      const p = await parent();
      await until(() => store.getRun(p.id)?.status === 'waiting');
      if (mode === 'continuation') {
        expect(manager.finish(p.id)).toBe(true); await until(() => !manager.isActive(p.id));
        expect(manager.continueRun(p.id, { text: 'mock:hold' }).ok).toBe(true);
        await until(() => store.getRun(p.id)?.status === 'waiting');
      }
      const w = await worker(p.id);
      expect(manager.sendMessage(p.id, [{ type: 'text', text: 'mock:done' }])).toBe(true);
      await until(() => waitOf(store.getRun(p.id))?.phase === 'parked' || terminal.includes(store.getRun(p.id)?.status ?? ''));
      expect(store.getRun(p.id)?.status).toBe('waiting');
      expect(waitOf(store.getRun(p.id))).toMatchObject({ mode: 'all', workerIds: [w.id] });
      expect(manager.finish(p.id)).toBe(false);
      expect(store.getRun(p.id)?.delegation).not.toHaveProperty('finishRequestedAt');
      expect(store.getRun(w.id)?.status).toBe('queued');
      expect(semaphore.busy()).toBe(0);
    });
  }

  it('readiness closed session defers successful done with outstanding workers', async () => {
    const p = await parent(); const w = await worker(p.id);
    const state = (manager as unknown as { active: Map<string, { session: AgentSession }> }).active.get(p.id)!;
    state.session.end();
    await until(() => !manager.isActive(p.id));
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(waitOf(store.getRun(p.id))).toMatchObject({ mode: 'all', workerIds: [w.id] });
    expect(store.getRun(w.id)?.status).toBe('queued');
  });

  it('readiness public cancellation does not wake until private completion is durable', async () => {
    const p = await parent(); const w = await worker(p.id);
    const generation = store.commitWorkerExecutionStart(w.id);
    const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    store.updateRun(w.id, { status: 'cancelled' }); manager.reconcileWorkerWaits();
    expect(waitOf(store.getRun(p.id))?.phase).toBe('parked');
    expect(store.getRun(p.id)?.agentInputs).toBeUndefined();
    expect(store.commitWorkerExecutionComplete(w.id, generation)).toBe(true);
    await until(() => !waitOf(store.getRun(p.id)));
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id && input.deliveredAt)).toHaveLength(1);
  });

  it('readiness real stopped process wakes its parent only after actual exit and finalization', async () => {
    const p = await parent(); const w = await worker(p.id);
    let child: ReturnType<typeof spawn> | undefined; let ready = false;
    const runner = vi.spyOn(runnerFactory, 'createRunner').mockReturnValue({ backend: 'claude', interrupt: async () => undefined,
      run: async () => { throw Error('unused'); }, startSession: () => {
        child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout!.once('data', () => { ready = true; });
        const result = new Promise<never>((_resolve, reject) => child!.once('close', () => reject(Error('stopped'))));
        return { pid: child.pid, result, open: true, sendMessage: () => false, sendAgentMessage: () => false, discardQueuedMessages: () => {},
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

  it('readiness review preserves workers live and through recovery', async () => {
    const p = await parent(); const w = await worker(p.id);
    store.updateRun(p.id, { status: 'review' }); manager.reconcileWorkerWaits();
    expect(store.getRun(w.id)?.status).toBe('queued');
    await restart();
    expect(store.getRun(w.id)?.status).not.toBe('cancelled');
  });

  it('readiness worker Continue requires continuing a reviewing parent first', async () => {
    const p = await parent(); const w = await worker(p.id);
    store.updateRun(w.id, { status: 'done' });
    store.updateStep(w.id, 'task', { status: 'done', sessionId: randomUUID(), backend: 'claude' });
    const generation = store.commitWorkerExecutionStart(w.id); store.commitWorkerExecutionComplete(w.id, generation);
    store.updateRun(p.id, { status: 'review' });
    expect(manager.continueRun(w.id, { text: 'more' })).toMatchObject({ ok: false, error: expect.stringMatching(/parent.*review|parent.*continu/i) });
  });

  it.each(['review', 'failed', 'cancelled'] as const)('readiness requires settled collection of %s and accepts partial failures', async status => {
    const p = await parent(); const w = await worker(p.id);
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const generation = store.commitWorkerExecutionStart(w.id);
    store.updateRun(w.id, { status });
    await collect(w.id); // Same status/revision, but the process is still unproven.
    expect(manager.finish(p.id)).toBe(false);
    expect(store.commitWorkerExecutionComplete(w.id, generation)).toBe(true);
    expect(manager.finish(p.id)).toBe(false); // A formerly partial observation is not fresh evidence.
    const result = await collect(w.id);
    expect(result.settled).toBe(true);
    expect(manager.finish(p.id)).toBe(true);
    await until(() => !manager.isActive(p.id));
    expect(store.getRun(p.id)?.status).toBe('done');
  });

  it('readiness timeout and repeated DONE retain attention without another automatic wait', async () => {
    const p = await parent(); const w = await worker(p.id);
    await until(() => store.getRun(p.id)?.status === 'waiting');
    manager.sendMessage(p.id, [{ type: 'text', text: 'mock:done' }]);
    await until(() => !!waitOf(store.getRun(p.id)) || terminal.includes(store.getRun(p.id)?.status ?? ''));
    const wait = waitOf(store.getRun(p.id)); expect(wait).toBeDefined();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(wait!.deadline);
    manager.reconcileWorkerWaits(); vi.useRealTimers();
    await until(() => !waitOf(store.getRun(p.id)));
    const engine = manager as unknown as { active: Map<string, { session: AgentSession }> };
    engine.active.get(p.id)!.session.sendMessage([{ type: 'text', text: 'mock:done' }]);
    await until(() => store.getRun(p.id)?.status === 'waiting' || terminal.includes(store.getRun(p.id)?.status ?? ''));
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.source === 'lifecycle')).toHaveLength(1);
    expect(store.getRun(w.id)?.status).toBe('queued');
  });

  it('readiness settled uncollected completion sends one collection response then remains attention', async () => {
    const p = await parent(); const w = await worker(p.id);
    await until(() => store.getRun(p.id)?.status === 'waiting');
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true);
    manager.sendMessage(p.id, [{ type: 'text', text: 'mock:done' }]);
    await until(() => store.getRun(p.id)?.agentInputs?.some(input => !!input.deliveredAt) === true);
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const state = (manager as unknown as { active: Map<string, { session: AgentSession }> }).active.get(p.id)!;
    const boundaries = store.readEvents(p.id).filter(event => event.type === 'turn-end').length;
    state.session.sendMessage([{ type: 'text', text: 'mock:done' }]);
    await until(() => store.readEvents(p.id).filter(event => event.type === 'turn-end').length > boundaries);
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.source === 'lifecycle')).toHaveLength(1);
    expect(store.getRun(p.id)?.agentInputs?.[0]?.text).toMatch(/collect/i);
    await collect(w.id);
    process.env.CEZ_REVIEW_GATE = '1';
    writeFileSync(join(store.getRun(p.id)!.worktreePath!, 'parent-result.txt'), 'parent result');
    state.session.sendMessage([{ type: 'text', text: 'mock:done' }]);
    await until(() => !manager.isActive(p.id));
    expect(store.getRun(p.id)?.status).toBe('review');
  });

  it('readiness accepted worker revision invalidates a previously collected settled result', async () => {
    const p = await parent(); const w = await worker(p.id);
    await until(() => store.getRun(p.id)?.status === 'waiting');
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true); await collect(w.id);
    store.commitWorkerContinuation(w.id, { status: 'queued' });
    expect(manager.finish(p.id)).toBe(false);
    fixtureUpdateRun(w.id, { status: 'done' });
    expect(manager.finish(p.id)).toBe(false);
    await collect(w.id);
    expect(manager.finish(p.id)).toBe(true);
    await until(() => !manager.isActive(p.id));
  });

  it('readiness closed-session wait resumes on a later proof after restart and preserves its cycle', async () => {
    const p = await parent(); const w = await worker(p.id);
    (manager as unknown as { active: Map<string, { session: AgentSession }> }).active.get(p.id)!.session.end();
    await until(() => !manager.isActive(p.id));
    const wait = waitOf(store.getRun(p.id)); expect(wait).toBeDefined();
    await restart();
    expect(waitOf(store.getRun(p.id))?.id).toBe(wait!.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true);
    await until(() => store.getRun(p.id)?.agentInputs?.some(input => input.id === wait!.id && !!input.deliveredAt) === true);
    expect(store.getRun(p.id)?.status).not.toBe('done');
    expect(store.getRun(p.id)?.delegation).toHaveProperty('completion');
  });

  it('readiness ready human Finish retires an accepted wait before closing its session', async () => {
    const p = await parent('mock:slow'); const w = await worker(p.id);
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true); await collect(w.id);
    register(p.id, [w.id]);
    expect(manager.finish(p.id)).toBe(true);
    await until(() => !manager.isActive(p.id));
    expect(store.getRun(p.id)?.status).toBe('done');
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
  });

  it('readiness discards cached unsettled observations lacking current private proof', async () => {
    const p = await parent(); const first = await worker(p.id); const second = await worker(p.id);
    const generation = store.commitWorkerExecutionStart(first.id);
    store.updateRun(first.id, { status: 'cancelled' });
    const metadata = store.getRun(p.id)!.delegation;
    if (metadata?.role !== 'root') throw Error('fixture');
    const wait: WorkerWait = { id: randomUUID(), mode: 'all', workerIds: [first.id, second.id], phase: 'parked',
      deadline: new Date(Date.now() + 600000).toISOString(),
      outcomes: [{ workerId: first.id, revision: 0, status: 'cancelled', observedAt: new Date().toISOString() }] };
    store.commitDelegation([{ id: p.id, delegation: { ...metadata, wait } }]);
    manager.reconcileWorkerWaits();
    expect(waitOf(store.getRun(p.id))?.outcomes).toEqual([]);
    expect(store.commitWorkerExecutionComplete(first.id, generation)).toBe(true);
    expect(waitOf(store.getRun(p.id))?.outcomes).toHaveLength(1);
  });

  for (const mode of ['fresh', 'continuation'] as const) {
    for (const delayedAck of [false, true]) {
      it(`completion timeout ${mode} monitoring stays attention with delayed ACK=${delayedAck}`, async () => {
        const exercise = async (release: () => void) => {
          const backend = delayedAck ? 'opencode' : 'claude';
          const original = HARNESS_ADAPTERS[backend].mockBin;
          const mock = join(root, `timeout-${backend}.mjs`);
          let source = readFileSync(original, 'utf8');
          if (delayedAck) source = source.replace("text: JSON.parse(body).parts.map(part => part.text ?? '').join('\\n'),",
            "text: JSON.parse(body).parts.map(part => part.text ?? '').join('\\n') + '\\nCEZ:MONITORING',");
          else source = source.replace("userText.includes('mock:monitoring')", "(userText.includes('mock:monitoring') || userText.includes('Worker wait'))");
          expect(source).not.toBe(readFileSync(original, 'utf8'));
          writeFileSync(mock, source, { mode: 0o755 });
          process.env.CEZ_DRY_RUN = '0'; process.env[HARNESS_ADAPTERS[backend].binEnv] = mock;
          const p = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold', runner: backend });
          store.commitDelegation([{ id: p.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
          await until(() => store.getRun(p.id)?.status === 'waiting');
          if (mode === 'continuation') {
            expect(manager.finish(p.id)).toBe(true); await until(() => !manager.isActive(p.id));
            expect(manager.continueRun(p.id, { text: 'mock:hold' }).ok).toBe(true);
            await until(() => store.getRun(p.id)?.status === 'waiting');
          }
          const w = await worker(p.id);
          manager.sendMessage(p.id, [{ type: 'text', text: 'mock:done' }]);
          await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
          const wait = waitOf(store.getRun(p.id))!;
          const boundaries = store.readEvents(p.id).filter(event => event.type === 'turn-end').length;
          vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
          vi.setSystemTime(wait.deadline); manager.reconcileWorkerWaits();
          expect.soft(store.getRun(p.id)?.delegation).toMatchObject({ completion: { phase: 'attention' } });
          const persisted = (JSON.parse(readFileSync(join(root, '.ai/cezar/runs.json'), 'utf8')) as RunRecord[]).find(run => run.id === p.id);
          expect.soft(persisted?.delegation).toMatchObject({ completion: { phase: 'attention' }, wait: { id: wait.id, reason: 'timeout' } });
          await until(() => store.readEvents(p.id).filter(event => event.type === 'turn-end').length > boundaries);
          if (delayedAck) {
            expect(store.getRun(p.id)?.agentInputs?.find(input => input.id === wait.id)?.deliveredAt).toBeUndefined();
            const engine = manager as unknown as { active: Map<string, { agentInputFlight?: { settled?: Promise<void> } }> };
            const settled = engine.active.get(p.id)?.agentInputFlight?.settled;
            expect(settled).toBeInstanceOf(Promise);
            release(); await settled;
          }
          await until(() => !waitOf(store.getRun(p.id)));
          expect.soft(store.getRun(p.id)?.status).toBe('waiting');
          expect.soft(store.getRun(p.id)?.activity).toBeUndefined();
          expect.soft(store.getRun(p.id)?.monitoringWakeAt).toBeUndefined();
          expect.soft(semaphore.busy()).toBe(0);
          await vi.advanceTimersByTimeAsync(300_001);
          expect(store.readEvents(p.id).filter(event => event.type === 'note' && String(event.message).includes('automatic monitoring wake-up'))).toEqual([]);
          expect(store.getRun(p.id)?.agentInputs?.filter(input => input.source === 'lifecycle')).toHaveLength(1);
          expect(store.getRun(w.id)?.status).toBe('queued');
          const receipt = store.getRun(p.id)?.delegation;
          expect(receipt).toMatchObject({ completion: { phase: 'attention' }, lastWait: { id: wait.id, reason: 'timeout' } });
          // Attention still admits a deliberate wait; a human can then reset the cycle.
          const deliberate = register(p.id, [w.id]);
          expect(deliberate.id).not.toBe(wait.id);
          expect(manager.sendMessage(p.id, [{ type: 'text', text: delayedAck ? 'mock:agent-echo' : 'mock:monitoring' }])).toBe(true);
          await until(() => store.getRun(p.id)?.activity === 'monitoring');
          expect(store.getRun(p.id)?.delegation).not.toHaveProperty('completion');
          expect(store.getRun(p.id)?.monitoringWakeAt).toBeDefined();
        };
        try {
          if (delayedAck) await withDelayedCommand('opencode', exercise, 'Worker wait');
          else await exercise(() => {});
        } finally { vi.useRealTimers(); }
      });
    }
  }

  it('readiness Finish preserves pending parent human questions', async () => {
    const p = await parent('mock:ask'); await until(() => store.getRun(p.id)?.status === 'waiting');
    expect(manager.finish(p.id)).toBe(false);
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
  });

  it('all-mode replaces old observations when a selected worker accepts another execution', async () => {
    const p = await parent(); const first = await worker(p.id); const second = await worker(p.id);
    manager.registerWorkerWait(p.id, { workerIds: [first.id, second.id], timeoutSeconds: 600, mode: 'all' });
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    fixtureUpdateRun(first.id, { status: 'review' }); manager.reconcileWorkerWaits();
    expect(waitOf(store.getRun(p.id))?.outcomes).toHaveLength(1);
    store.commitWorkerContinuation(first.id, { status: 'queued' });
    fixtureUpdateRun(second.id, { status: 'done' }); manager.reconcileWorkerWaits();
    expect(waitOf(store.getRun(p.id))).toMatchObject({ phase: 'parked', outcomes: [{ workerId: second.id }] });
    expect(waitOf(store.getRun(p.id))?.revisions).toContainEqual({ workerId: first.id, revision: 1 });
    fixtureUpdateRun(first.id, { status: 'review' }); manager.reconcileWorkerWaits();
    await until(() => !waitOf(store.getRun(p.id)));
    expect(store.getRun(p.id)?.delegation).toMatchObject({ lastWait: { outcomes: expect.arrayContaining([{ workerId: first.id, revision: 1, status: 'review', observedAt: expect.any(String) }]) } });
    expect(store.readEvents(p.id)).toContainEqual(expect.objectContaining({ type: 'worker-outcome', outcome: expect.objectContaining({ workerId: first.id, revision: 1 }) }));
  });

  it('all-mode stays parked after one outcome and wakes exactly once after both', async () => {
    const p = await parent(); const first = await worker(p.id); const second = await worker(p.id);
    const wait = manager.registerWorkerWait(p.id, { workerIds: [first.id, second.id], timeoutSeconds: 600, mode: 'all' });
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    fixtureUpdateRun(first.id, { status: 'done' }); manager.reconcileWorkerWaits();
    expect(waitOf(store.getRun(p.id))).toMatchObject({ phase: 'parked', mode: 'all', outcomes: [{ workerId: first.id }] });
    expect(store.getRun(p.id)?.agentInputs).toBeUndefined();
    fixtureUpdateRun(second.id, { status: 'done' }); manager.reconcileWorkerWaits();
    await until(() => !waitOf(store.getRun(p.id)));
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id)).toHaveLength(1);
    expect(store.getRun(p.id)?.delegation).toMatchObject({ lastWait: { id: wait.id, reason: 'outcome' } });
  });

  it('cancels before park durably without releasing an executing parent slot', async () => {
    const release = join(root, 'release-cancelled-turn'); const wire = controlledWire({ firstResultGate: release });
    const p = await parent(); await until(wire.initialReceived); const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    const cancelled = manager.cancelWorkerWait(p.id, wait.id);
    expect(cancelled).toMatchObject({ id: wait.id, phase: 'wake-pending', reason: 'cancelled', wakeId: wait.id });
    expect(semaphore.busy()).toBe(1); expect(store.getRun(w.id)?.status).toBe('queued');
    const disk = JSON.parse(readFileSync(join(root, '.ai/cezar/runs.json'), 'utf8')) as RunRecord[];
    expect(disk.find(run => run.id === p.id)?.delegation).toMatchObject({ lastWait: { id: wait.id, reason: 'cancelled' } });
    expect(store.getRun(p.id)?.agentInputs?.some(input => input.deliveredAt)).not.toBe(true);
    expect(manager.cancelWorkerWait(p.id, wait.id)).toEqual(cancelled);
    writeFileSync(release, 'release');
    await until(() => !waitOf(store.getRun(p.id)));
    expect(manager.cancelWorkerWait(p.id, wait.id).reason).toBe('cancelled');
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id)).toHaveLength(1);
    expect(store.getRun(p.id)?.agentInputs?.[0]?.text).toContain('cancelled');
  });

  it('cancelled parked wait queues one wake behind a running worker and stale IDs cannot cancel a later wait', async () => {
    const p = await parent(); const w = await worker(p.id, 'mock:slow');
    const wait = register(p.id, [w.id]); manager.enqueueOwnedRun(w.id);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked' && store.getRun(w.id)?.status === 'running');
    manager.cancelWorkerWait(p.id, wait.id); manager.cancelWorkerWait(p.id, wait.id); manager.reconcileWorkerWaits();
    expect(store.getRun(w.id)?.status).toBe('running'); expect(semaphore.busy()).toBe(1);
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id)).toHaveLength(1);
    manager.requestWorkerStop(w.id); await manager.awaitRunTermination(w.id, 15_000);
    await until(() => !waitOf(store.getRun(p.id)));
    const nextWorker = await worker(p.id); const next = register(p.id, [nextWorker.id]);
    expect(manager.cancelWorkerWait(p.id, wait.id).reason).toBe('cancelled');
    expect(waitOf(store.getRun(p.id))?.id).toBe(next.id);
    expect(() => manager.cancelWorkerWait(p.id, randomUUID())).toThrow();
    expect(waitOf(store.getRun(p.id))?.reason).toBeUndefined();
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id && input.deliveredAt)).toHaveLength(1);
  });

  it('restarts cancelled settlement and retains its receipt after delivery and another restart', async () => {
    const release = join(root, 'release-recovered-turn'); const wire = controlledWire({ firstResultGate: release });
    const p = await parent(); await until(wire.initialReceived); const w = await worker(p.id);
    const wait = register(p.id, [w.id]); manager.cancelWorkerWait(p.id, wait.id);
    const disk = readFileSync(join(root, '.ai/cezar/runs.json'), 'utf8');
    writeFileSync(release, 'release');
    await restart(false, disk);
    await until(() => !waitOf(store.getRun(p.id)));
    expect(manager.cancelWorkerWait(p.id, wait.id).reason).toBe('cancelled');
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id)).toHaveLength(1);
    expect(store.getRun(w.id)?.status).not.toBe('cancelled');
    await restart();
    expect(manager.cancelWorkerWait(p.id, wait.id).reason).toBe('cancelled');
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id)).toHaveLength(1);
  });

  it('failed cancellation checkpoint publishes no wake and keeps the original wait retryable', async () => {
    const p = await parent('mock:slow'); const w = await worker(p.id); const wait = register(p.id, [w.id]);
    store.flush(); const diskPath = join(root, '.ai/cezar/runs.json'); const disk = readFileSync(diskPath, 'utf8');
    rmSync(diskPath); mkdirSync(diskPath);
    try {
      expect(() => manager.cancelWorkerWait(p.id, wait.id)).toThrow();
      expect(waitOf(store.getRun(p.id))).toEqual(wait);
      expect(store.getRun(p.id)?.agentInputs).toBeUndefined();
      expect(store.getRun(p.id)?.delegation).not.toHaveProperty('lastWait');
      expect(semaphore.busy()).toBe(1);
    } finally { rmSync(diskPath, { recursive: true }); writeFileSync(diskPath, disk); }
    expect(manager.cancelWorkerWait(p.id, wait.id).reason).toBe('cancelled');
  });

  it('parent cancellation retires its wait with a receipt while cancelling workers', async () => {
    const p = await parent(); const w = await worker(p.id); const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    manager.cancel(p.id);
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(store.getRun(p.id)?.delegation).toMatchObject({ lastWait: { id: wait.id, reason: 'cancelled' } });
    await until(() => store.getRun(w.id)?.status === 'cancelled');
    expect(store.getRun(p.id)?.agentInputs).toBeUndefined();
  });

});
