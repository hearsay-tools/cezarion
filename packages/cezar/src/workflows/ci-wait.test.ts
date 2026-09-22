import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CiWait, CiWaitResult } from '@open-mercato/cezar-contract';
import { controlledWire, manager, parent, root, restart, semaphore, store, until, worker, waitOf, useWorkerWaitFixture } from './worker-wait.testkit.ts';

// Tool transport is exercised by adapter parity; lifecycle tests control only external resources.
const externalResource = vi.hoisted(() => ({ supervisor: {} }));
vi.mock('../ci-wait/resources.ts', () => ({ acquireCiResources: () => ({
  supervisor: externalResource.supervisor, controller: async () => undefined, release() {},
}) }));

const pr = 'https://github.com/acme/repo/pull/12';
const identity = { prUrl: pr, repository: 'acme/repo', prNumber: 12, headSha: 'a'.repeat(40) };
const success = (): CiWaitResult => ({ outcome: 'passed', headSha: identity.headSha, observedAt: new Date().toISOString(), checks: [], totalChecks: 1, truncated: true });

/** Control only external GitHub; RunManager, store, scheduler and runner wire stay real. */
function github() {
  let settle!: (result: CiWaitResult) => void;
  let signal: AbortSignal | undefined;
  const result = new Promise<CiWaitResult>(resolve => { settle = resolve; });
  const supervisor = { resolve: async () => identity, watch: async (_wait: CiWait, abort: AbortSignal) => { signal = abort; return result; }, close() {} };
  externalResource.supervisor = supervisor;
  Object.assign(manager, { ciSupervisor: supervisor });
  return { settle, aborted: () => signal?.aborted };
}

function register(id: string) {
  const state = (manager as unknown as { active: Map<string, { ciGeneration: string }> }).active.get(id)!;
  return manager.registerCiWait(id, { pr, timeout_seconds: 30 }, state.ciGeneration);
}

