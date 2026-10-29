import { runInternals } from './run-internals.testkit.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProcessWaitEntry, ProcessWaitResult, Wait } from '@open-mercato/cezar-contract';
import { ProcessWaitSupervisor, type ProcessWatchRequest } from '../process-wait/supervisor.ts';
import { manager, parent, restart, semaphore, store, until, useWorkerWaitFixture } from './worker-wait.testkit.ts';
import { waitResultText } from './waits.ts';

// Tool transport is exercised by adapter parity; lifecycle tests control only external resources.
vi.mock('../ci-wait/resources.ts', () => ({ acquireCiResources: () => ({
  supervisor: { close() {} }, controller: async () => undefined, release() {},
}) }));

// hearsay-tools/cezarion#1446: a process wait through RunManager. Only the process watch is
// controlled; the store, scheduler and runner wire stay real.
const children: ChildProcess[] = [];
/** A live process of this test's own, to wait on. */
const sleeper = () => { const proc = spawn('sleep', ['30'], { stdio: 'ignore' }); children.push(proc); return proc.pid!; };

function processes() {
  const watches: Array<{ request: ProcessWatchRequest; signal: AbortSignal; settle: (result: ProcessWaitResult) => void }> = [];
  vi.spyOn(ProcessWaitSupervisor.prototype, 'watch').mockImplementation((request, signal) =>
    new Promise<ProcessWaitResult>(resolve => { watches.push({ request, signal, settle: resolve }); }));
  return {
    watches,
    settle: (result: Omit<ProcessWaitResult, 'observedAt'>, index = -1) => watches.at(index)!.settle({ observedAt: new Date().toISOString(), ...result }),
  };
}

const generationOf = (id: string) => (manager as unknown as { active: Map<string, { ciGeneration: string }> }).active.get(id)!.ciGeneration;
const register = async (id: string, request: { pid: number; exit_file?: string; note?: string; timeout_seconds?: number }) =>
  await manager.registerWait(id, { kind: 'process', timeout_seconds: 1800, ...request }, 'cezar_wait', generationOf(id)) as ProcessWaitEntry;
const waitById = (id: string, waitId: string) => store.getRun(id)?.waits?.find(entry => entry.id === waitId);
const settledById = (id: string, waitId: string) => store.getRun(id)?.lastWaits?.find(entry => entry.id === waitId);
const inputsFor = (id: string, waitId: string) => store.getRun(id)?.agentInputs?.filter(input => input.id === waitId) ?? [];
const notes = (id: string, text: string) => store.readEvents(id).filter(event => event.type === 'note' && String(event.message).includes(text));
const engine = () => runInternals(manager).line;

async function waitingParent() {
  const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
  return run;
}

