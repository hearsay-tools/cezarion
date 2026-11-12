import { WAIT_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProcessWaitEntry, ProcessWaitResult, Wait } from '@open-mercato/cezar-contract';
import { ProcessWaitSupervisor, type ProcessWatchRequest } from '../process-wait/supervisor.ts';
import { manager, parent, restart, semaphore, store, toolGenerationOf, until, useWorkerWaitFixture, work } from './worker-wait-claude.testkit.ts';
import { waitResultText } from './waits.ts';

// Tool transport is exercised by adapter parity; lifecycle tests control only the CI supervisor.
vi.mock('../ci-wait/resources.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../ci-wait/resources.ts')>();
  return { acquireCiResources: (workspace: object) => ({ ...original.acquireCiResources(workspace), supervisor: { close() {} } }) };
});

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

const register = async (id: string, request: { pid: number; exit_file?: string; note?: string; timeout_seconds?: number }) =>
  await manager.registerWait(id, { kind: WAIT_KIND.process, timeout_seconds: 1800, ...request }, 'cezar_wait', toolGenerationOf(id)) as ProcessWaitEntry;
const waitById = (id: string, waitId: string) => store.getRun(id)?.waits?.find(entry => entry.id === waitId);
const settledById = (id: string, waitId: string) => store.getRun(id)?.lastWaits?.find(entry => entry.id === waitId);
const inputsFor = (id: string, waitId: string) => store.getRun(id)?.agentInputs?.filter(input => input.id === waitId) ?? [];
const notes = (id: string, text: string) => store.readEvents(id).filter(event => event.type === 'note' && String(event.message).includes(text));

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
    const answer = await manager.squawkToolHandlers(run.id, toolGenerationOf(run.id)).registerWait({ kind: WAIT_KIND.process, pid: sleeper(), exit_file: '../../x.exit', timeout_seconds: 60 }, 'cezar_wait', new AbortController().signal);
    expect(answer.answer).toMatchObject({ ok: false, code: 'exit_file_outside', message: expect.stringContaining('worktree') });
    // A batch that writes its own exit file elsewhere is waited on by PID alone, never through a watcher.
    expect(answer.answer).toMatchObject({ message: expect.stringContaining('leave exit_file out: wait on pid alone') });
    const interval = vi.spyOn(semaphore, 'monitoringWakeIntervalMinutes').mockReturnValue(null);
    await expect(register(run.id, { pid: sleeper() })).rejects.toMatchObject({ code: 'timers_disabled' });
    interval.mockReturnValue(5);
    store.updateRun(run.id, { automaticWakes: 40 });
    await expect(register(run.id, { pid: sleeper() })).rejects.toMatchObject({ code: 'wake_budget_spent' });
    expect(store.getRun(run.id)?.waits?.filter(wait => wait.kind === 'process')).toEqual([]);
  });

  it('a PID already gone registers and resolves at once as not running at registration; its watch is aborted', async () => {
    const external = processes();
    const run = await waitingParent();
    const proc = spawn('true'); await new Promise(resolve => proc.once('exit', resolve));
    const wait = await register(run.id, { pid: proc.pid!, note: 'fast' });
    expect(wait.startToken).toBeUndefined();
    await until(() => settledById(run.id, wait.id)?.phase === 'delivered');
    expect(inputsFor(run.id, wait.id).map(input => input.text)).toEqual([expect.stringContaining(`PID ${proc.pid} (fast): PID ${proc.pid} was not running when this wait was registered`)]);
    expect(external.watches.every(watch => watch.signal.aborted)).toBe(true);
  });

  it('a repeat returns the open wait; a park keeps the slot; the result is delivered and charged as one automatic wake', async () => {
    const external = processes();
    // Count a monitoring reservation as a regular slot so public capacity proves it is held.
    vi.spyOn(semaphore, 'maxMonitoringSessions').mockReturnValue(0);
    const run = await waitingParent();
    const pid = sleeper();
    const wait = await register(run.id, { pid, exit_file: 'build.exit', note: 'build' });
    expect(wait).toMatchObject({ kind: WAIT_KIND.process, pid, note: 'build', startToken: expect.any(String), exitFile: join(store.getRun(run.id)!.worktreePath!, 'build.exit') });
    expect((await register(run.id, { pid, exit_file: 'build.exit' })).id).toBe(wait.id);
    await expect(register(run.id, { pid, exit_file: 'build.exit', timeout_seconds: 60 })).rejects.toMatchObject({ code: 'duplicate_deadline', retainedWait: { id: wait.id, deadline: wait.deadline } });
    expect(external.watches).toHaveLength(1);
    expect(external.watches[0]!.request).toMatchObject({ pid, startToken: wait.startToken, exitFile: wait.exitFile, deadline: wait.deadline });
    await until(() => store.getRun(run.id)?.status === 'waiting' && semaphore.busy() === 1);
    expect(semaphore.busy()).toBe(1);
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

  it.each([7, 40])('three empty process deadlines leave a budget of %s unchanged', async budget => {
    const external = processes();
    const run = await waitingParent();
    const pid = sleeper();
    const waits = [];
    for (const note of ['one', 'two', 'three', 'anchor']) waits.push(await register(run.id, { pid, note, exit_file: `${note}.exit` }));
    store.updateRun(run.id, { automaticWakes: budget });
    for (let index = 0; index < 3; index++) {
      const wait = waits[index]!;
      external.settle({ outcome: 'deadline' }, index);
      await until(() => settledById(run.id, wait.id)?.phase === 'delivered');
      await until(() => store.getRun(run.id)?.status === 'waiting');
      expect(store.getRun(run.id)?.automaticWakes).toBe(budget);
      expect(waitById(run.id, waits[3]!.id)?.phase).toBe('open');
    }
    expect(notes(run.id, 'cap reached')).toEqual([]);
  });

  it('a batch with an empty deadline and a process exit still charges once', async () => {
    const external = processes();
    const run = await waitingParent();
    const pid = sleeper();
    const empty = await register(run.id, { pid, exit_file: 'empty.exit' });
    const completed = await register(run.id, { pid, exit_file: 'completed.exit' });
    await register(run.id, { pid, exit_file: 'anchor.exit' });
    store.updateRun(run.id, { automaticWakes: 7 });
    external.settle({ outcome: 'deadline' }, 0);
    external.settle({ outcome: 'exited' }, 1);
    await until(() => settledById(run.id, empty.id)?.phase === 'delivered' && settledById(run.id, completed.id)?.phase === 'delivered');
    expect(store.getRun(run.id)?.automaticWakes).toBe(8);
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

  // CODE_REVIEW.md § Changing working behavior (no live session): the cap at a resolution after a clean close.
  it('a resolution at the spent budget with no live session is cancelled and opens the budget human wait', async () => {
    const external = processes();
    const run = await waitingParent();
    const wait = await register(run.id, { pid: sleeper() });
    expect(work.liveSessions.size).toBe(1);
    [...work.liveSessions][0]!.end();
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
