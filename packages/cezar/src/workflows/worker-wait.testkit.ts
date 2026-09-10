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

export const terminal = ['review', 'done', 'failed', 'cancelled'];
export async function until(predicate: () => boolean) { await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 15_000, interval: 10 }); }
export const waitOf = (run: RunRecord | undefined) => run?.delegation && run.delegation.role !== 'invalid' ? run.delegation.wait : undefined;

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.

export let root: string;
export let store: RunStore;
export let manager: RunManager;
export let semaphore: WorkspaceSemaphore;
let saved: NodeJS.ProcessEnv;
let phase = 'setup';
let checkpoints: Array<{ phase: string; ms: number }> = [];
let began = 0;
let failureState: unknown;
export function checkpoint(value: string) { phase = value; checkpoints.push({ phase, ms: Math.round(performance.now() - began) }); }
export function captureState() { return { root, phase, checkpoints: checkpoints.map(entry => ({ ...entry })), elapsedMs: Math.round(performance.now() - began), busy: semaphore?.busy(),
  runs: store?.listRuns().map(run => ({ id: run.id, status: run.status, error: run.error, step: run.currentStepId, wait: waitOf(run)?.phase,
    events: store.readEvents(run.id).slice(-6).map(event => ({ type: event.type, seq: event.seq, ...('message' in event ? { message: String(event.message).slice(0, 256) } : {}) })) })),
}; }
export const bookkeeping: Promise<unknown>[] = [];
export const executions: Promise<unknown>[] = [];
export function track() {
  const engine = manager as unknown as Record<'execute' | 'runContinuation', (...args: unknown[]) => Promise<unknown>>;
  for (const name of ['execute', 'runContinuation'] as const) {
    const real = engine[name].bind(manager);
    engine[name] = (...args) => { const result = real(...args); executions.push(result); return result; };
  }
  const internals = manager as unknown as { recordTurnEnd(...args: unknown[]): Promise<unknown> };
  const real = internals.recordTurnEnd.bind(manager);
  internals.recordTurnEnd = (...args) => { const result = real(...args); bookkeeping.push(result); return result; };
}
export function useWorkerWaitFixture(): void {
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
}
export function controlledWire(options: { firstResultGate?: string; humanAnswerGate?: string } = {}) {
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

export async function parent(task = 'mock:hold') {
  checkpoint('parent-start');
  const run = manager.startRun(QUICK_TASK_WORKFLOW, { task, runner: 'claude' });
  store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
  await until(() => (manager as unknown as { active: Map<string, { sessionEverOpened?: boolean }> }).active.get(run.id)?.sessionEverOpened === true);
  checkpoint('parent-session-open'); return run;
}
export async function worker(parentId: string, task = 'mock:hold') {
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
export function register(parentId: string, ids: string[], seconds = 600) {
  return manager.registerWorkerWait(parentId, workerWaitRequestSchema.parse({ workerIds: ids, timeoutSeconds: seconds }));
}
export async function restart(fakeClock = false, diskCheckpoint?: string) {
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

// Legacy lifecycle fixtures publish settled workers without launching a process.
// Supply the private completion boundary too; status alone is intentionally insufficient.
export function fixtureUpdateRun(id: string, patch: Parameters<RunStore['updateRun']>[1]) {
  const run = store.getRun(id);
  const generation = run?.delegation?.role === 'worker' && patch.status && terminal.includes(patch.status)
    ? store.commitWorkerExecutionStart(id) : undefined;
  store.updateRun(id, patch);
  if (generation) expect(store.commitWorkerExecutionComplete(id, generation)).toBe(true);
}
export async function collect(id: string) {
  const run = store.getRun(id)!;
  const evidence = await collectWorkerEvidence(root, store, run);
  return store.commitWorkerResult(run.delegation?.role === 'worker' ? run.delegation.parentRunId : '', evidence.result, evidence.diffSnapshot);
}
export async function queuedWake() {
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

export function setFailureState(value: unknown) { failureState = value; }
export function reopenRuntime() {
  store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
  manager = new RunManager(store, root, { semaphore });
  track();
}
