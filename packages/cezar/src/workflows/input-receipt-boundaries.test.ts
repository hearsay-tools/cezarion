import { ABSENT_PROCESS_PID, OTHER_ABSENT_PROCESS_PID } from '../delegation/process-enumeration.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { fixture as ownedFixture } from '../delegation/service.testkit.ts';
import { createActiveRun } from './active-run.ts';
import { sessionResultWithReceipts, type InputReceiptsHost, type InputReceiptSteps } from './run/input-receipts.ts';
import type { RunModuleContext } from './run/types.ts';
import { TrackedWork } from './run/tracked-work.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RUN_STATUS, STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentRunner, AgentSession, AgentRunResult, SessionOptions } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import * as processes from '../core/process-usage.ts';
import { RunStore } from '../runs/store.ts';
import { setRunStatus, readPersistedRuns } from '../runs/run-store.testkit.ts';
import { createFixtureManager, drainFixtureManagers, fixtureWork, fixtureWorkSettled, unused } from './fixture-manager.testkit.ts';
import type { RunManager } from './run.ts';
import { noRunners, useRunners } from '../core/runners-under-test.testkit.ts';

const hook = vi.hoisted(() => ({ runner: undefined as AgentRunner | undefined }));
useRunners(() => hook.runner!);

function signal<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

let root: string;
let store: RunStore;
let manager: RunManager;
let closeSession: (() => void) | undefined;
const workflow = { source: 'built-in' as const, name: 'receipts', steps: [{ id: 'work', name: 'work', prompt: '{{task}}' }] };

