import { WaitEngine } from './run/wait-engine.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, WAIT_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import { acquireCiResources } from '../ci-wait/resources.ts';
import { manager, store, root, parent, controlledWire, until, useWorkerWaitFixture, toolGenerationOf } from './worker-wait.testkit.ts';
import type { AgentSession } from '../core/agent-runner.ts';
import * as runners from '../core/runner-factory.ts';
import { createActiveRun } from './active-run.ts';
import { WaitRegistry } from './run/wait-registry.ts';
import type { RunModuleContext } from './run/types.ts';
import { noRunners } from '../core/runners-under-test.testkit.ts';

const pr = 'https://github.com/acme/repo/pull/12';
const identity = { prUrl: pr, repository: 'acme/repo', prNumber: 12, headSha: 'a'.repeat(40) };
const ciWaitOf = (id: string) => store.getRun(id)?.waits?.find(entry => entry.kind === 'pr');
// hearsay-tools/cezarion#1233 dropped `human_ask_pending` and `human_ask_unanswered`: a wait now
// registers under a pending question, which outranks it in `waitingOn` (pinned below).
const codes = ['manager_disposed', 'capability_revoked', 'run_missing', 'run_not_running', 'run_stopping',
  'session_replaced', 'session_closed', 'run_cancelled', 'finish_requested', 'generation_mismatch',
  'worker_execution_stopped', 'root_finish_pending'] as const;

type GuardCode = typeof codes[number];
const moduleRow = (code: GuardCode, duringLookup: boolean) =>
  ['session_replaced', 'run_cancelled', 'finish_requested'].includes(code) || (code === 'generation_mismatch' && duringLookup);

/** Capture the public runner session for session-close guard cases. */
function observeSession() {
  let session: AgentSession | undefined;
  const create = runners.createRunner;
  vi.spyOn(runners, 'createRunner').mockImplementation((...args) => {
    const runner = create(...args);
    if (runner.startSession) {
      const start = runner.startSession.bind(runner);
      vi.spyOn(runner, 'startSession').mockImplementation((...input) => {
        session = start(...input);
        return session;
      });
    }
    return runner;
  });
  return { session: () => session! };
}

/** Any undeclared collaborator read fails the focused policy case. */
function unused<T extends object>(members: Partial<T> = {}): T {
  return new Proxy(members, { get(target, key) {
    if (key in target) return Reflect.get(target, key);
    throw new Error(`unused WaitRegistry collaborator: ${String(key)}`);
  } }) as T;
}

function registrationFixture() {
  const run = store.createRun({ title: 'registration', task: 'guard', workflow: 'quick-task', steps: [] });
  setRunStatus(store, run.id, RUN_STATUS.running);
  const state = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
  state.liveSession.attachSession(unused<AgentSession>({ open: true }));
  state.liveSession.beginCiGeneration('generation');
  state.waitIdentity.rotateCiTurn('turn');
  let current: typeof state | undefined = state;
  const resolve = vi.fn(async () => identity);
  const host = unused<ConstructorParameters<typeof WaitRegistry>[1]>({
    active: () => current, workerExecutionStopped: () => false, executionBlockedByRootFinish: () => false,
    ciSupervisor: () => unused<ReturnType<ConstructorParameters<typeof WaitRegistry>[1]['ciSupervisor']>>({ resolve }),
  });
  const context: RunModuleContext = { createRunner: noRunners, home: testHome(), store, repoRoot: root, dataDir: root,
    work: unused(), semaphore: unused(), disposed: () => false };
  Object.assign(host, { waitEngine: new WaitEngine(context, unused(), 10) });
  const registry = new WaitRegistry(context, host, 10);
  return { run, state, registry, resolve, remove: () => { current = undefined; }, replace: () => { current = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false }); } };
}

