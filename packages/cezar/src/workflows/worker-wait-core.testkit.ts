import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { observeWaitTimers } from './waits.testkit.ts';
import { TrackedWork } from './run/tracked-work.ts';
import { runnersUnderTest } from '../core/runners-under-test.testkit.ts';
/**
 * The delegation fixture the worker-wait suites share: a real `RunManager` over a scratch Git repo
 * and native mocks (`useWorkerWaitFixture`), with builders for parents, workers, waits and restarts.
 * Pass `timeline(runId, afterSeq)` as the message of an assertion on a run's turns or events, to
 * `expect` or as `until`'s second argument: a failure then lists every event with its turn, step and
 * text, which is how a no-wait nudge's extra turn shows up (hearsay-tools/cezarion#1292).
 * The helpers that need no fixture live in `worker-wait-timeline.testkit.ts`; this module re-exports them.
 */
import { scopeFixtureProcesses } from '../delegation/process-scope.testkit.ts';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, onTestFailed, onTestFinished, vi } from 'vitest';
import { workerWaitRequestSchema, type WorkerOperation } from '@open-mercato/cezar-contract/delegation';
import { RunStore } from '../runs/store.ts';
import { formatTimeline, terminal, until, waitOf, workerEntryOf } from './worker-wait-timeline.testkit.ts';
export { deliveredBesideWorkerMessages, formatTimeline, lastWaitOf, terminal, until, waitOf, workerEntryOf } from './worker-wait-timeline.testkit.ts';
import { RunStoreOpenError } from '../runs/store-open-error.ts';
import { CredentialRegistry, type Caller } from '../delegation/credentials.ts';
import { DelegationService } from '../delegation/service.ts';
import { collectWorkerEvidence } from '../delegation/results.ts';
import { planOwnedWorkspace } from '../delegation/workspace.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { MAX_AUTO_CONTINUES, RunManager } from './run.ts';
import { acquireInertCiResources } from '../ci-wait/inert-ci-resources.testkit.ts';
import type { CiResources } from '../ci-wait/resource-pool.ts';
import type { RunnerId } from '../core/agent-runner.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { readPersistedRuns, seedRuns } from '../runs/run-store.testkit.ts';

/** The test file's runners, read when a run starts one (hearsay-tools/cezarion#2939). */
const fixtureRunners: import('../core/agent-runner.ts').RunnerFactory = (backend, options) => runnersUnderTest()(backend, options);

export const timeline = (runId: string, afterSeq = 0) => formatTimeline(runId, store.readEvents(runId), afterSeq);

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.

export let root: string;
export let store: RunStore;
export let manager: RunManager;
export let semaphore: WorkspaceSemaphore;
export let work: TrackedWork;
/** The CI resources every manager of this fixture acquires: `useWorkerWaitFixture`'s choice. */
let ciResources: (workspace: object) => CiResources = acquireInertCiResources;
const toolGenerations = new Map<string, string>();
/** Capture the generation passed through the public tool-handler boundary. */
export function toolGenerationOf(id: string): string {
  const generation = toolGenerations.get(id);
  if (!generation) throw new Error(`No tool launch observed for ${id}`);
  return generation;
}
let saved: NodeJS.ProcessEnv;
let phase = 'setup';
let checkpoints: Array<{ phase: string; ms: number }> = [];
let began = 0;
let failureState: unknown;
export function checkpoint(value: string) { phase = value; checkpoints.push({ phase, ms: Math.round(performance.now() - began) }); }
export function captureState() { return { root, phase, checkpoints: checkpoints.map(entry => ({ ...entry })), elapsedMs: Math.round(performance.now() - began), busy: semaphore?.busy(),
  ownedOperations: [...(work?.pending.values() ?? [])],
  sessions: [...(work?.liveSessions ?? [])].map(session => ({ pid: session.pid, open: session.open })),
  runs: store?.listRunIds().flatMap(id => store!.getRun(id) ?? []).map(run => ({ id: run.id, status: run.status, error: run.error, step: run.currentStepId, wait: waitOf(run)?.phase,
    active: manager.isActive(run.id), toolGenerationPresent: toolGenerations.has(run.id),
    hasSessionId: run.steps.some(step => !!step.sessionId),
    steps: run.steps.map(step => ({ id: step.id, sessionId: step.sessionId ?? null })),
    stopping: run.stopping, execution: store.readWorkerExecution(run.id),
    inputs: run.agentInputs?.map(input => ({ id: input.id, deliveredAt: input.deliveredAt })),
    events: formatTimeline(run.id, store.readEvents(run.id).slice(-6)), })),
}; }
async function settleTrackedWork(): Promise<void> {
  while (work.pending.size) await Promise.allSettled([...work.pending.keys()]);
}