beforeEach(() => {
  vi.stubEnv('CEZ_AUTONAME', '0');
  root = mkdtempSync(join(tmpdir(), 'cez-receipt-boundary-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'file.txt'), 'base');
  execFileSync('git', ['add', 'file.txt'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'base'], { cwd: root });
  store = RunStore.open(join(root, '.ai/cezar'));
  manager = createFixtureManager(store, root);
});
afterEach(async () => {
  closeSession?.();
  await drainFixtureManagers(root);
  manager.dispose(); store.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function controlledRunner(beforeReturn: (opts: SessionOptions) => void = () => undefined) {
  const started = signal<SessionOptions>();
  const result = signal<AgentRunResult>();
  let open = true;
  const close = () => { open = false; result.resolve({ text: '', toolCalls: [], tokensUsed: 0 }); };
  const session: AgentSession = { get result() { return result.promise; }, get open() { return open; },
    sendMessage: () => true, sendAgentMessage: () => false, discardQueuedMessages() {}, holdsHumanInput: () => false,
    end: close, interrupt: vi.fn() };
  const runner: AgentRunner = { backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => undefined,
    startSession(_spec, _event, opts = {}) { beforeReturn(opts); started.resolve(opts); return session; } };
  hook.runner = runner; closeSession = close;
  return { started, result, session, close };
}

function launch(mode: 'fresh' | 'continuation') {
  if (mode === 'fresh') return manager.startRun(workflow, { task: 'receipts', runner: 'claude', worktree: false }).id;
  const record = store.createRun({ title: 'continue receipts', task: 'receipts', workflow: workflow.name,
    steps: [{ id: 'work', name: 'work', kind: STEP_KIND.agent }], runner: 'claude' });
  // Seed a completed task; Continue must use its own launch path.
  store.updateStep(record.id, 'work', { status: RUN_STATUS.done, sessionId: randomUUID() });
  setRunStatus(store, record.id, RUN_STATUS.done, { finishedAt: new Date().toISOString() });
  const continued = manager.continueRun(record.id, { text: 'continue receipts' });
  expect(continued, JSON.stringify(continued)).toMatchObject({ ok: true });
  return record.id;
}

const saved = (id: string) => { store.flush(); return readPersistedRuns(join(root, '.ai/cezar')).find(run => run.id === id)!; };

it.each(['fresh', 'continuation'] as const)('%s reads the session at callback time before and after startSession returns', async mode => {
  let id = '';
  const inputId = randomUUID();
  const runner = controlledRunner(opts => {
    const input = { id: inputId, source: agentInputSchema.shape.source.enum.agent, parentRunId: id, text: 'callback input', createdAt: new Date().toISOString() };
    store.commitOutcome(id, [], { enqueue: [input] });
    store.commitOutcome(id, { kind: 'delivered', inputIds: [inputId], at: input.createdAt, awaitingRead: true });
    opts.onAgentInputReady?.(); opts.onAgentInputConsumed?.([inputId]);
    expect(saved(id).agentInputs?.[0]?.consumedAt).toBeUndefined();
  });
  const setup = observePrepared(runner.session);
  id = launch(mode); const opts = await runner.started.promise; await setup;
  const next = { id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId: id, text: 'ready input', createdAt: new Date().toISOString() };
  store.commitOutcome(id, [], { enqueue: [next] });
  vi.spyOn(runner.session, 'sendAgentMessage').mockResolvedValue(undefined);
  opts.onAgentInputReady?.(); opts.onAgentInputConsumed?.([inputId]);
  // bound: acknowledgement is a resolved owned promise; this only guards a missing checkpoint.
  await vi.waitFor(() => expect(store.getRun(id)?.agentInputs?.find(input => input.id === next.id)?.deliveredAt).toBeDefined());
  expect(saved(id).agentInputs?.[0]?.consumedAt).toBeDefined();
  runner.close(); await fixtureWorkSettled(root);
});

function observePrepared(session: AgentSession) {
  const setup = signal();
  Object.defineProperty(session, 'pid', { value: ABSENT_PROCESS_PID });
  vi.spyOn(processes, 'registerRunProcess').mockImplementation(() => setup.resolve());
  return setup.promise;
}

function throwSetupAt(failure: string, session?: AgentSession) {
  const error = () => { throw new Error(`setup refused: ${failure}`); };
  switch (failure) {
    case 'inputs': return vi.spyOn(session!, 'open', 'get').mockImplementationOnce(error);
    case 'register': return vi.spyOn(processes, 'registerRunProcess').mockImplementation(error);
  }
}

for (const mode of ['fresh', 'continuation'] as const) {
  it.each(['deferred', 'inputs', 'register'])(`${mode} interrupts and waits for termination after %s setup fails`, async failure => {
    let id = '';
    let setupFailure: ReturnType<typeof vi.spyOn> | undefined;
    const runner = controlledRunner(() => {
      if (failure === 'deferred') {
        manager.deferMessage(id, [{ type: 'text', text: 'deferred setup' }]);
        setupFailure = vi.spyOn(runner.session, 'sendMessage').mockImplementation(() => { throw new Error('setup refused: deferred'); });
      } else if (failure === 'inputs') setupFailure = throwSetupAt(failure, runner.session);
    });
    Object.defineProperty(runner.session, 'pid', { value: ABSENT_PROCESS_PID });
    vi.spyOn(processes, 'registerRunProcess').mockImplementation(() => undefined);
    const tracked = vi.spyOn(fixtureWork(manager), 'trackSession');
    const finallyCalled = vi.spyOn(runner.session.result, 'finally');
    const boundary = signal<'termination' | 'error'>();
    vi.mocked(runner.session.interrupt).mockImplementation(() => boundary.resolve('termination'));
    const append = store.appendEvent.bind(store);
    vi.spyOn(store, 'appendEvent').mockImplementation((id, event) => {
      if (event.type === 'session.error') boundary.resolve('error');
      return append(id, event);
    });
    if (failure === 'register') setupFailure = throwSetupAt(failure);
    id = launch(mode); await runner.started.promise;
    expect(await boundary.promise).toBe('termination');
    expect(setupFailure).toHaveBeenCalled();
    expect(tracked).toHaveBeenCalledOnce();
    expect(runner.session.interrupt).toHaveBeenCalledOnce();
    expect(manager.isActive(id)).toBe(true);
    expect(saved(id).status).toBe('running');
    runner.close(); await fixtureWorkSettled(root);
    expect(saved(id)).toMatchObject({ status: RUN_STATUS.failed, error: expect.stringContaining(`setup refused: ${failure}`) });
    expect(finallyCalled).not.toHaveBeenCalled();
  });
}

it('the receipt setup contract propagates recordProcess failure before marking prepared or reading the result', () => {
  const runner = controlledRunner();
  Object.defineProperty(runner.session, 'pid', { value: ABSENT_PROCESS_PID });
  const context: RunModuleContext = { createRunner: noRunners, home: testHome(), store, repoRoot: root, dataDir: join(root, '.ai/cezar'),
    semaphore: new WorkspaceSemaphore({ home: testHome() }), work: new TrackedWork(), disposed: () => false };
  const state = createActiveRun({ cwd: root, autonomous: false, pendingHumanAsk: false });
  const calls: string[] = [];
  const host = unused<InputReceiptsHost>('receipts', { flushAgentInputs: () => { calls.push('inputs'); } });
  const steps = unused<InputReceiptSteps>('steps', {
    flushDeferred: () => { calls.push('deferred'); },
    recordProcess: (id, pid) => { calls.push('record'); expect([id, pid]).toEqual(['run', ABSENT_PROCESS_PID]); throw Error('record refused'); },
  });
  vi.spyOn(processes, 'registerRunProcess').mockImplementation(() => { calls.push('register'); });
  const prepared = vi.fn();
  const result = vi.spyOn(runner.session, 'result', 'get');
  expect(() => sessionResultWithReceipts(context, host, steps, 'run', state, runner.session, prepared)).toThrow('record refused');
  expect(calls).toEqual(['deferred', 'inputs', 'register', 'record']);
  expect(prepared).not.toHaveBeenCalled();
  expect(result).not.toHaveBeenCalled();
});

it.each(['fresh', 'continuation'] as const)('%s keeps a worker session live when its process record write fails', async mode => {

  const owned = ownedFixture();
  let runner = controlledRunner();
  Object.defineProperty(runner.session, 'pid', { value: ABSENT_PROCESS_PID });
  vi.spyOn(processes, 'registerRunProcess').mockImplementation(() => undefined);
  const { workerId } = await owned.service.spawn(owned.caller, { task: 'receipts', baseline: 'parent-head', requestId: randomUUID() });
  try {
    if (mode === 'continuation') {
      const firstSetup = observePrepared(runner.session);
      await owned.releaseAdmission();
      await firstSetup;
      runner.close();
      // bound: the first owned execution must terminate before Continue starts a new one.
      expect(await owned.manager.awaitRunTermination(workerId, 15_000)).toBe(true);
      runner = controlledRunner();
      Object.defineProperty(runner.session, 'pid', { value: ABSENT_PROCESS_PID });
    }
    const recorded = signal();
    const write = vi.spyOn(owned.store, 'appendWorkerProcess').mockImplementation(() => {
      recorded.resolve();
      throw Error('injected process record write failure');
    });
    if (mode === 'fresh') await owned.releaseAdmission();
    else expect(owned.manager.continueRun(workerId, { text: 'continue receipts' })).toMatchObject({ ok: true });
    await recorded.promise;
    expect(write).toHaveBeenCalledWith(workerId, expect.any(String), ABSENT_PROCESS_PID, undefined);
    expect(runner.session.interrupt).not.toHaveBeenCalled();
    expect(runner.session.open).toBe(true);
    expect(owned.manager.isActive(workerId)).toBe(true);
    expect(owned.store.getRun(workerId)?.status).toBe(RUN_STATUS.running);
  } finally {
    runner.close();
    await owned.close();
  }
});

it.each(['fresh', 'continuation'] as const)('%s replaces a changed PID before recording the worker process', async mode => {

  const owned = ownedFixture();
  let runner = controlledRunner();
  const firstSetup = observePrepared(runner.session);
  const { workerId } = await owned.service.spawn(owned.caller, { task: 'receipts', baseline: 'parent-head', requestId: randomUUID() });
  try {
    await owned.releaseAdmission();
    await firstSetup;
    if (mode === 'continuation') {
      runner.close();
      // bound: the owned result must retire the first execution before continuation.
      expect(await owned.manager.awaitRunTermination(workerId, 15_000)).toBe(true);
      runner = controlledRunner();
      const setup = observePrepared(runner.session);
      expect(owned.manager.continueRun(workerId, { text: 'continue receipts' })).toMatchObject({ ok: true });
      await setup;
    }
    const opts = await runner.started.promise;
    const calls: string[] = [];
    vi.spyOn(processes, 'replaceRunProcess').mockImplementation(() => { calls.push('replace'); });
    const append = owned.store.appendWorkerProcess.bind(owned.store);
    vi.spyOn(owned.store, 'appendWorkerProcess').mockImplementation((id, generation, pid, pgid) => {
      if (pid === OTHER_ABSENT_PROCESS_PID) {
        expect(calls).toEqual(['replace']);
        calls.push('record');
      }
      return append(id, generation, pid, pgid);
    });
    opts.onPidChange?.(OTHER_ABSENT_PROCESS_PID);
    expect(calls).toEqual(['replace', 'record']);
    expect(processes.replaceRunProcess).toHaveBeenCalledWith(workerId, OTHER_ABSENT_PROCESS_PID);
    const generation = owned.store.readWorkerExecution(workerId)!.generation;
    const recorded = owned.store.readWorkerProcesses(workerId, generation);
    expect(recorded).toMatchObject({ processes: expect.arrayContaining([expect.objectContaining({ pid: OTHER_ABSENT_PROCESS_PID })]) });
  } finally {
    runner.close();
    await owned.close();
  }
});

it.each(['fresh', 'continuation'] as const)('%s leaves an already prepared session to its result failure handler', async mode => {
  const runner = controlledRunner();
  const setup = observePrepared(runner.session);
  const id = launch(mode); await setup;
  runner.result.reject(new Error('provider refused'));
  await fixtureWorkSettled(root);
  expect(saved(id)).toMatchObject({ status: RUN_STATUS.failed, error: expect.stringContaining('provider refused') });
  expect(runner.session.interrupt).not.toHaveBeenCalled();
});