describe('CI registration guards before and after metadata lookup', { timeout: 30_000 }, () => {
  useWorkerWaitFixture({ acquireCiResources });
  afterEach(() => vi.restoreAllMocks());
  it.each(codes.flatMap(code => [false, true].map(duringLookup => ({ code, duringLookup })))
    .filter(({ code, duringLookup }) => !moduleRow(code, duringLookup)))
  ('$code duringLookup=$duringLookup returns its blocking state without persisting a wait', async ({ code, duringLookup }) => {
    const gate = join(root, 'end-turn');
    const wire = controlledWire({ firstResultGate: gate });
    const observed = observeSession();
    const run = await parent(); await until(wire.initialReceived);
    const capability = new AbortController();
    let finish!: () => void;
    const resolve = vi.spyOn(CiWatcherSupervisor.prototype, 'resolve').mockImplementation(async () => {
      if (duringLookup) await new Promise<void>(done => { finish = done; });
      return identity;
    });
    vi.spyOn(CiWatcherSupervisor.prototype, 'watch').mockReturnValue(new Promise(() => {}));
    const generation = code === 'generation_mismatch' ? 'different' : toolGenerationOf(run.id);
    const call = () => manager.registerWait(run.id, { kind: WAIT_KIND.pr, pr, timeout_seconds: 30 }, 'cezar_wait', generation, capability.signal);
    const pending = duringLookup ? call() : undefined;
    const assertion = pending ? expect(pending).rejects.toMatchObject({ code }) : undefined;
    if (duringLookup) await until(() => !!finish);
    const readRun = store.getRun.bind(store);
    try {
      switch (code) {
        case 'manager_disposed': manager.dispose(); break;
        case 'capability_revoked': capability.abort(); break;
        case 'run_missing': vi.spyOn(store, 'getRun').mockImplementation(id => id === run.id ? undefined : readRun(id)); break;
        case 'run_not_running': vi.spyOn(store, 'getRun').mockImplementation(id => id === run.id ? { ...readRun(id)!, status: RUN_STATUS.review } : readRun(id)); break;
        case 'run_stopping': vi.spyOn(store, 'getRun').mockImplementation(id => id === run.id ? { ...readRun(id)!, stopping: true } : readRun(id)); break;
        case 'session_closed': observed.session().end(); break;
        case 'worker_execution_stopped': {
          const delegation = store.getRun(run.id)!.delegation!;
          if (delegation.role !== 'root') throw new Error('expected root');
          store.commitDelegation([{ id: run.id, delegation: { ...delegation, historyDeletion: 'pending' } }]);
          break;
        }
        case 'root_finish_pending':
          setRunStatus(store, run.id, RUN_STATUS.waiting);
          store.commitRootFinishIntent(run.id);
          break;
      }
      if (pending) { finish(); await assertion; }
      else await expect(call()).rejects.toMatchObject({ code });
      if (!duringLookup) expect(resolve).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      writeFileSync(gate, '');
      if (code === 'manager_disposed') {
        await observed.session().interrupt();
        await observed.session().result;
      }
    }
    expect(ciWaitOf(run.id)).toBeUndefined();
  });

  it.each(codes.flatMap(code => [false, true].map(duringLookup => ({ code, duringLookup })))
    .filter(({ code, duringLookup }) => moduleRow(code, duringLookup)))
  ('$code identity/lifecycle race duringLookup=$duringLookup refuses without persisting a wait', async ({ code, duringLookup }) => {
    const fixture = registrationFixture();
    const { run, state, registry, resolve } = fixture;
    let finish!: () => void;
    resolve.mockImplementation(async () => {
      if (duringLookup) await new Promise<void>(done => { finish = done; });
      return identity;
    });
    const call = () => registry.registerWait(run.id, { kind: WAIT_KIND.pr, pr }, 'cezar_wait', 'generation');
    const pending = duringLookup ? call() : undefined;
    const assertion = pending ? expect(pending).rejects.toMatchObject({ code }) : undefined;
    if (duringLookup) await until(() => !!finish);
    if (code === 'session_replaced') {
      if (duringLookup) fixture.replace();
      else fixture.remove();
    } else if (code === 'run_cancelled') state.liveSession.cancel();
    else if (code === 'finish_requested') state.liveSession.requestFinish();
    else state.liveSession.beginCiGeneration('replaced');
    if (pending) { finish(); await assertion; }
    else await expect(call()).rejects.toMatchObject({ code });
    if (!duringLookup) expect(resolve).not.toHaveBeenCalled();
    expect(ciWaitOf(run.id)).toBeUndefined();
  });

  it('registers CI and a timer with an unanswered human question in the record', async () => {
    const gate = join(root, 'end-turn');
    const wire = controlledWire({ firstResultGate: gate });
    const run = await parent(); await until(wire.initialReceived);
    vi.spyOn(CiWatcherSupervisor.prototype, 'resolve').mockResolvedValue(identity);
    vi.spyOn(CiWatcherSupervisor.prototype, 'watch').mockReturnValue(new Promise(() => {}));
    store.appendEvent(run.id, { type: 'ask.requested', requestId: 'unanswered-question', questions: [{ header: 'Review', question: 'Approve?' }] });
    try {
      const ci = await manager.registerWait(run.id, { kind: WAIT_KIND.pr, pr, timeout_seconds: 30 }, 'cezar_wait', toolGenerationOf(run.id));
      const timer = await manager.registerWait(run.id, { kind: WAIT_KIND.timer, seconds: 60 }, 'cezar_wait', toolGenerationOf(run.id));
      expect(store.getRun(run.id)?.waits?.map(wait => wait.id)).toEqual([ci.id, timer.id]);
    } finally { vi.restoreAllMocks(); writeFileSync(gate, ''); }
  });
});