export const bookkeeping: Promise<unknown>[] = [];
export const executions: Promise<unknown>[] = [];
export function track() {
  observeWaitTimers(manager, store);
  const handlers = manager.squawkToolHandlers.bind(manager);
  vi.spyOn(manager, 'squawkToolHandlers').mockImplementation((id, generation) => {
    toolGenerations.set(id, generation);
    return handlers(id, generation);
  });
  const realTrack = TrackedWork.prototype.track.bind(work);
  vi.spyOn(work, 'track').mockImplementation((label, promise) => {
    if (label === 'execute' || label === 'runContinuation') executions.push(promise);
    if (label === 'recordTurnEnd') bookkeeping.push(promise);
    return realTrack(label, promise);
  });
}

/**
 * `nudgeReply` is how the native mocks answer Cezar's no-wait nudge (hearsay-tools/cezarion#1234).
 * By default they ignore it in plain text: a run then reaches Cezar's no-wait human wait (the gate
 * a markerless question raised before) and a worker its plain park, so a suite about delegation or
 * CI decides what it tests. `card` keeps the mocks' own answer, a `cezar_ask` card.
 * `mockNotes` keeps the Claude mock's `notes.md` trace. Without it, task worktrees stay clean, so
 * no turn-end or finalize autosave has a commit to make: each one cost about 20 Git calls behind
 * its process-holder scans, most of a waits cell's cleanup (hearsay-tools/cezarion#1665).
 */
