/**
 * The delegation fixture the worker-wait suites share: a real `RunManager` over a scratch Git repo
 * and native mocks (`useWorkerWaitFixture`), with builders for parents, workers, waits and restarts.
 * Pass `timeline(runId, afterSeq)` as the message of an assertion on a run's turns or events, to
 * `expect` or as `until`'s second argument: a failure then lists every event with its turn, step and
 * text, which is how a no-wait nudge's extra turn shows up (hearsay-tools/cezarion#1292).
 */
import { scopeFixtureProcesses } from '../delegation/process-scope.testkit.ts';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { workerWaitRequestSchema, type WorkerWait } from '@open-mercato/cezar-contract/delegation';
import { hasWorkerDeadline, workerWaitEntryToLegacy, workerWaitView, type DeadlinedWorkerWaitEntry, type WorkerWaitEntry } from '@open-mercato/cezar-contract/waits';
import { RunStore, type RunEvent, type RunRecord } from '../runs/store.ts';
import { RunStoreOpenError } from '../runs/store-open-error.ts';
import * as runnerFactory from '../core/runner-factory.ts';
import { collectWorkerEvidence } from '../delegation/results.ts';
import { planOwnedWorkspace } from '../delegation/workspace.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { MAX_AUTO_CONTINUES, RunManager } from './run.ts';
import { currentUsage } from '../core/process-usage.ts';
import type { AgentSession, RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { readPersistedRuns, seedRuns } from '../runs/run-store.testkit.ts';

export const terminal = ['review', 'done', 'failed', 'cancelled'];
/** `explain` builds a failure's message, such as `() => timeline(id)`, only once the wait has failed. */
export async function until(predicate: () => boolean, explain?: () => string) {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 15_000, interval: 10 }).catch((error: unknown) => {
    if (explain && error instanceof Error) error.message = `${explain()}: ${error.message}`;
    throw error;
  });
}
/** A run's events after `afterSeq`, one line each: seq, type, turn, step and the first characters of
 *  its text, note or message. An event without a `turnId` takes the one its `turn.started` opened, until the
 *  `turn-end`; events between turns show `turn=-`. The last line, `assertion`, takes the
 *  `: expected …` that Vitest appends to a message. */
export function formatTimeline(runId: string, events: readonly RunEvent[], afterSeq = 0): string {
  const lines: string[] = []; let turn: string | undefined;
  for (const event of events) {
    const own = typeof event.turnId === 'string' ? event.turnId : undefined;
    if (event.type === 'turn.started') turn = own;
    if (event.seq > afterSeq) {
      // A note's `message` is a string; a conversation message's is an object with its `text`.
      const message = typeof event.message === 'object' && event.message !== null ? (event.message as { text?: unknown }).text : event.message;
      const said = typeof event.text === 'string' ? event.text : typeof message === 'string' ? message : '';
      const excerpt = said.replace(/\s+/g, ' ').trim();
      lines.push(`  ${event.seq} ${event.type} turn=${own ?? turn ?? '-'} step=${event.stepId ?? '-'}`
        + (excerpt ? ` ${JSON.stringify(excerpt.length > 80 ? `${excerpt.slice(0, 80)}…` : excerpt)}` : ''));
    }
    if (event.type === 'turn-end') turn = undefined;
  }
  return [`events of run ${runId} after seq ${afterSeq}:`, ...(lines.length ? lines : ['  (none)']), 'assertion'].join('\n');
}
export const timeline = (runId: string, afterSeq = 0) => formatTimeline(runId, store.readEvents(runId), afterSeq);
/** The run's worker wait in the legacy `WorkerWait` shape (`workerWaitView`): since
 *  hearsay-tools/cezarion#1235 phase 3a an agent's worker wait is a `worker` entry in the list. */