describe('CI wait lifecycle through real runner turns', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());

  it('rejects registration outside an active run without writing a receipt', async () => {
    github();
    await expect(Promise.resolve().then(() => manager.registerCiWait('absent', { pr, timeout_seconds: 30 }, 'old')))
      .rejects.toThrow(/cannot register/i);
    expect(store.listRuns()).toEqual([]);
  });

  it('persists registration while executing, then parks marker-free without nudges or timed wakes', async () => {
    const external = github();
    const gate = join(root, 'turn-boundary');
    const wire = controlledWire({ firstResultGate: gate });
    const run = await parent();
    await until(wire.initialReceived);
    const receipt = await register(run.id);
    expect(receipt.phase).toBe('registered');
    const persisted = JSON.parse(readFileSync(join(root, '.ai/cezar/runs.json'), 'utf8')) as Array<{ id: string; ciWait?: CiWait }>;
    expect(persisted.find(row => row.id === run.id)?.ciWait?.id).toBe(receipt.id);
    expect(store.getRun(run.id)?.activity).not.toBe('monitoring');
    writeFileSync(gate, 'end');
    await until(() => store.getRun(run.id)?.ciWait?.phase === 'parked');
    expect(store.getRun(run.id)).toMatchObject({ status: 'running', activity: 'monitoring' });
    expect(store.getRun(run.id)?.monitoringWakeAt).toBeUndefined();
    expect(semaphore.busy()).toBe(0);
    expect(external.aborted()).toBe(false);
  });

  it('queues early completion until turn boundary and acknowledges exactly one lifecycle input', async () => {
    const external = github();
    const gate = join(root, 'turn-boundary');
    const wire = controlledWire({ firstResultGate: gate });
    const run = await parent(); await until(wire.initialReceived);
    const receipt = await register(run.id);
    external.settle(success());
    await until(() => store.getRun(run.id)?.ciWait?.phase === 'wake-pending');
    expect(store.getRun(run.id)?.agentInputs?.find(input => input.id === receipt.id)?.deliveredAt).toBeUndefined();
    expect(store.getRun(run.id)?.activity).not.toBe('monitoring');
    writeFileSync(gate, 'end');
    await until(() => !!store.getRun(run.id)?.lastCiWait?.deliveredAt);
    expect(store.getRun(run.id)?.ciWait).toBeUndefined();
    expect(store.getRun(run.id)?.agentInputs?.filter(input => input.id === receipt.id)).toHaveLength(1);
    expect(store.getRun(run.id)?.status).not.toBe('done');
  });

  it('deduplicates matching registrations without extending the deadline', async () => {
    github();
    const gate = join(root, 'turn-boundary'); controlledWire({ firstResultGate: gate });
    const run = await parent();
    const first = await register(run.id); const second = await register(run.id);
    expect(second.id).toBe(first.id); expect(second.deadline).toBe(first.deadline);
    writeFileSync(gate, 'end');
  });

  it('withdraws on human interruption and ignores late watcher results', async () => {
    const external = github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    const receipt = await register(run.id);
    expect(manager.sendMessage(run.id, [{ type: 'text', text: 'Please continue with my change' }])).toBe(true);
    expect(store.getRun(run.id)?.ciWait).toBeUndefined();
    expect(store.getRun(run.id)?.lastCiWait?.phase).toBe('withdrawn');
    expect(external.aborted()).toBe(true);
    external.settle(success());
    await until(() => store.getRun(run.id)?.status === 'waiting');
    expect(store.getRun(run.id)?.agentInputs?.some(input => input.id === receipt.id)).not.toBe(true);
  });
  it('does not require worker delegation permissions', async () => {
    github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    store.updateRun(run.id, { delegation: undefined });
    const receipt = await register(run.id);
    expect(receipt.phase).toBe('parked');
    expect(store.getRun(run.id)?.delegation).toBeUndefined();
  });

  it('reacquires capacity before delivering a completed wait', async () => {
    const external = github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    const receipt = await register(run.id);
    const blockerGate = join(root, 'blocker-gate'); controlledWire({ firstResultGate: blockerGate });
    const blocker = await parent();
    await until(() => semaphore.busy() === 1);
    external.settle(success());
    await until(() => store.getRun(run.id)?.ciWait?.phase === 'wake-pending');
    expect(store.getRun(run.id)?.agentInputs?.find(input => input.id === receipt.id)?.deliveredAt).toBeUndefined();
    expect(semaphore.busy()).toBe(1);
    writeFileSync(blockerGate, 'end');
    await until(() => !!store.getRun(run.id)?.lastCiWait?.deliveredAt);
    expect(store.getRun(blocker.id)?.status).not.toBe('cancelled');
  });

  it('resumes a monitor that already holds a charged slot with the exemption disabled', async () => {
    vi.spyOn(semaphore, 'maxMonitoringSessions').mockReturnValue(0);
    const external = github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    await register(run.id);
    expect(semaphore.busy()).toBe(1);
    external.settle(success());
    await until(() => !!store.getRun(run.id)?.lastCiWait?.deliveredAt);
    expect(store.getRun(run.id)?.ciWait).toBeUndefined();
  });

  it('rebuilds a parked wait after restart without launching a model before settlement', async () => {
    const external = github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    const receipt = await register(run.id);
    await restart();
    expect(manager.isActive(run.id)).toBe(false);
    expect(store.getRun(run.id)?.ciWait?.id).toBe(receipt.id);
    expect(store.getRun(run.id)).toMatchObject({ status: 'running', activity: 'monitoring' });
    external.settle(success());
    await until(() => !!store.getRun(run.id)?.lastCiWait?.deliveredAt);
    expect(store.getRun(run.id)?.agentInputs?.filter(input => input.id === receipt.id)).toHaveLength(1);
  });

  it('cancellation retires the wait and never reopens the run on late completion', async () => {
    const external = github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    await register(run.id);
    expect(manager.cancel(run.id)).toBe(true);
    await until(() => !manager.isActive(run.id));
    external.settle(success());
    await Promise.resolve();
    expect(store.getRun(run.id)?.status).toBe('cancelled');
    expect(store.getRun(run.id)?.ciWait).toBeUndefined();
  });

  it('refuses stale registration that resolves after a human interruption', async () => {
    github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    let resolve!: (value: typeof identity) => void;
    const deferred = new Promise<typeof identity>(done => { resolve = done; });
    Object.assign(manager, { ciSupervisor: { resolve: () => deferred } });
    const registration = register(run.id);
    expect(manager.sendMessage(run.id, [{ type: 'text', text: 'mock:hold new instruction' }])).toBe(true);
    resolve(identity);
    await expect(registration).rejects.toThrow(/interruption/);
    expect(store.getRun(run.id)?.ciWait).toBeUndefined();
  });

  it('coalesces concurrent identical registration requests', async () => {
    github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    const [first, second] = await Promise.all([register(run.id), register(run.id)]);
    expect(first.id).toBe(second.id);
    expect(first.deadline).toBe(second.deadline);
  });

  it('a human ask at turn-end withdraws CI and remains unanswered by its result', async () => {
    const external = github();
    const gate = join(root, 'ask-boundary'); controlledWire({ firstResultGate: gate });
    const run = await parent('mock:ask');
    await register(run.id);
    writeFileSync(gate, 'end');
    await until(() => store.getRun(run.id)?.status === 'waiting');
    expect(store.getRun(run.id)?.ciWait).toBeUndefined();
    expect(external.aborted()).toBe(true);
    external.settle(success());
    await Promise.resolve();
    expect(store.getRun(run.id)?.hasPendingHumanAsk).toBe(true);
    expect(store.getRun(run.id)?.agentInputs ?? []).toEqual([]);
  });

  it('backend disconnect retains the bounded wait and recovers only after settlement', async () => {
    const external = github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    await register(run.id);
    const state = (manager as unknown as { active: Map<string, { session: { end(): void } }> }).active.get(run.id)!;
    state.session.end();
    await until(() => !manager.isActive(run.id));
    expect(store.getRun(run.id)).toMatchObject({ status: 'running', activity: 'monitoring' });
    external.settle(success());
    await until(() => !!store.getRun(run.id)?.lastCiWait?.deliveredAt);
    expect(store.getRun(run.id)?.lastCiWait?.result?.outcome).toBe('passed');
  });

  it('a CI wait prevents nonfinal auto-end and advances the workflow only after the resumed turn', async () => {
    const external = github();
    const gate = join(root, 'nonfinal-boundary'); controlledWire({ firstResultGate: gate });
    const run = manager.startRun({ name: 'ci-chain', source: 'built-in', steps: [
      { id: 'first', prompt: 'hold' }, { id: 'check', command: 'node -e "process.exit(0)"' },
    ] }, { task: 'CI chain', runner: 'claude' });
    await until(() => !!(manager as unknown as { active: Map<string, { sessionEverOpened?: boolean }> }).active.get(run.id)?.sessionEverOpened);
    await register(run.id); writeFileSync(gate, 'end');
    await until(() => store.getRun(run.id)?.ciWait?.phase === 'parked');
    expect(store.getRun(run.id)?.steps.find(step => step.id === 'check')?.status).toBe('pending');
    external.settle(success());
    await until(() => !manager.isActive(run.id));
    expect(store.getRun(run.id)?.steps.map(step => step.status)).toEqual(['done', 'done']);
  });

  it('retains worker conversation behind the CI observation without losing admission', async () => {
    const external = github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    const wait = await register(run.id);
    const messageId = randomUUID();
    store.commitAgentInputs(run.id, [{ id: messageId, parentRunId: run.id, source: 'agent', text: 'worker update',
      createdAt: new Date().toISOString(), conversation: { senderRunId: randomUUID(), recipientRunId: run.id, kind: 'progress' } }]);
    manager.deliverConversationInput(run.id);
    expect(store.getRun(run.id)?.activity).toBe('monitoring');
    expect(waitOf(store.getRun(run.id))).toBeUndefined();
    external.settle(success());
    await until(() => !!store.getRun(run.id)?.lastCiWait?.deliveredAt);
    await until(() => !!store.getRun(run.id)?.agentInputs?.find(input => input.id === messageId)?.deliveredAt);
    const delivered = store.getRun(run.id)!.agentInputs!;
    expect(delivered.find(input => input.id === wait.id)?.deliveredAt).toBeTruthy();
  });

  it('reconciles a settled CI wake after an owned worker execution finalizes', async () => {
    const external = github();
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const gate = join(root, 'worker-boundary'); controlledWire({ firstResultGate: gate });
    const child = await worker(p.id); manager.enqueueOwnedRun(child.id);
    await until(() => !!(manager as unknown as { active: Map<string, { sessionEverOpened?: boolean }> }).active.get(child.id)?.sessionEverOpened);
    await register(child.id);
    external.settle(success());
    await until(() => store.getRun(child.id)?.ciWait?.phase === 'wake-pending');
    const state = (manager as unknown as { active: Map<string, { session: { end(): void } }> }).active.get(child.id)!;
    state.session.end(); writeFileSync(gate, 'end');
    await until(() => !!store.getRun(child.id)?.lastCiWait?.deliveredAt);
    expect(store.getRun(child.id)?.ciWait).toBeUndefined();
  });

});