export function useWorkerWaitFixture(options: { processScope?: false; nudgeReply?: 'card' | 'plain'; mockNotes?: true; unreadInputGraceMs?: number; subagentGraceMs?: number; subagentDeadlineMs?: number; acquireCiResources?: (workspace: object) => CiResources } = {}): void {
  beforeEach(() => {
    ciResources = options.acquireCiResources ?? acquireInertCiResources;
    // Native mock children belong to this fixture; specialized holder tests supply their own scope.
    if (options.processScope !== false) onTestFinished(scopeFixtureProcesses());
    saved = { ...process.env }; began = performance.now(); checkpoints = []; failureState = undefined; checkpoint('setup');
    onTestFailed(() => console.error('WORKER_WAIT_FAILURE_STATE', JSON.stringify(failureState ?? captureState())));
    process.env.CEZ_DRY_RUN = '1'; process.env.CEZ_AUTONAME = '0';
    if (options.nudgeReply === 'card') delete process.env.CEZ_MOCK_NUDGE_REPLY; else process.env.CEZ_MOCK_NUDGE_REPLY = 'plain';
    if (options.mockNotes) delete process.env.CEZ_MOCK_NOTES; else process.env.CEZ_MOCK_NOTES = '0';
    root = mkdtempSync(join(tmpdir(), 'cez-worker-wait-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'gc.auto', '0'], { cwd: root });
    execFileSync('git', ['config', 'maintenance.auto', 'false'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
    work = new TrackedWork(); toolGenerations.clear();
    semaphore = new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 1 } });
    store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, root, { acquireCiResources: ciResources, createRunner: fixtureRunners, semaphore, work, ...(options.unreadInputGraceMs === undefined ? {} : { unreadInputGraceMs: options.unreadInputGraceMs }),
      ...(options.subagentGraceMs === undefined ? { home: testHome(),} : { home: testHome(), subagentGraceMs: options.subagentGraceMs }),
      ...(options.subagentDeadlineMs === undefined ? { home: testHome(),} : { home: testHome(), subagentDeadlineMs: options.subagentDeadlineMs }) }); track();
  });
  afterEach(async () => {
    const errors: unknown[] = [];
    const cleanup = (work: () => unknown) => { try { work(); } catch (error) { errors.push(error); } };
    try {
      failureState = captureState();
      vi.useRealTimers(); checkpoint('teardown-handles');
      // Cancellation during the dequeue/spawn gap is covered by Task 6's barrier;
      // this fixture waits for its real runner handles before stopping processes.
      await until(() => {
        const active = store.listRunIds().filter(id => {
          const run = store.getRun(id);
          return manager.isActive(id) && run?.status !== 'queued';
        });
        return active.every(id => store.getRun(id)?.steps.some(step => !!step.sessionId)) && active.length <= work.liveSessions.size;
      }, () => JSON.stringify(captureState()));
      checkpoint('teardown-cancel');
      for (const id of store.listRunIds()) cleanup(() => manager.cancel(id));
      checkpoint('teardown-termination');
      await until(() => store.listRunIds().every(id => !manager.isActive(id)), () => JSON.stringify(captureState()));
    } catch (error) {
      errors.push(error);
      // Capture AFTER cancellation, while the active registry and store still exist.
      cleanup(() => { failureState = captureState(); });
    } finally {
      // A failed assertion must not strand native sessions, skip disposal, or close the
      // store beneath execution/bookkeeping. Keep every cleanup attempt independent.
      const sessions = [...work.liveSessions];
      for (const session of sessions) cleanup(() => session.interrupt());
      cleanup(() => manager.dispose());
      await Promise.allSettled(sessions.map(session => session.result));
      for (const pending of [executions, bookkeeping]) {
        for (const result of await Promise.allSettled(pending.splice(0))) if (result.status === 'rejected') errors.push(result.reason);
      }
      await settleTrackedWork();
      cleanup(() => store.close());
      cleanup(() => rmSync(root, { recursive: true, force: true }));
      process.env = saved;
    }
    if (errors.length) throw errors[0];
  }, 30_000);
}
/** `replay` echoes each consumed line as the real CLI's `--replay-user-messages` does, so a human
 *  follow-up stops counting as held once its turn reads it. */