export const waitOf = (run: RunRecord | undefined): WorkerWait | undefined => run ? workerWaitView(run) : undefined;
/** The newest settled worker wait (`lastWaits`), in the legacy shape: what `delegation.lastWait` was. */
export const lastWaitOf = (run: RunRecord | undefined): WorkerWait | undefined => {
  const entry = (run?.lastWaits ?? []).filter((wait): wait is DeadlinedWorkerWaitEntry => wait.kind === 'worker' && hasWorkerDeadline(wait)).at(-1);
  return entry ? workerWaitEntryToLegacy(entry) : undefined;
};
/** The open worker entry of a run, for fixtures that move its deadline. */
export const workerEntryOf = (run: RunRecord | undefined): WorkerWaitEntry | undefined =>
  (run?.waits ?? []).filter((wait): wait is WorkerWaitEntry => wait.kind === 'worker' && wait.phase === 'open').at(-1);

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
  runs: store?.listRunIds().flatMap(id => store!.getRun(id) ?? []).map(run => ({ id: run.id, status: run.status, error: run.error, step: run.currentStepId, wait: waitOf(run)?.phase,
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
/**
 * `nudgeReply` is how the native mocks answer Cezar's no-wait nudge (hearsay-tools/cezarion#1234).
 * By default they ignore it in plain text: a run then reaches Cezar's no-wait human wait (the gate
 * a markerless question raised before) and a worker its plain park, so a suite about delegation or
 * CI decides what it tests. `card` keeps the mocks' own answer, a `cezar_ask` card.
 */
export function useWorkerWaitFixture(options: { processScope?: false; nudgeReply?: 'card' | 'plain' } = {}): void {
  beforeEach(() => {
    // Native mock children belong to this fixture; specialized holder tests supply their own scope.
    if (options.processScope !== false) onTestFinished(scopeFixtureProcesses());
    saved = { ...process.env }; began = performance.now(); checkpoints = []; failureState = undefined; checkpoint('setup');
    onTestFailed(() => console.error('WORKER_WAIT_FAILURE_STATE', JSON.stringify(failureState ?? captureState())));
    process.env.CEZ_DRY_RUN = '1'; process.env.CEZ_AUTONAME = '0';
    if (options.nudgeReply === 'card') delete process.env.CEZ_MOCK_NUDGE_REPLY; else process.env.CEZ_MOCK_NUDGE_REPLY = 'plain';
    root = mkdtempSync(join(tmpdir(), 'cez-worker-wait-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'gc.auto', '0'], { cwd: root });
    execFileSync('git', ['config', 'maintenance.auto', 'false'], { cwd: root });
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
    for (const id of store.listRunIds()) manager.cancel(id);
    await until(() => store.listRunIds().every(id => !manager.isActive(id)));
    await Promise.all(executions.splice(0));
    await Promise.all(bookkeeping.splice(0));
    manager.dispose(); store.close();
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

export async function parent(task = 'mock:hold', runner: RunnerId = 'claude') {
  checkpoint('parent-start');
  const run = manager.startRun(QUICK_TASK_WORKFLOW, { task, runner });
  store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
  await until(() => (manager as unknown as { active: Map<string, { sessionEverOpened?: boolean }> }).active.get(run.id)?.sessionEverOpened === true);
  checkpoint('parent-session-open'); return run;
}
export async function worker(parentId: string, task = 'mock:hold', runner: RunnerId = 'claude') {
  checkpoint('worker-plan-start');
  const id = randomUUID();
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const workspace = await planOwnedWorkspace(root, id, sha);
  checkpoint('worker-planned');
  const run = store.createOwnedRun({ title: 'worker', task, workflow: 'quick-task', runner, steps: [{ id: 'task', kind: 'agent', name: 'Task' }] }, parentId, randomUUID(), {
    role: 'worker', permissions: [], parentRunId: parentId, workspace,
  }, 'a'.repeat(64));
  checkpoint('worker-created'); return run;
}
/** Spend a worker's automatic-wake budget before it starts: its turn ends with no wait or done then
 *  plain-park, as every worker's did before hearsay-tools/cezarion#1301. With budget left, the
 *  second such turn end (after the no-wait nudge) asks its parent instead. */
export function spendWorkerBudget(id: string) {
  store.updateRun(id, { automaticWakes: MAX_AUTO_CONTINUES });
}
export function register(parentId: string, ids: string[], seconds = 600) {
  return manager.registerWorkerWait(parentId, workerWaitRequestSchema.parse({ workerIds: ids, timeoutSeconds: seconds }));
}
/** Event logs as they stand now: `restart` writes them back, so nothing its own shutdown
 * appended survives, as after a real crash. */
export function eventCheckpoint(): Map<string, string> {
  store.flush();
  const dir = join(root, '.ai/cezar/runs');
  return new Map(readdirSync(dir).filter(name => name.endsWith('.ndjson')).map(name => [join(dir, name), readFileSync(join(dir, name), 'utf8')]));
}
/** Stop everything, put the persisted runs back to `diskCheckpoint` (or to what they were when
 * this was called), and recover in a fresh store, as after a real crash. */
export async function restart(fakeClock = false, diskCheckpoint?: readonly unknown[], events?: Map<string, string>) {
  checkpoint('restart-stop-start');
  store.flush(); const disk = diskCheckpoint ?? readPersistedRuns(join(root, '.ai/cezar'));
  for (const id of store.listRunIds()) manager.cancel(id);
  await until(() => store.listRunIds().every(id => !manager.isActive(id)));
  await Promise.all(executions.splice(0));
  await Promise.all(bookkeeping.splice(0)); manager.dispose(); store.close(); checkpoint('restart-stopped');
  seedRuns(join(root, '.ai/cezar'), disk);
  for (const [path, content] of events ?? []) writeFileSync(path, content);
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
export async function queuedWake(runner: RunnerId = 'claude') {
  const p = await parent('mock:hold', runner); const w = await worker(p.id, 'mock:slow');
  const wait = register(p.id, [w.id]); checkpoint('queued-wake-registered');
  await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
  const entry = workerEntryOf(store.getRun(p.id));
  if (!entry) throw Error('fixture');
  await restart(); checkpoint('queued-wake-restarted');
  await until(() => (manager as unknown as { active: Map<string, { sessionEverOpened?: boolean }> }).active.get(w.id)?.sessionEverOpened === true); checkpoint('queued-wake-child-open');
  // Overdue only once the worker holds the slot: a wake resolved during recovery would take the
  // slot before the recovered worker, since wakes go first (hearsay-tools/cezarion#1236).
  store.commitWait(p.id, { ...workerEntryOf(store.getRun(p.id))!, deadline: new Date().toISOString() });
  manager.reconcileWorkerWaits();
  await until(() => store.getRun(p.id)?.status === 'queued');
  return { p, w, wait };
}

export function setFailureState(value: unknown) { failureState = value; }
export function reopenRuntime() {
  // A restart: the old store goes first, or it would still own every live family (#779).
  store.close();
  // As `serve` boots: a store that cannot open is kept as `RunStore.unavailable` (#779).
  try {
    store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
  } catch (error) {
    if (!(error instanceof RunStoreOpenError)) throw error;
    store = RunStore.unavailable(join(root, '.ai/cezar'), error);
  }
  manager = new RunManager(store, root, { semaphore });
  track();
}
