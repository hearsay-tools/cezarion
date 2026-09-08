import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest';
import { workerWaitRequestSchema, type WorkerWait } from '@open-mercato/cezar-contract';
import { RunStore, type RunRecord } from '../runs/store.ts';
import * as runnerFactory from '../core/runner-factory.ts';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { DelegationService } from '../delegation/service.ts';
import { collectWorkerEvidence } from '../delegation/results.ts';
import { planOwnedWorkspace } from '../delegation/workspace.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import { currentUsage } from '../core/process-usage.ts';
import type { AgentSession } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { withDelayedCommand } from '../core/owned-input-delivery.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

const terminal = ['review', 'done', 'failed', 'cancelled'];
async function until(predicate: () => boolean) { await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 15_000, interval: 10 }); }
const waitOf = (run: RunRecord | undefined) => run?.delegation && run.delegation.role !== 'invalid' ? run.delegation.wait : undefined;

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.
describe('worker waits through RunManager', { timeout: 30_000 }, () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let semaphore: WorkspaceSemaphore;
  let saved: NodeJS.ProcessEnv;
  let phase = 'setup';
  let checkpoints: Array<{ phase: string; ms: number }> = [];
  let began = 0;
  let failureState: unknown;
  function checkpoint(value: string) { phase = value; checkpoints.push({ phase, ms: Math.round(performance.now() - began) }); }
  function captureState() { return { root, phase, checkpoints: checkpoints.map(entry => ({ ...entry })), elapsedMs: Math.round(performance.now() - began), busy: semaphore?.busy(),
    runs: store?.listRuns().map(run => ({ id: run.id, status: run.status, error: run.error, step: run.currentStepId, wait: waitOf(run)?.phase,
      events: store.readEvents(run.id).slice(-6).map(event => ({ type: event.type, seq: event.seq, ...('message' in event ? { message: String(event.message).slice(0, 256) } : {}) })) })),
  }; }
  const bookkeeping: Promise<unknown>[] = [];
  const executions: Promise<unknown>[] = [];
  function track() {
    const engine = manager as unknown as Record<'execute' | 'runContinuation', (...args: unknown[]) => Promise<unknown>>;
    for (const name of ['execute', 'runContinuation'] as const) {
      const real = engine[name].bind(manager);
      engine[name] = (...args) => { const result = real(...args); executions.push(result); return result; };
    }
    const internals = manager as unknown as { recordTurnEnd(...args: unknown[]): Promise<unknown> };
    const real = internals.recordTurnEnd.bind(manager);
    internals.recordTurnEnd = (...args) => { const result = real(...args); bookkeeping.push(result); return result; };
  }
  beforeEach(() => {
    saved = { ...process.env }; began = performance.now(); checkpoints = []; failureState = undefined; checkpoint('setup');
    onTestFailed(() => console.error('WORKER_WAIT_FAILURE_STATE', JSON.stringify(failureState ?? captureState())));
    process.env.CEZ_DRY_RUN = '1'; process.env.CEZ_AUTONAME = '0';
    root = mkdtempSync(join(tmpdir(), 'cez-worker-wait-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
    semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 1 } });
    store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, root, { semaphore }); track();
  });
  afterEach(async () => {
    failureState = captureState();
    vi.useRealTimers();
    // Cancellation during the dequeue/spawn gap is covered by Task 6's barrier;
    // this fixture waits for its real runner handles before stopping processes.
    await until(() => {
      const engine = manager as unknown as { starting: Set<string>; active: Map<string, { sessionEverOpened?: boolean }> };
      return engine.starting.size === 0 && [...engine.active.values()].every(state => state.sessionEverOpened);
    });
    for (const run of store.listRuns()) manager.cancel(run.id);
    await until(() => store.listRuns().every(run => !manager.isActive(run.id)));
    await Promise.all(executions.splice(0));
    await Promise.all(bookkeeping.splice(0));
    manager.dispose(); store.flush();
    rmSync(root, { recursive: true, force: true });
    process.env = saved;
  }, 30_000);
  function controlledWire(options: { firstResultGate?: string; humanAnswerGate?: string } = {}) {
    const wire = join(root, 'controlled-claude.cjs'); const received = join(root, 'human-answer-received.ndjson'); const initial = join(root, 'first-input-received');
    writeFileSync(wire, String.raw`#!/usr/bin/env node
const fs = require('node:fs'); const rl = require('node:readline').createInterface({ input: process.stdin });
const emit = value => console.log(JSON.stringify(value)); let first = true; let queue = Promise.resolve();
const options = ${JSON.stringify(options)}; const received = ${JSON.stringify(received)};
const wait = async path => { while (path && !fs.existsSync(path)) await new Promise(resolve => setTimeout(resolve, 5)); };
const args = process.argv.slice(2); const sessionIndex = args.indexOf('--session-id');
emit({ type: 'system', subtype: 'init', session_id: sessionIndex >= 0 ? args[sessionIndex + 1] : 'controlled-session' });
rl.on('line', line => { queue = queue.then(async () => {
  const message = JSON.parse(line); const content = message.message?.content ?? [];
  const text = typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  if (first) { first = false; fs.writeFileSync(${JSON.stringify(initial)}, 'received'); await wait(options.firstResultGate); }
  const humanAnswer = text.includes('human answer mock:hold');
  if (humanAnswer && options.humanAnswerGate) { fs.appendFileSync(received, JSON.stringify({ text }) + '\n'); await wait(options.humanAnswerGate); }
  const ask = !humanAnswer && text.includes('mock:ask') ? '\nCEZ:ASK ' + JSON.stringify({ questions: [{ header: 'Choice', question: 'Which framework?', options: [{ label: 'Vitest' }, { label: 'Other' }] }] }) : '';
  const reply = 'controlled wire reply' + ask;
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
  emit({ type: 'result', subtype: 'success', result: reply, usage: { input_tokens: 1, output_tokens: 1 } });
}); });
rl.on('close', () => process.exit(0));
`); chmodSync(wire, 0o755);
    process.env.CEZ_DRY_RUN = '0'; process.env.CEZ_CLAUDE_BIN = wire;
    return { initialReceived: () => existsSync(initial), received: () => existsSync(received) ? readFileSync(received, 'utf8').trim().split('\n').length : 0 };
  }

  async function parent(task = 'mock:hold') {
    checkpoint('parent-start');
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task, runner: 'claude' });
    store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
    await until(() => (manager as unknown as { active: Map<string, { sessionEverOpened?: boolean }> }).active.get(run.id)?.sessionEverOpened === true);
    checkpoint('parent-session-open'); return run;
  }
  async function worker(parentId: string, task = 'mock:hold') {
    checkpoint('worker-plan-start');
    const id = randomUUID();
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const workspace = await planOwnedWorkspace(root, id, sha);
    checkpoint('worker-planned');
    const run = store.createOwnedRun({ title: 'worker', task, workflow: 'quick-task', runner: 'claude', steps: [{ id: 'task', kind: 'agent', name: 'Task' }] }, parentId, randomUUID(), {
      role: 'worker', permissions: [], parentRunId: parentId, workspace,
    }, 'a'.repeat(64));
    checkpoint('worker-created'); return run;
  }
  function register(parentId: string, ids: string[], seconds = 600) {
    return manager.registerWorkerWait(parentId, workerWaitRequestSchema.parse({ workerIds: ids, timeoutSeconds: seconds }));
  }
  async function restart(fakeClock = false, diskCheckpoint?: string) {
    checkpoint('restart-stop-start');
    store.flush(); const disk = diskCheckpoint ?? readFileSync(join(root, '.ai/cezar/runs.json'), 'utf8');
    for (const run of store.listRuns()) manager.cancel(run.id);
    await until(() => store.listRuns().every(run => !manager.isActive(run.id)));
    await Promise.all(executions.splice(0));
    await Promise.all(bookkeeping.splice(0)); manager.dispose(); store.flush(); checkpoint('restart-stopped');
    writeFileSync(join(root, '.ai/cezar/runs.json'), disk);
    store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    if (fakeClock) vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    manager = new RunManager(store, root, { semaphore }); track(); checkpoint('restart-recover-start');
    await manager.recover(); checkpoint('restart-recovered');
  }

  async function conversationPair() {
    process.env.CEZ_DELEGATION = '1';
    const p = await parent();
    const metadata = store.getRun(p.id)!.delegation!;
    if (metadata.role !== 'root') throw Error('missing root');
    store.commitDelegation([{ id: p.id, delegation: { ...metadata, permissions: [...metadata.permissions, 'steer'] } }]);
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id);
    manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    const credentials = new CredentialRegistry();
    const callers = [p, w].map(run => credentials.authenticate(credentials.issue('project', run.id, randomUUID()))!);
    const service = new DelegationService();
    service.registerProject({ id: 'project', root, store, manager });
    return { p, w, service, parentCaller: callers[0]!, workerCaller: callers[1]!, close: () => credentials.close() };
  }

  it('conversation: worker request wait releases capacity and explicit parent reply wakes exactly once', async () => {
    const f = await conversationPair();
    try {
      const id = randomUUID();
      await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'request', text: 'Which module? mock:hold', timeoutSeconds: 600 });
      const wait = manager.registerRequestWait(f.w.id, { requestIds: [id], timeoutSeconds: 600 });
      await until(() => waitOf(store.getRun(f.w.id))?.phase === 'parked');
      await until(() => store.getRun(f.p.id)?.status === 'waiting');
      expect(semaphore.busy()).toBe(0);
      const reply = { id: randomUUID(), recipientRunId: f.w.id, kind: 'reply' as const, requestId: id, text: 'The parser. mock:hold', timeoutSeconds: 600 };
      await f.service.send(f.parentCaller, reply);
      await until(() => !waitOf(store.getRun(f.w.id)));
      await f.service.send(f.parentCaller, reply);
      manager.reconcileWorkerWaits(); manager.reconcileWorkerWaits();
      expect(store.getRun(f.w.id)?.agentInputs?.filter(input => input.id === wait.id && input.deliveredAt)).toHaveLength(1);
      expect(store.getRun(f.w.id)?.agentInputs?.filter(input => input.id === reply.id)).toHaveLength(1);
      const rootState = store.getRun(f.p.id)?.delegation;
      expect(rootState?.role === 'root' && rootState.conversation?.outcomes).toEqual([expect.objectContaining({ requestId: id, status: 'replied', replyId: reply.id })]);
    } finally { f.close(); }
  });

  it('conversation: reply before registration satisfies request wait and is retained after retirement', async () => {
    const f = await conversationPair();
    try {
      const id = randomUUID();
      await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'request', text: 'Early question mock:hold', timeoutSeconds: 600 });
      await until(() => store.getRun(f.p.id)?.status === 'waiting');
      await f.service.send(f.parentCaller, { id: randomUUID(), recipientRunId: f.w.id, kind: 'reply', requestId: id, text: 'Early reply mock:hold', timeoutSeconds: 600 });
      await until(() => store.getRun(f.w.id)?.status === 'waiting' && !waitOf(store.getRun(f.w.id)) && !!store.getRun(f.w.id)?.agentInputs?.every(input => input.deliveredAt));
      const wait = manager.registerRequestWait(f.w.id, { requestIds: [id], timeoutSeconds: 600 });
      expect(wait.reason).toBe('outcome');
      await until(() => !waitOf(store.getRun(f.w.id)));
      const metadata = store.getRun(f.w.id)?.delegation;
      expect(metadata && metadata.role !== 'invalid' && metadata.lastWait?.requestOutcomes).toEqual([expect.objectContaining({ requestId: id, status: 'replied' })]);
    } finally { f.close(); }
  });

  it('conversation: incoming question interrupts a parked wait without settling its obligation', async () => {
    const f = await conversationPair();
    try {
      const first = randomUUID();
      await f.service.send(f.workerCaller, { id: first, recipientRunId: f.p.id, kind: 'request', text: 'Need module mock:hold', timeoutSeconds: 600 });
      manager.registerRequestWait(f.w.id, { requestIds: [first], timeoutSeconds: 600 });
      await until(() => waitOf(store.getRun(f.w.id))?.phase === 'parked');
      await until(() => store.getRun(f.p.id)?.status === 'waiting');
      const second = randomUUID();
      await f.service.send(f.parentCaller, { id: second, recipientRunId: f.w.id, kind: 'request', text: 'Which options? mock:hold', timeoutSeconds: 600 });
      await until(() => !waitOf(store.getRun(f.w.id)));
      const metadata = store.getRun(f.w.id)?.delegation;
      expect(metadata && metadata.role !== 'invalid' && metadata.lastWait?.reason).toBe('message');
      const rootState = store.getRun(f.p.id)?.delegation;
      expect(rootState?.role === 'root' && rootState.conversation?.outcomes).toEqual([]);
      expect(store.getRun(f.w.id)?.agentInputs?.find(input => input.id === second)?.deliveredAt).toBeTruthy();
    } finally { f.close(); }
  });

  it('conversation: request deadlines settle without registering a wait or polling', async () => {
    const f = await conversationPair();
    try {
      const id = randomUUID();
      await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'request', text: 'Deadline question mock:hold', timeoutSeconds: 1 });
      await until(() => {
        const rootState = store.getRun(f.p.id)?.delegation;
        return rootState?.role === 'root' && rootState.conversation?.outcomes.some(outcome => outcome.requestId === id && outcome.status === 'timed-out') === true;
      });
      expect(store.getRun(f.w.id)?.status).toBe('waiting');
      expect(store.getRun(f.p.id)?.status).not.toBe('cancelled');
    } finally { f.close(); }
  });

  it('conversation: restart restores a worker request wait, deadline, and one wake receipt', async () => {
    const f = await conversationPair();
    try {
      const id = randomUUID();
      await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'request', text: 'Recovery question mock:hold', timeoutSeconds: 600 });
      await until(() => !waitOf(store.getRun(f.p.id)) && !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === id)?.deliveredAt);
      const wait = manager.registerRequestWait(f.w.id, { requestIds: [id], timeoutSeconds: 600 });
      await until(() => waitOf(store.getRun(f.w.id))?.phase === 'parked');
      await restart();
      expect(store.getRun(f.w.id)?.status).toBe('waiting');
      expect(waitOf(store.getRun(f.w.id))).toMatchObject({ id: wait.id, requestIds: [id], deadline: wait.deadline, phase: 'parked' });
      manager.cancelWorkerWait(f.w.id, wait.id);
      checkpoint('conversation-cancel-wait');
      await until(() => !waitOf(store.getRun(f.w.id)));
      checkpoint('conversation-wake-retired');
      expect(store.getRun(f.w.id)?.agentInputs?.filter(input => input.id === wait.id && input.deliveredAt)).toHaveLength(1);
      manager.reconcileWorkerWaits(); manager.reconcileWorkerWaits();
      expect(store.getRun(f.w.id)?.agentInputs?.filter(input => input.id === wait.id)).toHaveLength(1);
    checkpoint('conversation-test-complete');
    } finally { f.close(); }
  });

  it('conversation: parent waits for replies from two workers without treating the first as an interruption', async () => {
    const f = await conversationPair(); const credentials = new CredentialRegistry();
    try {
      const secondWorker = await worker(f.p.id);
      manager.enqueueOwnedRun(secondWorker.id);
      await until(() => store.getRun(secondWorker.id)?.status === 'waiting');
      const secondCaller = credentials.authenticate(credentials.issue('project', secondWorker.id, randomUUID()))!;
      const first = randomUUID(); const second = randomUUID();
      await f.service.send(f.parentCaller, { id: first, recipientRunId: f.w.id, kind: 'request', text: 'First check mock:hold', timeoutSeconds: 600 });
      await f.service.send(f.parentCaller, { id: second, recipientRunId: secondWorker.id, kind: 'request', text: 'Second check mock:hold', timeoutSeconds: 600 });
      const wait = manager.registerRequestWait(f.p.id, { requestIds: [first, second], mode: 'all', timeoutSeconds: 600 });
      await until(() => waitOf(store.getRun(f.p.id))?.phase === 'parked');
      await f.service.send(f.workerCaller, { id: randomUUID(), recipientRunId: f.p.id, kind: 'reply', requestId: first, text: 'First result mock:hold', timeoutSeconds: 600 });
      expect(waitOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, phase: 'parked', requestOutcomes: [expect.objectContaining({ requestId: first, status: 'replied' })] });
      await f.service.send(secondCaller, { id: randomUUID(), recipientRunId: f.p.id, kind: 'reply', requestId: second, text: 'Second result mock:hold', timeoutSeconds: 600 });
      await until(() => !waitOf(store.getRun(f.p.id)));
      const metadata = store.getRun(f.p.id)?.delegation;
      expect(metadata?.role === 'root' && metadata.lastWait).toMatchObject({ id: wait.id, reason: 'outcome', requestOutcomes: [expect.objectContaining({ requestId: first }), expect.objectContaining({ requestId: second })] });
      expect(store.getRun(f.p.id)?.agentInputs?.filter(input => input.id === wait.id && input.deliveredAt)).toHaveLength(1);
    } finally { credentials.close(); f.close(); }
  });

  it('conversation: a full queue of 32 replies can admit an all-request wake without losing a message', async () => {
    const f = await conversationPair();
    const engine = manager as unknown as { pump(): Promise<void> };
    const pump = vi.spyOn(engine, 'pump').mockResolvedValue();
    const submissions = vi.spyOn(manager as unknown as { submitAgentInput(runId: string, state: unknown, content: Array<{ type: string; text: string }>, id: string): boolean }, 'submitAgentInput');
    try {
      const requestIds = Array.from({ length: 32 }, () => randomUUID());
      for (const id of requestIds) await f.service.send(f.parentCaller, { id, recipientRunId: f.w.id, kind: 'request', text: 'Batch question mock:hold', timeoutSeconds: 600 });
      const wait = manager.registerRequestWait(f.p.id, { requestIds, mode: 'all', timeoutSeconds: 600 });
      const replyIds: string[] = [];
      for (const requestId of requestIds) {
        const id = randomUUID(); replyIds.push(id);
        await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'reply', requestId, text: 'Batch answer mock:hold', timeoutSeconds: 600 });
      }
      const queued = store.getRun(f.p.id)?.agentInputs ?? [];
      expect(queued.filter(input => !input.deliveredAt)).toHaveLength(32);
      expect(queued.map(input => input.id)).toEqual(replyIds);
      expect(waitOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, phase: 'wake-pending', reason: 'outcome', wakeId: replyIds.at(-1) });
      expect(queued.at(-1)?.text).toBe('Batch answer mock:hold');
      pump.mockRestore();
      await engine.pump();
      await vi.waitFor(() => {
        expect(store.getRun(f.p.id)?.agentInputs?.filter(input => input.deliveredAt).map(input => input.id)).toEqual(replyIds);
        expect(waitOf(store.getRun(f.p.id))).toBeUndefined();
      }, { timeout: 60_000, interval: 20 });
      expect(store.getRun(f.p.id)?.delegation).toMatchObject({ lastWait: { id: wait.id, reason: 'outcome', requestOutcomes: expect.arrayContaining(requestIds.map(requestId => expect.objectContaining({ requestId, status: 'replied' }))) } });
      const delivered = submissions.mock.calls.filter((call, index) => call[0] === f.p.id && submissions.mock.results[index]?.value === true);
      expect(delivered.map(call => call[3])).toEqual(replyIds);
      expect(delivered.at(-1)?.[2][0]?.text).toContain(`Wait ${wait.id} (outcome); request outcomes:`);
      expect(delivered.at(-1)?.[2][0]?.text).toContain('Batch answer mock:hold');
    } finally { pump.mockRestore(); submissions.mockRestore(); f.close(); }
  }, 90_000);

  it('conversation: a monitoring recipient queues its message until scheduler capacity is available', async () => {
    const f = await conversationPair();
    const gate = join(root, 'conversation-monitor-gate');
    try {
      expect(manager.sendMessage(f.p.id, [{ type: 'text', text: 'mock:monitoring' }])).toBe(true);
      await until(() => store.getRun(f.p.id)?.activity === 'monitoring');
      // A real in-flight turn occupies the sole slot until this gate opens.
      controlledWire({ firstResultGate: gate });
      const busy = await worker(f.p.id);
      manager.enqueueOwnedRun(busy.id);
      await until(() => store.getRun(busy.id)?.status === 'running' && semaphore.busy() === 1);
      const id = randomUUID();
      await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'progress', text: 'Progress while monitoring mock:hold', timeoutSeconds: 600 });
      expect(semaphore.busy()).toBe(1);
      expect(store.getRun(f.p.id)?.agentInputs?.find(input => input.id === id)?.deliveredAt).toBeUndefined();
      expect(waitOf(store.getRun(f.p.id))).toMatchObject({ reason: 'message', phase: 'wake-pending', wakeId: id });
      writeFileSync(gate, 'release');
      await until(() => !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === id)?.deliveredAt);
    } finally { writeFileSync(gate, 'release'); f.close(); }
  });

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

  // Legacy lifecycle fixtures publish settled workers without launching a process.
  // Supply the private completion boundary too; status alone is intentionally insufficient.
  function fixtureUpdateRun(id: string, patch: Parameters<RunStore['updateRun']>[1]) {
    const run = store.getRun(id);
    const generation = run?.delegation?.role === 'worker' && patch.status && terminal.includes(patch.status)
      ? store.commitWorkerExecutionStart(id) : undefined;
    store.updateRun(id, patch);
    if (generation) expect(store.commitWorkerExecutionComplete(id, generation)).toBe(true);
  }
  async function collect(id: string) {
    const run = store.getRun(id)!;
    const evidence = await collectWorkerEvidence(root, store, run);
    return store.commitWorkerResult(run.delegation?.role === 'worker' ? run.delegation.parentRunId : '', evidence.result, evidence.diffSnapshot);
  }
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
          failureState = captureState();
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

  async function queuedWake() {
    const p = await parent(); const w = await worker(p.id, 'mock:slow');
    const wait = register(p.id, [w.id]); checkpoint('queued-wake-registered');
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    const delegation = store.getRun(p.id)!.delegation!;
    if (delegation.role !== 'root') throw Error('fixture');
    store.commitDelegation([{ id: p.id, delegation: { ...delegation, wait: { ...wait, deadline: new Date().toISOString() } } }]);
    await restart(); checkpoint('queued-wake-restarted');
    await until(() => (manager as unknown as { active: Map<string, { sessionEverOpened?: boolean }> }).active.get(w.id)?.sessionEverOpened === true); checkpoint('queued-wake-child-open');
    expect(store.getRun(p.id)?.status).toBe('queued');
    return { p, w, wait };
  }

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

  it('a deadline write failure is contained and retried without losing intent or capacity', async () => {
    // This fault exercises only deadline persistence, never an unrelated live turn.
    const release = join(root, 'release-deadline-turn'); const wire = controlledWire({ firstResultGate: release });
    const p = await parent(); await until(wire.initialReceived); const w = await worker(p.id);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const wait = register(p.id, [w.id], 1); // registered: still counts as an executing turn
    const busy = semaphore.busy(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.flush(); const diskPath = join(root, '.ai/cezar/runs.json'); const disk = readFileSync(diskPath, 'utf8');
    const tmpPath = `${diskPath}.tmp`; mkdirSync(tmpPath);
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(waitOf(store.getRun(p.id))?.phase).toBe('registered');
      expect(readFileSync(diskPath, 'utf8')).toBe(disk);
      expect(store.getRun(p.id)?.agentInputs ?? []).toEqual([]);
      expect(semaphore.busy()).toBe(busy);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { rmSync(tmpPath, { recursive: true }); }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(waitOf(store.getRun(p.id))).toMatchObject({ id: wait.id, phase: 'wake-pending' });
    expect(store.getRun(p.id)?.agentInputs?.[0]).toMatchObject({ id: wait.id });
    expect(store.getRun(p.id)?.agentInputs?.[0]?.deliveredAt).toBeUndefined();
    expect(semaphore.busy()).toBe(busy); warn.mockRestore();
  });

  it('queued human withdrawal preserves admission, FIFO and attachments without answering an ask on acceptance', async () => {
    const { p, w } = await queuedWake();
    // Earlier human amendments and a current ask must not disappear when the
    // lifecycle opening is superseded. Acceptance alone is not answer delivery.
    store.updateRun(p.id, { queuedMessages: [{ id: randomUUID(), text: 'earlier human update', createdAt: new Date().toISOString() }] });
    store.appendEvent(p.id, { type: 'ask.requested', requestId: randomUUID(), questions: [{
      header: 'Choice', question: 'Which option?', options: [{ label: 'One' }, { label: 'Two' }],
    }] });
    const queued = manager.enqueueMessage(p.id, [{ type: 'text', text: 'new human update' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } },
      { type: 'file', mediaType: 'application/pdf', data: 'Yg==' }]);
    expect(queued?.images).toHaveLength(2);
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(store.getRun(p.id)?.agentInputs).toEqual([]);
    expect(store.getRun(p.id)?.continuationMessage?.origin).toBe('human');
    expect(store.getRun(p.id)?.status).toBe('queued'); expect(semaphore.busy()).toBe(1);
    expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
    store.flush();
    const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(p.id)?.continuationMessage?.origin).toBe('human'); reopened.flush();
    manager.cancel(w.id);
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const opening = store.readEvents(p.id).find(event => event.type === 'user-message');
    expect(String(opening?.text).match(/new human update/g)).toHaveLength(1);
    expect(String(opening?.text).indexOf('earlier human update')).toBeLessThan(String(opening?.text).indexOf('new human update'));
    expect(opening?.images).toEqual(queued?.images);
    expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toHaveLength(1);
  });

  it('a failed queued human withdrawal publishes no wait, wake, message or admission changes', async () => {
    const { p } = await queuedWake(); store.flush();
    const snapshot = JSON.stringify(store.getRun(p.id));
    const diskPath = join(root, '.ai/cezar/runs.json'); const disk = readFileSync(diskPath, 'utf8');
    rmSync(diskPath); mkdirSync(diskPath);
    try {
      expect(() => manager.enqueueMessage(p.id, [{ type: 'text', text: 'must not be accepted' }])).toThrow();
      expect(JSON.stringify(store.getRun(p.id))).toBe(snapshot);
      expect(semaphore.busy()).toBe(1);
    } finally { rmSync(diskPath, { recursive: true }); writeFileSync(diskPath, disk); }
  });

  for (const crash of ['before-delivery', 'after-delivery', 'checkpoint-failure'] as const) {
    it(`startup human withdrawal ${crash}: ${crash === 'checkpoint-failure' ? 'stops delivery and preserves the replay ID' : 'survives restart without double folding or lost input'}`, async () => {
      const { p, w } = await queuedWake();
      const engine = manager as unknown as { agentEnvForStep(id: string, ...args: unknown[]): Promise<unknown> };
      const real = engine.agentEnvForStep.bind(manager);
      let release!: () => void; let entered = false;
      const gate = new Promise<void>(resolve => { release = resolve; });
      engine.agentEnvForStep = async (id, ...args) => {
        if (id === p.id) { entered = true; await gate; }
        return real(id, ...args);
      };
      manager.cancel(w.id); await until(() => entered);
      let checkpoint: string;
      try {
        expect(manager.deferMessage(p.id, [{ type: 'text', text: 'startup human update' },
          { type: 'file', mediaType: 'application/pdf', data: 'YQ==' }])).toBe(true);
        expect(waitOf(store.getRun(p.id))).toBeUndefined();
        expect(store.getRun(p.id)?.queuedMessages?.at(-1)?.text).toBe('startup human update');
        store.flush(); checkpoint = readFileSync(join(root, '.ai/cezar/runs.json'), 'utf8');
        if (crash === 'checkpoint-failure') {
          const commit = store.commitQueuedMessageDelivery.bind(store);
          store.commitQueuedMessageDelivery = (...args) => {
            const tmpPath = join(root, '.ai/cezar/runs.json.tmp'); mkdirSync(tmpPath);
            try { commit(...args); } finally { rmSync(tmpPath, { recursive: true }); }
          };
        }
      } finally { release(); }
      await until(() => store.readEvents(p.id).some(event => event.type === 'user-message' && String(event.text).includes('startup human update')));
      if (crash === 'checkpoint-failure') {
        await until(() => store.getRun(p.id)?.status === 'failed');
        expect(store.getRun(p.id)?.error).toContain('human input delivery checkpoint failed');
        expect(store.getRun(p.id)?.queuedMessages?.at(-1)?.text).toBe('startup human update');
        expect(store.readEvents(p.id).filter(event => event.type === 'user-message' && String(event.text).includes('startup human update'))).toHaveLength(1);
        return;
      }
      if (crash === 'after-delivery') {
        expect(store.getRun(p.id)?.queuedMessages?.some(message => message.text === 'startup human update')).not.toBe(true);
        store.flush(); checkpoint = readFileSync(join(root, '.ai/cezar/runs.json'), 'utf8');
      }
      const eventStart = store.readEvents(p.id).length;
      await restart(false, checkpoint!);
      await until(() => store.getRun(p.id)?.status === 'waiting');
      const afterRestart = store.readEvents(p.id).slice(eventStart).filter(event => event.type === 'user-message');
      const mentions = afterRestart.flatMap(event => String(event.text).match(/startup human update/g) ?? []);
      expect(mentions).toHaveLength(crash === 'before-delivery' ? 1 : 0);
      if (crash === 'before-delivery') expect(afterRestart.find(event => String(event.text).includes('startup human update'))?.images).toHaveLength(1);
      expect(waitOf(store.getRun(p.id))).toBeUndefined();
    });
  }

  it('releases only on yield and admits a live wake behind already queued work', async () => {
    const p = await parent(); const w = await worker(p.id);
    register(p.id, [w.id]); manager.enqueueOwnedRun(w.id);
    expect(store.getRun(w.id)?.status).toBe('queued'); expect(semaphore.busy()).toBe(1);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    await until(() => store.getRun(w.id)?.status === 'running');
    expect(semaphore.busy()).toBe(1); // only child, not parked parent
    const blocker = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:slow', runner: 'claude' });
    await until(() => store.getRun(w.id)?.status === 'waiting');
    await until(() => store.getRun(blocker.id)?.status === 'running');
    manager.finish(w.id);
    await until(() => terminal.includes(store.getRun(w.id)?.status ?? ''));
    const wake = waitOf(store.getRun(p.id)); expect(wake?.phase).toBe('wake-pending');
    expect(store.getRun(p.id)?.agentInputs?.some(i => i.deliveredAt)).not.toBe(true);
    manager.reconcileWorkerWaits(); manager.queueWorkerWake(p.id); manager.queueWorkerWake(p.id);
    manager.cancel(blocker.id);
    await until(() => !waitOf(store.getRun(p.id)));
    expect(store.getRun(p.id)?.agentInputs).toHaveLength(1);
    expect(store.getRun(p.id)?.agentInputs?.[0]).toMatchObject({ id: wake?.wakeId, source: 'lifecycle', parentRunId: p.id, deliveredAt: expect.any(String) });
    expect(store.readEvents(p.id).filter(e => e.type === 'user-message')).toEqual([]);
  });

  for (const status of ['review', 'done', 'failed', 'cancelled'] as const) {
    it(`observes ${status} before registration, includes all selected statuses and wakes once`, async () => {
      const p = await parent(); const a = await worker(p.id); const b = await worker(p.id);
      fixtureUpdateRun(a.id, { status });
      const wait = register(p.id, [a.id, b.id]);
      expect(wait.phase).toBe('wake-pending'); expect(wait.outcomes[0]?.status).toBe(status);
      await until(() => !waitOf(store.getRun(p.id)));
      const inputs = store.getRun(p.id)?.agentInputs;
      expect(inputs).toHaveLength(1);
      expect(inputs?.[0]?.text).toContain(a.id); expect(inputs?.[0]?.text).toContain(status);
      expect(inputs?.[0]?.text).toContain(b.id); expect(inputs?.[0]?.text).toContain('queued');
      expect(store.readEvents(p.id).filter(e => e.type === 'worker-outcome')).toHaveLength(1);
    });
  }
  it('delivers all 32 terminal outcomes within the input bound without dropping durable summaries', async () => {
    const p = await parent(); checkpoint('32-parent-open'); const ids: string[] = [];
    for (let i = 0; i < 32; i++) {
      const w = await worker(p.id); ids.push(w.id); checkpoint(`32-created-${i + 1}`);
      fixtureUpdateRun(w.id, { status: 'failed', error: '\u0000'.repeat(4_000) });
    }
    checkpoint('32-before-register'); const wait = register(p.id, ids); checkpoint('32-registered');
    expect(wait.outcomes).toHaveLength(32);
    expect(wait.outcomes.every(outcome => outcome.summary?.length === 4_000)).toBe(true);
    await until(() => !waitOf(store.getRun(p.id)));
    const input = store.getRun(p.id)?.agentInputs?.[0];
    expect(input?.text.length).toBeLessThanOrEqual(100_000);
    for (const id of ids) expect(input?.text).toContain(id);
    expect(store.readEvents(p.id).filter(event => event.type === 'worker-outcome')).toHaveLength(32);
  });

  it('observes completion between registration and park and reports every selected status', async () => {
    // Hold the real wire's first result until every real Git fixture exists.
    // A fixed playback delay cannot establish this ordering on a loaded host.
    const release = join(root, 'release-first-turn'); const wire = controlledWire({ firstResultGate: release });
    const p = await parent(); await until(wire.initialReceived);
    const statuses = ['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled'] as const;
    const children = [];
    for (const status of statuses) children.push({ run: await worker(p.id), status });
    const wait = register(p.id, children.map(child => child.run.id));
    expect(wait.phase).toBe('registered');
    for (const child of children) fixtureUpdateRun(child.run.id, { status: child.status });
    writeFileSync(release, 'release');
    await until(() => !waitOf(store.getRun(p.id)));
    const input = store.getRun(p.id)?.agentInputs?.[0];
    for (const child of children) expect(input?.text).toContain(JSON.stringify({ workerId: child.run.id, status: child.status }));
    expect(input?.id).toBe(wait.id);
    expect(store.readEvents(p.id).filter(event => event.type === 'worker-outcome')).toHaveLength(4);
  });

  for (const mode of ['fresh', 'continuation'] as const) {
    for (const marker of ['mock:done', 'mock:monitoring', 'mock:ask'] as const) {
      it(`${mode}: worker wait precedes ${marker} except that a human ask wins`, async () => {
        const p = await parent(mode === 'fresh' ? marker : 'mock:hold');
        if (mode === 'continuation') {
          await until(() => store.getRun(p.id)?.status === 'waiting');
          manager.finish(p.id); await until(() => !manager.isActive(p.id));
          store.updateRun(p.id, { autonomous: true });
          expect(manager.continueRun(p.id, { text: marker }).ok).toBe(true);
          await until(() => (manager as unknown as { active: Map<string, { sessionEverOpened?: boolean }> }).active.get(p.id)?.sessionEverOpened === true);
        }
        const w = await worker(p.id); const wait = register(p.id, [w.id]);
        if (marker === 'mock:ask') {
          await until(() => store.readEvents(p.id).some(event => event.type === 'ask.requested'));
          expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id);
          expect(store.getRun(p.id)?.agentInputs?.some(input => input.deliveredAt)).not.toBe(true);
        } else {
          await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
          expect(store.getRun(p.id)?.activity).toBeUndefined();
          expect(store.getRun(p.id)?.status).toBe('waiting');
          expect(semaphore.busy()).toBe(0);
          expect(store.readEvents(p.id).some(event => event.type === 'note' && String(event.message).includes('autonomous — continuing'))).toBe(false);
        }
      });
    }
  }

  it('a parent timeout leaves a waiting child human question unanswered', async () => {
    const p = await parent(); const w = await worker(p.id, 'mock:ask');
    const wait = register(p.id, [w.id]); manager.enqueueOwnedRun(w.id);
    await until(() => store.readEvents(w.id).some(event => event.type === 'ask.requested'));
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(wait.deadline);
    manager.reconcileWorkerWaits(); vi.useRealTimers();
    await until(() => !waitOf(store.getRun(p.id)));
    expect(store.getRun(w.id)?.status).toBe('waiting');
    expect(store.readEvents(w.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
    expect(store.getRun(p.id)?.agentInputs?.[0]?.text).toContain('waiting');
  });

  it('rejects duplicate sets, excessive deadlines, foreign workers, outstanding waits and pending asks', async () => {
    const p = await parent(); const w = await worker(p.id);
    expect(() => register(p.id, [w.id, w.id])).toThrow();
    expect(() => register(p.id, [w.id], 1801)).toThrow();
    expect(() => register(p.id, [randomUUID()])).toThrow();
    const wait = manager.registerWorkerWait(p.id, { workerIds: [w.id] } as never);
    expect(Date.parse(wait.deadline) - Date.now()).toBeGreaterThan(599_000);
    expect(() => register(p.id, [w.id])).toThrow();
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    manager.sendMessage(p.id, [{ type: 'text', text: 'mock:ask' }]);
    await until(() => store.readEvents(p.id).some(e => e.type === 'ask.requested'));
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(() => register(p.id, [w.id])).toThrow();
  });
  it('expires a registered executing parent without freeing its slot or cancelling workers', async () => {
    const p = await parent('mock:slow'); const w = await worker(p.id);
    const wait = register(p.id, [w.id], 1);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(wait.deadline); manager.reconcileWorkerWaits();
    expect(waitOf(store.getRun(p.id))?.phase).toBe('wake-pending');
    expect(semaphore.busy()).toBe(1); expect(store.getRun(w.id)?.status).toBe('queued');
    expect(store.getRun(p.id)?.agentInputs?.some(i => i.deliveredAt)).not.toBe(true);
  });
  it('rebuilds a parked deadline on restart, expires without cancelling the queued child', async () => {
    const p = await parent(); checkpoint('deadline-parent-open'); const w = await worker(p.id); checkpoint('deadline-worker-created');
    const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    checkpoint('deadline-before-restart'); await restart(true); checkpoint('deadline-recovered');
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id);
    await vi.advanceTimersByTimeAsync(600_000); checkpoint('deadline-timer-fired');
    expect(waitOf(store.getRun(p.id))?.phase).toBe('wake-pending');
    vi.useRealTimers();
    await until(() => !waitOf(store.getRun(p.id)));
    expect(store.getRun(w.id)?.status).not.toBe('cancelled');
    expect(store.getRun(p.id)?.agentInputs?.[0]?.id).toBe(wait.id);
    expect(store.readEvents(p.id).filter(e => e.type === 'user-message')).toEqual([]);
  });
  for (const phase of ['registered', 'parked', 'wake-pending'] as const) {
    it(`restart reconciles ${phase} before generic waiting settlement and deduplicates recovery`, async () => {
      const p = await parent(); const w = await worker(p.id);
      await until(() => store.getRun(p.id)?.status === 'waiting');
      const wait: WorkerWait = { id: randomUUID(), workerIds: [w.id], phase, deadline: new Date().toISOString(), outcomes: [] };
      const delegation = store.getRun(p.id)!.delegation!;
      if (delegation.role !== 'root') throw Error('fixture');
      store.commitDelegation([{ id: p.id, delegation: { ...delegation, wait } }]);
      await restart(); await manager.recover();
      await until(() => !waitOf(store.getRun(p.id)));
      expect(store.getRun(p.id)?.agentInputs?.filter(i => i.id === wait.id)).toHaveLength(1);
      expect(store.getRun(p.id)?.steps.filter(s => s.id.startsWith('continue-'))).toHaveLength(1);
      expect(store.readEvents(p.id).filter(e => e.type === 'user-message')).toEqual([]);
      // The continued handler must also park before DONE/monitoring behavior.
      const again = register(p.id, [w.id]);
      await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
      expect(again.id).not.toBe(wait.id);
    });
  }
  it('retiring a delivered wait durably records the resumed status in the same snapshot', async () => {
    const p = await parent(); const w = await worker(p.id);
    fixtureUpdateRun(w.id, { status: 'done' });
    const commit = store.commitWorkerWaitWithdrawal.bind(store);
    let retiredStatus: string | undefined;
    store.commitWorkerWaitWithdrawal = (...args) => {
      commit(...args);
      if (args[0] === p.id) {
        const records = JSON.parse(readFileSync(join(root, '.ai/cezar/runs.json'), 'utf8')) as RunRecord[];
        retiredStatus = records.find(run => run.id === p.id)?.status;
      }
    };
    register(p.id, [w.id]);
    await until(() => retiredStatus !== undefined);
    expect(retiredStatus).toBe('running');
  });

  it('restart after the delivery checkpoint resumes the parent instead of settling the parked snapshot', async () => {
    const p = await parent(); const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    const delegation = store.getRun(p.id)!.delegation!;
    if (delegation.role !== 'root') throw Error('fixture');
    // Exact crash window: backend accepted, input receipt committed, but wait
    // retirement and resumeParkedRun's status update have not happened yet.
    store.commitDelegation([{ id: p.id, delegation: { ...delegation, wait: { ...wait, phase: 'wake-pending', wakeId: wait.id } } }]);
    store.commitAgentInputs(p.id, [{ id: wait.id, parentRunId: p.id, source: 'lifecycle',
      text: 'Worker deadline reached', createdAt: new Date().toISOString(), deliveredAt: new Date().toISOString() }]);
    await restart();
    await until(() => store.getRun(p.id)?.steps.some(step => step.id === 'continue-1') === true || terminal.includes(store.getRun(p.id)?.status ?? ''));
    expect(store.getRun(p.id)?.steps.some(step => step.id === 'continue-1')).toBe(true);
    expect(store.getRun(w.id)?.status).not.toBe('cancelled');
    expect(store.getRun(p.id)?.agentInputs).toHaveLength(1);
    expect(store.getRun(p.id)?.agentInputs?.[0]?.deliveredAt).toBeDefined();
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(store.readEvents(p.id).filter(event => event.type === 'user-message')).toEqual([]);
  });

  it('preserves a delegated parent ask across restart and never uses a lifecycle prompt as its answer', async () => {
    const p = await parent('mock:ask'); const w = await worker(p.id);
    await until(() => store.readEvents(p.id).some(e => e.type === 'ask.requested'));
    const delegation = store.getRun(p.id)!.delegation!;
    if (delegation.role !== 'root') throw Error('fixture');
    const wait: WorkerWait = { id: randomUUID(), workerIds: [w.id], phase: 'parked', deadline: new Date().toISOString(), outcomes: [] };
    store.commitDelegation([{ id: p.id, delegation: { ...delegation, wait } }]);
    await restart(); await manager.recover();
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(manager.isActive(p.id)).toBe(false);
    expect(manager.continueRun(p.id).ok).toBe(false);
    expect(store.readEvents(p.id).filter(e => e.type === 'human-input-delivered')).toEqual([]);
    expect(manager.continueRun(p.id, { text: 'Vitest' }).ok).toBe(true);
    await until(() => store.getRun(p.id)?.status === 'waiting');
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(store.readEvents(p.id).filter(e => e.type === 'human-input-delivered')).toHaveLength(1);
  });
  for (const status of ['done', 'failed', 'cancelled'] as const) {
    it(`parent ${status} clears wait and cancels unfinished children, preserving terminal artifacts`, async () => {
      const p = await parent(); const w = await worker(p.id); const done = await worker(p.id);
      fixtureUpdateRun(done.id, { status: 'review' }); register(p.id, [w.id]);
      store.updateRun(p.id, { status });
      await until(() => store.getRun(w.id)?.status === 'cancelled');
      expect(waitOf(store.getRun(p.id))).toBeUndefined(); expect(store.getRun(done.id)?.status).toBe('review');
      expect(store.getRun(w.id)?.delegation?.role).toBe('worker');
    });
  }
  it('persists lifecycle continuation origin through a queued restart', async () => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    manager.finish(p.id); await until(() => !manager.isActive(p.id));
    const blocker = await parent('mock:slow');
    expect(manager.continueRun(p.id, { text: 'internal restart' }, true).ok).toBe(true);
    expect(store.getRun(p.id)?.continuationMessage).toMatchObject({ origin: 'lifecycle' });
    store.flush();
    const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(p.id)?.continuationMessage).toMatchObject({ origin: 'lifecycle' });
    reopened.flush();
    manager.cancel(blocker.id);
    await until(() => store.getRun(p.id)?.status === 'waiting');
    expect(store.readEvents(p.id).filter(e => e.type === 'user-message')).toEqual([]);
  });
  it('backend activity restores an executing parent slot without withdrawing its durable wait', async () => {
    const p = await parent(); const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    const engine = manager as unknown as {
      active: Map<string, unknown>;
      makeUiSink(runId: string, stepId: string): unknown;
      handleRunnerUiEvent(runId: string, state: unknown, sink: unknown, event: unknown): void;
    };
    engine.handleRunnerUiEvent(p.id, engine.active.get(p.id), engine.makeUiSink(p.id, 'task'), {
      type: 'turn.started', turnId: randomUUID(),
    });
    expect(store.getRun(p.id)?.status).toBe('running');
    expect(semaphore.busy()).toBe(1);
    expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id);
  });

  it('does not release capacity before the parked intent reaches disk', async () => {
    const p = await parent('mock:slow'); const w = await worker(p.id);
    register(p.id, [w.id]); store.flush();
    const diskPath = join(root, '.ai/cezar/runs.json');
    const disk = readFileSync(diskPath, 'utf8');
    rmSync(diskPath); mkdirSync(diskPath);
    const engine = manager as unknown as { active: Map<string, unknown>; parkWorkerWait(id: string, state: unknown): boolean };
    try {
      expect(() => engine.parkWorkerWait(p.id, engine.active.get(p.id))).toThrow();
      expect(waitOf(store.getRun(p.id))?.phase).toBe('registered');
      expect(semaphore.busy()).toBe(1);
    } finally {
      rmSync(diskPath, { recursive: true }); writeFileSync(diskPath, disk);
    }
  });

  it('recovery admits an older queued child before an expired parent wake', async () => {
    const p = await parent(); const w = await worker(p.id, 'mock:slow');
    register(p.id, [w.id], 1);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    const delegation = store.getRun(p.id)!.delegation!;
    if (delegation.role !== 'root' || !delegation.wait) throw Error('fixture');
    store.commitDelegation([{ id: p.id, delegation: { ...delegation, wait: { ...delegation.wait, deadline: new Date().toISOString() } } }]);
    await restart();
    await until(() => store.getRun(w.id)?.status === 'running' || store.getRun(p.id)?.status === 'running');
    expect(store.getRun(w.id)?.status).toBe('running');
    expect(store.getRun(p.id)?.status).toBe('queued');
    expect(store.getRun(p.id)?.agentInputs?.some(input => input.deliveredAt)).not.toBe(true);
  });

  for (const mode of ['fresh', 'continuation'] as const) {
    for (const completion of ['result', 'error'] as const) {
      it(`${mode}: disposal ignores late ${completion} and restart retains the wait and children`, async () => {
        const p = await parent();
        if (mode === 'continuation') {
          await until(() => store.getRun(p.id)?.status === 'waiting');
          manager.finish(p.id); await until(() => !manager.isActive(p.id));
          expect(manager.continueRun(p.id, { text: 'mock:hold' }).ok).toBe(true);
          await until(() => store.getRun(p.id)?.status === 'waiting');
        }
        const w = await worker(p.id); const wait = register(p.id, [w.id]);
        await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
        await Promise.all(bookkeeping.splice(0));
        const state = (manager as unknown as { active: Map<string, { session: { end(): void; sendMessage(content: unknown[]): boolean } }> }).active.get(p.id)!;
        await until(() => currentUsage(p.id) !== undefined);
        manager.dispose();
        const snapshot = JSON.stringify(store.getRun(p.id));
        await manager.recordTurnEnd(p.id, 'CEZ:TITLE=late disposed callback');
        if (completion === 'error') state.session.sendMessage([{ type: 'text', text: 'mock:auth-error' }]);
        else state.session.end();
        await Promise.all(executions.splice(0));
        expect(store.getRun(p.id)?.status).toBe('waiting');
        expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id);
        expect(JSON.stringify(store.getRun(p.id))).toBe(snapshot);
        expect(currentUsage(p.id)).toBeUndefined();
        store.flush();
        store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
        manager = new RunManager(store, root, { semaphore }); track();
        await manager.recover();
        expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id);
        expect(store.getRun(w.id)?.status).not.toBe('cancelled');
      });
    }
  }

  for (const intent of ['cancel'] as const) {
    it(`explicit ${intent} before disposal is not resurrected on restart`, async () => {
      const p = await parent(); const w = await worker(p.id);
      register(p.id, [w.id]); await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
      manager[intent](p.id); manager.dispose();
      await Promise.all(executions.splice(0));
      expect(store.getRun(p.id)?.status).toBe(intent === 'cancel' ? 'cancelled' : 'done');
      await Promise.all(bookkeeping.splice(0));
      store.flush();
      store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
      manager = new RunManager(store, root, { semaphore }); track();
      await manager.recover();
      expect(store.getRun(w.id)?.status).toBe('cancelled');
      expect(waitOf(store.getRun(p.id))).toBeUndefined();
    });
  }

  it('controller disposal does not cascade or clear durable waits', async () => {
    const p = await parent(); const w = await worker(p.id); const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    // Stop fixture processes only AFTER disposal; disposal itself must not mutate records.
    const active = (manager as unknown as { active: Map<string, { session?: { interrupt(): void } }> }).active;
    const sessions = [...active.values()].map(s => s.session);
    manager.dispose();
    expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id); expect(store.getRun(w.id)?.status).toBe('queued');
    for (const session of sessions) session?.interrupt();
    await Promise.all(executions.splice(0));
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(store.getRun(w.id)?.status).toBe('queued');
  });
});