const MOCK_CI_TOOL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'mock-ci-tool.mjs')).href;
export function controlledWire(options: { firstResultGate?: string; humanAnswerGate?: string; replay?: boolean } = {}) {
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
if (options.replay && message.uuid) emit({ type: 'user', isReplay: true, uuid: message.uuid, message: message.message });
if (first) { first = false; fs.writeFileSync(${JSON.stringify(initial)}, 'received'); await wait(options.firstResultGate); }
const humanAnswer = text.includes('human answer mock:hold');
if (humanAnswer && options.humanAnswerGate) { fs.appendFileSync(received, JSON.stringify({ text }) + '\n'); await wait(options.humanAnswerGate); }
// hearsay-tools/cezarion#2397: the lifecycle scenarios call the cezar tool through the session's
// MCP config with the native mocks' own client, then end the turn.
const lifecycle = async (name, toolArgs) => (await import(${JSON.stringify(MOCK_CI_TOOL)})).lifecycleCall('claude', args, name, toolArgs);
const ask = !humanAnswer && text.includes('mock:cezar-ask');
const done = !ask && text.includes('mock:cezar-done');
const reply = 'controlled wire reply' + (ask ? await lifecycle('cezar_ask', { context: 'A choice is needed before I continue.', questions: [{ header: 'Choice', question: 'Which framework?', options: [{ label: 'Vitest' }, { label: 'Other' }] }] })
  : done ? await lifecycle('cezar_done', {})
  : text.includes('mock:cezar-wait') ? await lifecycle('cezar_wait', { kind: 'timer', seconds: 60 }) : '');
emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
emit({ type: 'result', subtype: 'success', result: reply, usage: { input_tokens: 1, output_tokens: 1 } });
}); });
rl.on('close', () => process.exit(0));
`); chmodSync(wire, 0o755);
  process.env.CEZ_DRY_RUN = '0'; process.env.CEZ_CLAUDE_BIN = wire;
  return { initialReceived: () => existsSync(initial), received: () => existsSync(received) ? readFileSync(received, 'utf8').trim().split('\n').length : 0 };
}

async function startParent(task: string, runner: RunnerId, permissions: WorkerOperation[]) {
  checkpoint('parent-start');
  const run = manager.startRun(QUICK_TASK_WORKFLOW, { task, runner });
  store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions, receipts: [] } }]);
  await until(() => {
    return manager.isActive(run.id) && toolGenerations.has(run.id) && store.getRun(run.id)?.steps.some(step => !!step.sessionId) === true;
  }, () => JSON.stringify(captureState()));
  checkpoint('parent-session-open'); return run;
}
/** The root may message its workers, as provisioned roots do, so their questions reach it
 *  (hearsay-tools/cezarion#2410). */
export function grantSteer(rootId: string): void {
  const delegation = store.getRun(rootId)?.delegation;
  if (delegation?.role !== 'root') throw Error('missing root');
  if (!delegation.permissions.includes('steer')) store.commitDelegation([{ id: rootId, delegation: { ...delegation, permissions: [...delegation.permissions, 'steer'] } }]);
}
/** Low-level root builder. Use `delegatingParent` for service calls. Recovery and inactive-parent tests may keep explicit service setup. */
export function parent(task = 'mock:hold', runner: RunnerId = 'claude') {
  return startParent(task, runner, ['spawn', 'wait']);
}

/** A service-ready root with exactly the test's permissions, scoped callers and automatic cleanup.
 *  A restart needs a new registration for its new store/manager, not this old service. */
export async function delegatingParent(options: { permissions: WorkerOperation[]; task?: string; runner?: RunnerId }) {
  const p = await startParent(options.task ?? 'mock:hold', options.runner ?? 'claude', [...options.permissions]);
  const service = new DelegationService();
  const detach = service.registerProject({ home: testHome(), id: 'project', root, store, manager });
  const credentials = new CredentialRegistry();
  const callers = new Map<string, Caller>();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { detach(); } finally { credentials.close(); callers.clear(); }
  };
  onTestFinished(close);
  const callerFor = (runId: string): Caller => {
    if (closed) throw Error('Delegating parent fixture is closed');
    let caller = callers.get(runId);
    if (!caller) {
      caller = credentials.authenticate(credentials.issue('project', runId, randomUUID()))!;
      callers.set(runId, caller);
    }
    return caller;
  };
  return { p, service, callerFor, close };
}

export async function worker(parentId: string, task = 'mock:hold', runner: RunnerId = 'claude') {
  checkpoint('worker-plan-start');
  const id = randomUUID();
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const workspace = await planOwnedWorkspace(root, id, sha);
  checkpoint('worker-planned');
  const run = store.createOwnedRun({ title: 'worker', task, workflow: 'quick-task', runner, steps: [{ id: 'task', kind: STEP_KIND.agent, name: 'Task' }] }, parentId, randomUUID(), {
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
  manager = new RunManager(store, root, { acquireCiResources: ciResources, createRunner: fixtureRunners, home: testHome(), semaphore, work }); track(); checkpoint('restart-recover-start');
  await manager.recover(); checkpoint('restart-recovered');
}

// Legacy lifecycle fixtures publish settled workers without launching a process.
// Supply the private completion boundary too; status alone is intentionally insufficient.
export function fixtureUpdateRun(id: string, patch: NonNullable<Parameters<typeof setRunStatus>[3]> & { status?: Parameters<typeof setRunStatus>[2] }) {
  const run = store.getRun(id);
  const generation = run?.delegation?.role === 'worker' && patch.status && terminal.includes(patch.status)
    ? store.commitWorkerExecutionStart(id) : undefined;
  const { status, ...extras } = patch;
  if (status === undefined) store.updateRun(id, extras);
  else setRunStatus(store, id, status, extras);
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
  await until(() => manager.isActive(w.id) && store.getRun(w.id)?.steps.some(step => !!step.sessionId) === true); checkpoint('queued-wake-child-open');
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
  manager = new RunManager(store, root, { acquireCiResources: ciResources, createRunner: fixtureRunners, home: testHome(), semaphore, work });
  track();
}
