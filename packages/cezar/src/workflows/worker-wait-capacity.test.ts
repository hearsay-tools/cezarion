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
  it.each(['agent', 'check'].flatMap(next => ['early', 'late'].map(timing => ({ next, timing }))))('holds a nonfinal agent session and the following $next behind $timing admitted worker wake at cap one', async ({ next, timing }) => {
    const run = manager.startRun({ name: 'multi-step wait', source: 'built-in', steps: [
      { id: 'first', prompt: 'mock:hold' },
      next === 'agent' ? { id: 'next', prompt: 'mock:hold' } : { id: 'next', command: 'echo checked' },
    ] }, { task: 'parent', runner: 'claude' });
    store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
    const engine = manager as unknown as { workerWaiting: Set<string>; active: Map<string, { sessionEverOpened?: boolean; session?: { open: boolean } }> };
    await until(() => !!engine.active.get(run.id)?.sessionEverOpened);
    const first = engine.active.get(run.id)!.session;
    const w = await worker(run.id, 'mock:slow');
    if (timing === 'late') await until(() => store.readEvents(run.id).some(event => event.type === 'turn-end'));
    register(run.id, [w.id]); manager.enqueueOwnedRun(w.id);
    await until(() => engine.workerWaiting.has(run.id) && !!engine.active.get(w.id)?.sessionEverOpened);
    await new Promise(resolve => setTimeout(resolve, 400)); // Observe past the real 250ms runner auto-end timer.
    expect.soft(engine.active.get(run.id)?.session).toBe(first);
    expect.soft(first?.open).toBe(true);
    expect.soft(store.getRun(run.id)?.steps.find(step => step.id === 'next')?.status).toBe('pending');
    expect.soft(semaphore.busy()).toBe(1);
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true);
    await until(() => !!store.getRun(run.id)?.agentInputs?.some(input => input.source === 'lifecycle' && input.deliveredAt));
    expect(engine.workerWaiting.has(run.id)).toBe(false); expect(semaphore.busy()).toBe(1);
    await until(() => store.getRun(run.id)?.steps.find(step => step.id === 'next')?.status !== 'pending');
    expect(store.getRun(run.id)?.steps.find(step => step.id === 'first')?.status).toBe('done');
    expect(engine.workerWaiting.has(run.id)).toBe(false);
  });

  it.each(['codex', 'opencode', 'pi'].flatMap(backend => ['agent', 'check'].map(next => ({ backend: backend as 'codex' | 'opencode' | 'pi', next }))))(
    '$backend keeps a completed wake and following $next held until its real transport ACK at cap one', async ({ backend, next }) => {
      await withDelayedCommand(backend, async release => {
        process.env.CEZ_DRY_RUN = '0';
        process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
        process.env[HARNESS_ADAPTERS[backend].binEnv] = HARNESS_ADAPTERS[backend].mockBin;
        const run = manager.startRun({ name: 'ACK held chain', source: 'built-in', steps: [
          { id: 'first', prompt: 'mock:hold' },
          next === 'agent' ? { id: 'next', prompt: 'mock:done' } : { id: 'next', command: 'echo checked' },
        ] }, { task: 'parent', runner: backend });
        store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
        const engine = manager as unknown as { workerWaiting: Set<string>; workerWakeAdmitted: Set<string>;
          active: Map<string, { sessionEverOpened?: boolean; session?: AgentSession }> };
        await until(() => !!engine.active.get(run.id)?.sessionEverOpened);
        const session = engine.active.get(run.id)!.session!;
        const w = await worker(run.id, 'mock:slow');
        register(run.id, [w.id]); manager.enqueueOwnedRun(w.id);
        try {
          await until(() => engine.workerWaiting.has(run.id) && !!engine.active.get(w.id)?.sessionEverOpened);
          expect(semaphore.busy()).toBe(1);
          manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true);
          await until(() => store.readEvents(run.id).some(event => event.type === 'text' && String(event.text).includes('Worker wait')));
          await new Promise(resolve => setTimeout(resolve, 400));
          const wake = store.getRun(run.id)?.agentInputs?.find(input => input.source === 'lifecycle');
          expect(wake).toBeDefined(); expect(wake?.deliveredAt).toBeUndefined();
          expect(waitOf(store.getRun(run.id))?.wakeId).toBe(wake?.id);
          expect(engine.workerWaiting.has(run.id)).toBe(false);
          expect(engine.workerWakeAdmitted.has(run.id)).toBe(true);
          expect(engine.active.get(run.id)?.session).toBe(session); expect(session.open).toBe(true);
          expect(store.getRun(run.id)?.steps.find(step => step.id === 'next')?.status).toBe('pending');
          expect(semaphore.busy()).toBe(1);
          await collect(w.id);
          release();
          await until(() => !!store.getRun(run.id)?.agentInputs?.find(input => input.id === wake?.id)?.deliveredAt);
          expect(waitOf(store.getRun(run.id))).toBeUndefined();
          expect(semaphore.busy()).toBe(1); // Nonfinal auto-end/next step still owns capacity.
          await until(() => store.getRun(run.id)?.steps.find(step => step.id === 'next')?.status !== 'pending');
          expect(store.getRun(run.id)?.steps.find(step => step.id === 'first')?.status).toBe('done');
          await until(() => !manager.isActive(run.id));
          expect(store.getRun(run.id)?.steps.map(step => step.status)).toEqual(['done', 'done']);
        } finally {
          setFailureState(captureState());
          release();
          for (const record of store.listRuns()) manager.cancel(record.id);
          await until(() => store.listRuns().every(record => !manager.isActive(record.id)));
        }
      }, 'Worker wait');
    },
  );

  it('interactive markerless wake persists run and step waiting immediately after its held HTTP ACK', async () => {
    await withDelayedCommand('opencode', async release => {
      process.env.CEZ_DRY_RUN = '0';
      process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
      process.env.CEZ_OPENCODE_BIN = HARNESS_ADAPTERS.opencode.mockBin;
      const p = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold', runner: 'opencode' });
      store.commitDelegation([{ id: p.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
      await until(() => store.getRun(p.id)?.status === 'waiting');
      const w = await worker(p.id, 'mock:slow');
      register(p.id, [w.id]); manager.enqueueOwnedRun(w.id);
      const engine = manager as unknown as { active: Map<string, {
        sessionEverOpened?: boolean; agentInputFlight?: { settled?: Promise<void> }
      }> };
      try {
        await until(() => !!engine.active.get(w.id)?.sessionEverOpened);
        manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true);
        await until(() => store.readEvents(p.id).some(event => event.type === 'text' && String(event.text).includes('Worker wait')));
        await Promise.all(bookkeeping);
        store.flush(); // Earlier turn bookkeeping/debounce cannot satisfy the measured ACK checkpoint.
        const settled = engine.active.get(p.id)?.agentInputFlight?.settled;
        expect(settled).toBeInstanceOf(Promise);
        const wake = store.getRun(p.id)?.agentInputs?.find(input => input.source === 'lifecycle');
        expect(wake?.deliveredAt).toBeUndefined();
        release(); await settled;
        // Read synchronously at settlement, before the store's 300ms debounce.
        const disk = (JSON.parse(readFileSync(join(root, '.ai/cezar/runs.json'), 'utf8')) as RunRecord[]).find(run => run.id === p.id)!;
        expect.soft(disk.status).toBe('waiting');
        expect.soft(disk.steps.find(step => step.id === 'task')?.status).toBe('waiting');
        expect(waitOf(disk)).toBeUndefined();
        expect(disk.agentInputs?.find(input => input.id === wake?.id)?.deliveredAt).toEqual(expect.any(String));
      } finally {
        release();
        for (const run of store.listRuns()) manager.cancel(run.id);
        await until(() => store.listRuns().every(run => !manager.isActive(run.id)));
      }
    }, 'Worker wait');
  });

  it('an actual session close during a nonfinal wait cannot advance a check or retain a capacity exemption', async () => {
    const run = manager.startRun({ name: 'closed chain', source: 'built-in', steps: [{ id: 'first', prompt: 'mock:hold' }, { id: 'next', command: 'echo checked' }] }, { task: 'parent', runner: 'claude' });
    store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
    const engine = manager as unknown as { workerWaiting: Set<string>; active: Map<string, { sessionEverOpened?: boolean; session?: { end(): void } }> };
    await until(() => !!engine.active.get(run.id)?.sessionEverOpened);
    const w = await worker(run.id, 'mock:slow'); register(run.id, [w.id]); manager.enqueueOwnedRun(w.id);
    await until(() => engine.workerWaiting.has(run.id));
    engine.active.get(run.id)!.session!.end();
    await until(() => terminal.includes(store.getRun(run.id)!.status));
    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('worker wait') });
    expect(store.getRun(run.id)?.steps.find(step => step.id === 'next')?.status).toBe('pending');
    expect(engine.workerWaiting.has(run.id)).toBe(false);
    await until(() => !manager.isActive(w.id)); expect(semaphore.busy()).toBe(0);
  });

  it('a portable human ask still takes precedence over an accepted nonfinal worker wait', async () => {
    const run = manager.startRun({ name: 'ask chain', source: 'built-in', steps: [{ id: 'first', prompt: 'mock:ask' }, { id: 'next', command: 'echo checked' }] }, { task: 'parent', runner: 'claude' });
    store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
    const engine = manager as unknown as { workerWaiting: Set<string>; active: Map<string, { sessionEverOpened?: boolean }> };
    await until(() => !!engine.active.get(run.id)?.sessionEverOpened);
    const w = await worker(run.id); register(run.id, [w.id]);
    await until(() => store.getRun(run.id)?.status === 'waiting');
    expect(store.readEvents(run.id).some(event => event.type === 'ask.requested')).toBe(true);
    expect(engine.workerWaiting.has(run.id)).toBe(false);
    manager.requestWorkerStop(w.id); await manager.awaitRunTermination(w.id, 15000);
    expect(store.getRun(run.id)?.agentInputs?.some(input => input.deliveredAt)).not.toBe(true);
    expect(store.getRun(run.id)?.steps.find(step => step.id === 'next')?.status).toBe('pending');
    expect(manager.sendMessage(run.id, [{ type: 'text', text: 'Vitest' }])).toBe(true);
    await until(() => store.getRun(run.id)?.steps.find(step => step.id === 'next')?.status === 'done');
    expect(store.readEvents(run.id).filter(event => event.type === 'human-input-delivered')).toHaveLength(1);
  });

  it('ordinary nonfinal auto-end still advances to the next check without a worker wait', async () => {
    const run = manager.startRun({ name: 'ordinary chain', source: 'built-in', steps: [{ id: 'first', prompt: 'mock:hold' }, { id: 'next', command: 'echo checked' }] }, { task: 'parent', runner: 'claude' });
    await until(() => terminal.includes(store.getRun(run.id)!.status));
    expect(store.getRun(run.id)?.steps.map(step => step.status)).toEqual(['done', 'done']);
    expect(semaphore.busy()).toBe(0);
  });


  for (const mode of ['fresh', 'continuation'] as const) {
    it(`${mode}: an admitted undelivered wake cannot suppress a portable ask`, async () => {
      const p = await parent();
      await until(() => store.getRun(p.id)?.status === 'waiting');
      if (mode === 'continuation') {
        manager.finish(p.id); await until(() => !manager.isActive(p.id));
        expect(manager.continueRun(p.id, { text: 'mock:hold' }).ok).toBe(true);
        await until(() => store.getRun(p.id)?.status === 'waiting');
      }
      const engine = manager as unknown as { workerWakeAdmitted: Set<string>; active: Map<string, {
        session: { sendAgentMessage(content: unknown[]): false | Promise<void>; sendMessage(content: unknown[]): boolean }
      }> };
      const session = engine.active.get(p.id)!.session;
      // A backend opening/ack window legitimately refuses non-human input.
      session.sendAgentMessage = () => false;
      const w = await worker(p.id); const wait = register(p.id, [w.id]);
      await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
      fixtureUpdateRun(w.id, { status: 'done' });
      await until(() => engine.workerWakeAdmitted.has(p.id));
      const boundaries = store.readEvents(p.id).filter(event => event.type === 'turn-end').length;
      session.sendMessage([{ type: 'text', text: 'mock:ask' }]);
      await until(() => store.readEvents(p.id).filter(event => event.type === 'turn-end').length > boundaries);
      expect(store.readEvents(p.id).some(event => event.type === 'ask.requested')).toBe(true);
      expect(engine.workerWakeAdmitted.has(p.id)).toBe(false);
      expect(semaphore.busy()).toBe(0);
      expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id);
      expect(store.getRun(p.id)?.agentInputs?.[0]?.deliveredAt).toBeUndefined();
      expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
    });
  }

  for (const role of ['root', 'worker'] as const) {
    it(`${role}: restart re-admits a persisted human answer before its first boundary`, async () => {
      const replyGate = join(root, 'release-human-reply'); const wire = controlledWire({ humanAnswerGate: replyGate });
      const p = await parent('mock:ask');
      await until(() => store.getRun(p.id)?.status === 'waiting');
      const w = await worker(p.id, 'mock:ask');
      const target = role === 'root' ? p : w;
      if (role === 'worker') {
        manager.enqueueOwnedRun(w.id);
        await until(() => store.getRun(w.id)?.status === 'waiting');
      }
      (manager as unknown as { active: Map<string, { session: AgentSession }> }).active.get(target.id)!.session.end();
      await until(() => !manager.isActive(target.id));
      // The explicit human continuation is the only authority to answer the ask.
      expect(manager.continueRun(target.id, { text: 'human answer mock:hold' }).ok).toBe(true);
      if (role === 'root') store.updateRun(w.id, { status: 'queued', finishedAt: undefined });
      store.flush(); const checkpoint = readFileSync(join(root, '.ai/cezar/runs.json'), 'utf8');
      expect(store.getRun(target.id)?.continuationMessage?.origin).toBe('human');
      await until(() => (manager as unknown as { active: Map<string, { sessionEverOpened?: boolean }> }).active.get(target.id)?.sessionEverOpened === true);
      // The real wire received the accepted input but cannot reply until released.
      await until(() => wire.received() === 1);
      manager.cancel(target.id);
      await until(() => !manager.isActive(target.id));
      expect(store.readEvents(target.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
      await restart(false, checkpoint);
      expect(store.getRun(target.id)?.status).not.toBe('failed');
      expect(store.getRun(w.id)?.status).not.toBe('cancelled');
      expect(store.readEvents(target.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
      await until(() => wire.received() === 2);
      expect(store.readEvents(target.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
      writeFileSync(replyGate, 'release');
      await until(() => store.readEvents(target.id).some(event => event.type === 'human-input-delivered'));
      expect(store.readEvents(target.id).filter(event => event.type === 'human-input-delivered')).toHaveLength(1);
      expect(store.readEvents(target.id).filter(event => event.type === 'user-message').at(-1)?.text).toContain('human answer');
    });
  }

  it('restart preserves a queued human answer when wait withdrawal left a blank lifecycle opening', async () => {
    const { p } = await queuedWake();
    store.appendEvent(p.id, { type: 'ask.requested', requestId: randomUUID(), questions: [{
      header: 'Choice', question: 'Which option?', options: [{ label: 'One' }, { label: 'Two' }],
    }] });
    manager.enqueueMessage(p.id, [{ type: 'text', text: 'queued human answer mock:hold' }]);
    expect(store.getRun(p.id)?.continuationMessage).toMatchObject({ text: '', origin: 'human' });
    await restart();
    await until(() => store.readEvents(p.id).some(event => event.type === 'human-input-delivered'));
    expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toHaveLength(1);
    expect(store.readEvents(p.id).filter(event => event.type === 'user-message').at(-1)?.text).toContain('queued human answer');
  });

  it('restart with an empty human-origin checkpoint preserves the ask without a synthetic answer', async () => {
    const p = await parent('mock:ask');
    await until(() => store.getRun(p.id)?.status === 'waiting');
    store.updateRun(p.id, { status: 'running', continuationMessage: {
      id: randomUUID(), text: '', origin: 'human', createdAt: new Date().toISOString(),
    } });
    await restart();
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(manager.isActive(p.id)).toBe(false);
    expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
  });

  it('restart preserves an ordinary parked root without a wait or ask, including after children finish', async () => {
    const p = await parent(); const w = await worker(p.id);
    await until(() => store.getRun(p.id)?.status === 'waiting');
    await restart();
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(store.getRun(w.id)?.status).not.toBe('cancelled');
    await until(() => store.getRun(w.id)?.status === 'waiting');
    manager.finish(w.id); await until(() => !manager.isActive(w.id));
    await restart();
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(manager.continueRun(p.id, { text: 'human follow-up mock:hold' }).ok).toBe(true);
    await until(() => store.getRun(p.id)?.status === 'waiting');
  });

  for (const review of [false, true]) {
    it(`inactive ready root Finish persists intent before async settlement and restart keeps review=${review}`, async () => {
      const p = await parent(); const w = await worker(p.id);
      await until(() => store.getRun(p.id)?.status === 'waiting');
      manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true); await collect(w.id);
      await restart();
      process.env.CEZ_REVIEW_GATE = review ? '1' : '0';
      writeFileSync(join(store.getRun(p.id)!.worktreePath!, 'review-change.txt'), 'review me');
      const engine = manager as unknown as { settleSuccess(id: string, durable?: boolean): Promise<void> };
      const real = engine.settleSuccess.bind(manager);
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
      let completion: Promise<void> | undefined;
      engine.settleSuccess = (id, durable) => completion = gate.then(() => real(id, durable));
      expect(manager.finish(p.id)).toBe(true);
      expect(store.getRun(p.id)?.delegation).toHaveProperty('finishRequestedAt');
      expect(manager.continueRun(p.id, { text: 'too late' }).ok).toBe(false);
      store.flush(); const checkpoint = readFileSync(join(root, '.ai/cezar/runs.json'), 'utf8');
      manager.dispose(); release(); await completion;
      expect(store.getRun(p.id)?.status).toBe(review ? 'review' : 'done');
      await restart(false, checkpoint);
      expect(store.getRun(p.id)?.status).toBe(review ? 'review' : 'done');
      expect(store.getRun(w.id)?.status).toBe('cancelled');
    });
  }

  it('inactive Finish write failure leaves the root recoverable and children untouched', async () => {
    const p = await parent(); const w = await worker(p.id);
    await until(() => store.getRun(p.id)?.status === 'waiting'); await restart();
    await until(() => store.getRun(w.id)?.status === 'waiting');
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true); await collect(w.id);
    await Promise.all(bookkeeping.splice(0)); store.flush();
    const snapshot = JSON.stringify(store.getRun(p.id));
    const tmpPath = join(root, '.ai/cezar/runs.json.tmp'); mkdirSync(tmpPath);
    try { expect(manager.finish(p.id)).toBe(false); }
    finally { rmSync(tmpPath, { recursive: true }); }
    expect(JSON.stringify(store.getRun(p.id))).toBe(snapshot);
    expect(store.getRun(w.id)?.status).toBe('cancelled');
    expect(manager.continueRun(p.id, { text: 'mock:hold' }).ok).toBe(true);
    await until(() => store.getRun(p.id)?.status === 'waiting');
  });

  it.each(['queued', 'continued'])('legacy pending inactive Finish holds %s children while unrelated work progresses', async mode => {
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting'); await restart();
    const w = await worker(p.id); manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    manager.finish(w.id); await until(() => !manager.isActive(w.id));
    const queued = await worker(p.id);
    const blocker = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:slow', runner: 'claude' });
    await until(() => (manager as unknown as { active: Map<string, { sessionEverOpened?: boolean }> }).active.get(blocker.id)?.sessionEverOpened === true);
    manager.enqueueOwnedRun(queued.id);
    const engine = manager as unknown as { settleSuccess(id: string, durable?: boolean): Promise<void> };
    const real = engine.settleSuccess.bind(manager);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let completion: Promise<void> | undefined;
    engine.settleSuccess = (id, durable) => id === p.id ? completion = gate.then(() => real(id, durable)) : real(id, durable);
    try {
      store.commitRootFinishIntent(p.id); void engine.settleSuccess(p.id, true);
      if (mode === 'continued') expect(manager.continueRun(w.id, { text: 'must not start' }).ok).toBe(false);
      const unrelated = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold', runner: 'claude' });
      manager.cancel(blocker.id);
      await until(() => store.getRun(unrelated.id)?.status === 'waiting');
      await manager.rescueStalledQueue();
      expect(store.getRun(queued.id)?.status).toBe('queued');
      expect(store.getRun(queued.id)?.worktreePath).toBeUndefined();
      expect(store.readEvents(queued.id).some(event => event.type === 'session')).toBe(false);
      expect(semaphore.busy()).toBe(0);
    } finally { release(); await completion; }
    expect(store.getRun(queued.id)?.status).not.toBe('cancelled');
    expect(store.getRun(p.id)?.status).toBe('waiting');
  });

  it.each(['fresh', 'continuation'])('legacy pending inactive Finish rechecks a %s child at the pre-spawn boundary', async mode => {
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting'); await restart();
    const w = await worker(p.id);
    if (mode === 'continuation') {
      manager.enqueueOwnedRun(w.id); await until(() => store.getRun(w.id)?.status === 'waiting');
      manager.finish(w.id); await until(() => !manager.isActive(w.id));
    }
    const engine = manager as unknown as {
      agentEnvForStep(id: string, ...args: unknown[]): Promise<unknown>;
      settleSuccess(id: string, durable?: boolean): Promise<void>;
    };
    const env = engine.agentEnvForStep.bind(manager); const settle = engine.settleSuccess.bind(manager);
    let start!: () => void; let finish!: () => void; let entered = false; let completion: Promise<void> | undefined;
    const startGate = new Promise<void>(resolve => { start = resolve; });
    const finishGate = new Promise<void>(resolve => { finish = resolve; });
    engine.agentEnvForStep = async (id, ...args) => { if (id === w.id) { entered = true; await startGate; } return env(id, ...args); };
    engine.settleSuccess = (id, durable) => id === p.id ? completion = finishGate.then(() => settle(id, durable)) : settle(id, durable);
    const sessions = store.readEvents(w.id).filter(event => event.type === 'session').length;
    try {
      if (mode === 'continuation') expect(manager.continueRun(w.id, { text: 'mock:hold' }).ok).toBe(true);
      else manager.enqueueOwnedRun(w.id);
      await until(() => entered);
      store.commitRootFinishIntent(p.id); void engine.settleSuccess(p.id, true);
      start();
      await until(() => store.getRun(w.id)?.status === 'queued');
      expect(store.readEvents(w.id).filter(event => event.type === 'session')).toHaveLength(sessions);
      expect(semaphore.busy()).toBe(0);
    } finally { start(); finish(); await completion; }
    expect(store.getRun(w.id)?.status).not.toBe('cancelled');
    expect(store.getRun(p.id)?.status).toBe('waiting');
  });

  for (const failure of ['diff', 'checkpoint'] as const) {
    it(`inactive Finish retains retryable intent after ${failure} failure and checkpoints successful publication`, async () => {
      const p = await parent(); const w = await worker(p.id);
      await until(() => store.getRun(p.id)?.status === 'waiting'); await restart();
      await until(() => store.getRun(w.id)?.status === 'waiting');
      manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true); await collect(w.id);
      await Promise.all(bookkeeping.splice(0));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const commit = store.commitRootFinishSuccess.bind(store);
      if (failure === 'diff') store.updateRun(p.id, { baseBranch: 'nonexistent-ref' });
      else store.commitRootFinishSuccess = (...args) => {
        const tmpPath = join(root, '.ai/cezar/runs.json.tmp'); mkdirSync(tmpPath);
        try { return commit(...args); } finally { rmSync(tmpPath, { recursive: true }); }
      };
      expect(manager.finish(p.id)).toBe(true);
      await until(() => warn.mock.calls.length > 0);
      expect(store.getRun(p.id)?.status).toBe('waiting');
      expect(store.getRun(p.id)?.delegation).toHaveProperty('finishRequestedAt');
      expect(store.getRun(w.id)?.status).toBe('cancelled');
      expect(manager.continueRun(p.id, { text: 'cannot supersede finish' }).ok).toBe(false);
      expect(() => manager.steerWorker(w.id, { id: randomUUID(), parentRunId: p.id, source: 'agent',
        text: 'cannot steer', createdAt: new Date().toISOString() })).toThrow('finish');
      store.commitRootFinishSuccess = commit; store.updateRun(p.id, { baseBranch: 'main' });
      let durableStatus: string | undefined;
      const observe = (run: RunRecord) => {
        if (run.id === p.id && run.status === 'done') {
          durableStatus = (JSON.parse(readFileSync(join(root, '.ai/cezar/runs.json'), 'utf8')) as RunRecord[]).find(run => run.id === p.id)?.status;
        }
      };
      store.on('run', observe);
      expect(manager.finish(p.id)).toBe(true);
      await until(() => store.getRun(p.id)?.status === 'done');
      expect(durableStatus).toBe('done');
      expect(store.getRun(p.id)?.delegation).not.toHaveProperty('finishRequestedAt');
      store.off('run', observe); warn.mockRestore();
    });
  }

  it.each([false, true])('monitoring synthetic delivery respects legacy pending Finish=%s before wake bookkeeping', async pending => {
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting'); await restart();
    const w = await worker(p.id, 'mock:monitoring keep going');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    manager.enqueueOwnedRun(w.id);
    await until(() => !!store.getRun(w.id)?.monitoringWakeAt);
    const engine = manager as unknown as {
      active: Map<string, { monitoringWakeups?: number; session: { sendAgentMessage(...args: unknown[]): false | Promise<void> } }>;
      monitoring: Set<string>;
      settleSuccess(id: string, durable?: boolean): Promise<void>;
      deliverMessage(id: string, content: { type: 'text'; text: string }[], human: boolean): boolean;
    };
    const state = engine.active.get(w.id)!;
    const send = vi.spyOn(state.session, 'sendAgentMessage');
    const settle = engine.settleSuccess.bind(manager);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let completion: Promise<void> | undefined;
    engine.settleSuccess = (id, durable) => id === p.id ? completion = gate.then(() => settle(id, durable)) : settle(id, durable);
    const deadline = store.getRun(w.id)!.monitoringWakeAt!;
    try {
      if (pending) store.commitRootFinishIntent(p.id);
      await vi.advanceTimersByTimeAsync(Date.parse(deadline) - Date.now() + 1);
      if (pending) {
        expect(send).not.toHaveBeenCalled();
        expect(state.monitoringWakeups ?? 0).toBe(0);
        expect(store.getRun(w.id)).toMatchObject({ status: 'running', activity: 'monitoring', monitoringWakeAt: deadline });
        expect(engine.monitoring.has(w.id)).toBe(true);
        expect(store.readEvents(w.id).some(event => event.type === 'note' && typeof event.message === 'string' && event.message.includes('automatic monitoring wake-up'))).toBe(false);
        expect(engine.deliverMessage(w.id, [{ type: 'text', text: 'synthetic retry' }], false)).toBe(false);
        expect(send).not.toHaveBeenCalled();
      } else {
        expect(send).toHaveBeenCalledTimes(1);
        expect(state.monitoringWakeups).toBe(1);
        expect(engine.monitoring.has(w.id)).toBe(false);
        expect(store.getRun(w.id)?.activity).toBeUndefined();
      }
    } finally { vi.useRealTimers(); release(); await completion; }
  });

  it.each(['delayed diff', 'failed diff'])('cancellation retires pending Finish after %s and preserves human Continue across restart', async mode => {
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting'); await restart();
    const engine = manager as unknown as { settleSuccess(id: string, durable?: boolean): Promise<void> };
    const settle = engine.settleSuccess.bind(manager);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let completion: Promise<void> | undefined;
    engine.settleSuccess = (id, durable) => completion = (mode === 'delayed diff' ? gate : Promise.resolve()).then(() => settle(id, durable));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      if (mode === 'failed diff') store.updateRun(p.id, { baseBranch: 'nonexistent-ref' });
      expect(manager.finish(p.id)).toBe(true);
      if (mode === 'failed diff') await until(() => warn.mock.calls.length > 0);
      expect(manager.cancel(p.id)).toBe(true);
      // Read disk without flush: cancellation and retirement are one durable checkpoint.
      const disk = (JSON.parse(readFileSync(join(root, '.ai/cezar/runs.json'), 'utf8')) as RunRecord[]).find(run => run.id === p.id)!;
      expect(disk.status).toBe('cancelled');
      expect(disk.delegation).not.toHaveProperty('finishRequestedAt');
      release(); await completion?.catch(() => {});
      expect(store.getRun(p.id)?.status).toBe('cancelled');
      expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
      store.updateRun(p.id, { baseBranch: 'main' });
      await restart();
      expect(manager.continueRun(p.id, { text: 'actual human answer mock:hold' }).ok).toBe(true);
      await until(() => store.getRun(p.id)?.status === 'waiting');
    } finally { release(); await completion?.catch(() => {}); warn.mockRestore(); }
  });

  it('restart durably reconciles cancelled roots with superseded Finish intent', async () => {
    const p = await parent('mock:ask'); await until(() => store.getRun(p.id)?.status === 'waiting'); await restart();
    store.commitRootFinishIntent(p.id);
    store.updateRun(p.id, { status: 'cancelled', finishedAt: new Date().toISOString() });
    store.flush(); const checkpoint = readFileSync(join(root, '.ai/cezar/runs.json'), 'utf8');
    await restart(false, checkpoint);
    expect(store.getRun(p.id)?.status).toBe('cancelled');
    const disk = (JSON.parse(readFileSync(join(root, '.ai/cezar/runs.json'), 'utf8')) as RunRecord[]).find(run => run.id === p.id)!;
    expect(disk.delegation).not.toHaveProperty('finishRequestedAt');
    expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
    expect(manager.continueRun(p.id)).toMatchObject({ ok: false, error: 'pending human question requires an explicit answer' });
    expect(manager.continueRun(p.id, { text: 'actual human answer mock:hold' }).ok).toBe(true);
    await until(() => store.readEvents(p.id).some(event => event.type === 'human-input-delivered'));
  });

});