// hearsay-tools/cezarion#1425: a checks wait never stands in for a merge wait on the same PR.
describe('PR wait targets', { timeout: 30_000 }, () => {
  useWorkerWaitFixture({ acquireCiResources });
  afterEach(() => vi.restoreAllMocks());
  it('opens a checks wait and a merge wait on one PR as two waits, and shares one lookup for a repeat', async () => {
    const gate = join(root, 'end-turn');
    const wire = controlledWire({ firstResultGate: gate });
    const run = await parent(); await until(wire.initialReceived);
    let lookups = 0;
    let release!: () => void;
    vi.spyOn(CiWatcherSupervisor.prototype, 'resolve').mockImplementation(async () => { lookups++; await new Promise<void>(done => { release = done; }); return identity; });
    const watched: unknown[] = [];
    vi.spyOn(CiWatcherSupervisor.prototype, 'watch').mockImplementation(wait => { watched.push(wait); return new Promise(() => {}); });
    try {
      const generation = toolGenerationOf(run.id);
      const checks = manager.registerWait(run.id, { kind: WAIT_KIND.pr, pr }, 'cezar_wait', generation);
      await until(() => lookups === 1); release();
      const first = await checks;
      const merges = [0, 1].map(() => manager.registerWait(run.id, { kind: WAIT_KIND.pr, pr, until: 'merge', wake_on_conflict: false }, 'cezar_wait', generation));
      await until(() => lookups === 2); release();
      const [merge, repeat] = await Promise.all(merges);
      expect(lookups).toBe(2);
      expect(repeat!.id).toBe(merge!.id);
      expect(merge!.id).not.toBe(first.id);
      expect(store.getRun(run.id)?.waits).toEqual([
        expect.objectContaining({ id: first.id, kind: WAIT_KIND.pr, until: 'checks', wakeOnConflict: true }),
        expect.objectContaining({ id: merge!.id, kind: WAIT_KIND.pr, until: 'merge', wakeOnConflict: false }),
      ]);
      expect(watched).toEqual([expect.objectContaining({ until: 'checks', wakeOnConflict: true }), expect.objectContaining({ until: 'merge', wakeOnConflict: false })]);
    } finally { vi.restoreAllMocks(); writeFileSync(gate, ''); }
  });
});

describe('CI metadata lookup interruption', { timeout: 30_000 }, () => {
  useWorkerWaitFixture({ acquireCiResources });
  afterEach(() => vi.restoreAllMocks());
  it.each(['registration_aborted', 'turn_changed', 'capability_revoked'] as const)
  ('reports %s even if the interrupted lookup rejects', async code => {
    const { run, state, registry, resolve } = registrationFixture();
    const capability = new AbortController();
    let fail!: (reason: Error) => void;
    resolve.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const pending = registry.registerWait(run.id, { kind: WAIT_KIND.pr, pr }, 'cezar_wait', 'generation', capability.signal);
    const assertion = expect(pending).rejects.toMatchObject({ code });
    if (code === 'registration_aborted') registry.abortRegistrations(run.id);
    else if (code === 'turn_changed') state.waitIdentity.rotateCiTurn('next-turn');
    else capability.abort();
    fail(new Error('lookup aborted'));
    await assertion;
    expect(ciWaitOf(run.id)).toBeUndefined();
  });
});