describe('process waits through RunManager (hearsay-tools/cezarion#1446)', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => {
    vi.restoreAllMocks();
    for (const proc of children.splice(0)) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  });

  it('refuses PID 1, Cezar\'s own PID, an exit file outside the worktree, and the timer refusals', async () => {
    processes();
    const run = await waitingParent();
    await expect(register(run.id, { pid: 1 })).rejects.toThrow();
    await expect(register(run.id, { pid: process.pid })).rejects.toMatchObject({ code: 'process_not_allowed' });
    await expect(register(run.id, { pid: sleeper(), exit_file: '/etc/cez-process-wait.exit' })).rejects.toMatchObject({ code: 'exit_file_outside' });
    const answer = await manager.cezarToolHandlers(run.id, generationOf(run.id)).registerWait({ kind: 'process', pid: sleeper(), exit_file: '../../x.exit', timeout_seconds: 60 }, 'cezar_wait', new AbortController().signal);
    expect(answer.answer).toMatchObject({ ok: false, code: 'exit_file_outside', message: expect.stringContaining('worktree') });
    const interval = vi.spyOn(semaphore, 'monitoringWakeIntervalMinutes').mockReturnValue(null);
    await expect(register(run.id, { pid: sleeper() })).rejects.toMatchObject({ code: 'timers_disabled' });
    interval.mockReturnValue(5);
    store.updateRun(run.id, { automaticWakes: 40 });
    await expect(register(run.id, { pid: sleeper() })).rejects.toMatchObject({ code: 'wake_budget_spent' });
    expect(store.getRun(run.id)?.waits?.filter(wait => wait.kind === 'process')).toEqual([]);
  });

  it('a PID already gone registers and resolves exited at once; its watch is aborted', async () => {
    const external = processes();
    const run = await waitingParent();
    const proc = spawn('true'); await new Promise(resolve => proc.once('exit', resolve));
    const wait = await register(run.id, { pid: proc.pid!, note: 'fast' });
    expect(wait.startToken).toBeUndefined();
    await until(() => settledById(run.id, wait.id)?.phase === 'delivered');
    expect(inputsFor(run.id, wait.id).map(input => input.text)).toEqual([expect.stringContaining(`PID ${proc.pid} (fast): exited, code unknown`)]);
    expect(external.watches.every(watch => watch.signal.aborted)).toBe(true);
  });

  it('a repeat returns the open wait; a park keeps the slot; the result is delivered and charged as one automatic wake', async () => {
    const external = processes();
    const run = await waitingParent();
    const pid = sleeper();
    const wait = await register(run.id, { pid, exit_file: 'build.exit', note: 'build' });
    expect(wait).toMatchObject({ kind: 'process', pid, note: 'build', startToken: expect.any(String), exitFile: join(store.getRun(run.id)!.worktreePath!, 'build.exit') });
    expect((await register(run.id, { pid, exit_file: 'build.exit', timeout_seconds: 60 })).id).toBe(wait.id);
    expect(external.watches).toHaveLength(1);
    expect(external.watches[0]!.request).toMatchObject({ pid, startToken: wait.startToken, exitFile: wait.exitFile, deadline: wait.deadline });
    await until(() => store.getRun(run.id)?.status === 'waiting' && runInternals(manager).line.monitoring.has(run.id));
    const spentBefore = store.getRun(run.id)?.automaticWakes ?? 0;
    external.settle({ outcome: 'exit_file', exitCode: 0 });
    await until(() => settledById(run.id, wait.id)?.phase === 'delivered');
    const settled = settledById(run.id, wait.id) as ProcessWaitEntry;
    expect(inputsFor(run.id, wait.id).map(input => input.text)).toEqual([waitResultText(settled)]);
    expect(waitResultText(settled)).toContain('exited with code 0');
    // The no-wait nudges count too (hearsay-tools/cezarion#1234): the process wake is the next unit.
    await until(() => notes(run.id, 'automatic process wake-up (').length === 1);
    expect(notes(run.id, `automatic process wake-up (${spentBefore + 1}/40)`)).toHaveLength(1);
  });

  it('a resolution at the spent budget is cancelled with the cap note and the run waits on the user', async () => {
    const external = processes();
    const run = await waitingParent();
    const wait = await register(run.id, { pid: sleeper() });
    await until(() => store.getRun(run.id)?.status === 'waiting');
    store.updateRun(run.id, { automaticWakes: 40 });
    external.settle({ outcome: 'exited' });
    await until(() => settledById(run.id, wait.id)?.phase === 'cancelled');
    expect(notes(run.id, `automatic process wake-up cap reached (40); process wait ${wait.id} cancelled`)).toHaveLength(1);
    expect(inputsFor(run.id, wait.id)).toEqual([]);
    await until(() => (store.getRun(run.id)?.waits ?? []).some((entry: Wait) => entry.kind === 'human' && entry.via === 'budget'));
  });

  // AGENTS.md "Test the path with no live session": the cap at a resolution after a clean close.
  it('a resolution at the spent budget with no live session is cancelled and opens the budget human wait', async () => {
    const external = processes();
    const run = await waitingParent();
    const wait = await register(run.id, { pid: sleeper() });
    (manager as unknown as { active: Map<string, { session: { end(): void } }> }).active.get(run.id)!.session.end();
    await until(() => !manager.isActive(run.id));
    store.updateRun(run.id, { automaticWakes: 40 });
    external.settle({ outcome: 'exited' });
    await until(() => settledById(run.id, wait.id)?.phase === 'cancelled');
    expect(notes(run.id, `automatic process wake-up cap reached (40); process wait ${wait.id} cancelled`)).toHaveLength(1);
    await until(() => (store.getRun(run.id)?.waits ?? []).some((entry: Wait) => entry.kind === 'human' && entry.via === 'budget' && entry.askSeq !== undefined));
    expect(store.getRun(run.id)?.status).toBe('waiting');
    expect(inputsFor(run.id, wait.id)).toEqual([]);
    expect(manager.isActive(run.id)).toBe(false);
  });

  it('Stop cancels the wait and aborts its watch, and signals nothing', async () => {
    const external = processes();
    const run = await waitingParent();
    const pid = sleeper();
    const wait = await register(run.id, { pid });
    manager.cancel(run.id);
    await until(() => settledById(run.id, wait.id)?.phase === 'cancelled');
    expect(external.watches[0]!.signal.aborted).toBe(true);
    expect(() => process.kill(pid, 0)).not.toThrow();
  });

  it('after a restart with no live session the wait is watched again and its result reopens the run', async () => {
    const external = processes();
    const run = await waitingParent();
    const pid = sleeper();
    const wait = await register(run.id, { pid, note: 'after restart' });
    await restart();
    expect(manager.isActive(run.id)).toBe(false);
    await until(() => external.watches.length === 2);
    expect(external.watches[1]!.request).toMatchObject({ pid, startToken: wait.startToken, deadline: wait.deadline });
    expect(waitById(run.id, wait.id)?.phase).toBe('open');
    external.settle({ outcome: 'exited' });
    await until(() => settledById(run.id, wait.id)?.phase === 'delivered');
    expect(inputsFor(run.id, wait.id).map(input => input.text)).toEqual([expect.stringContaining('(after restart): exited, code unknown')]);
  });
});
