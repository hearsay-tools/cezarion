import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processStartToken, recordedProcessLive } from '../delegation/process-liveness.ts';
import { ProcessWaitSupervisor, probeProcessWait, type ProcessWatchRequest } from './supervisor.ts';

vi.mock('../delegation/process-liveness.ts', async original => {
  const real = await original<typeof import('../delegation/process-liveness.ts')>();
  return { ...real, recordedProcessLive: vi.fn(real.recordedProcessLive) };
});

// hearsay-tools/cezarion#1446: the real poller against real child processes. Polls every 20 ms so
// each case ends on the child's own event; no case waits on a fixed delay.
let root: string;
const children: ChildProcess[] = [];
const supervisor = () => new ProcessWaitSupervisor({ pollMs: 20 });
const child = (script: string) => { const proc = spawn('sh', ['-c', script], { stdio: 'ignore' }); children.push(proc); return proc; };
const request = (proc: ChildProcess, over: Partial<ProcessWatchRequest> = {}): ProcessWatchRequest => ({
  pid: proc.pid!, startToken: processStartToken(proc.pid!), deadline: new Date(Date.now() + 60_000).toISOString(),
  roots: { worktree: root }, ...over,
});
const alive = (proc: ChildProcess) => proc.exitCode === null && proc.signalCode === null;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-process-wait-'))); });
afterEach(() => {
  vi.useRealTimers();
  for (const proc of children.splice(0)) if (alive(proc)) proc.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

describe('ProcessWaitSupervisor', () => {
  // hearsay-tools/squawk#2904: `echo 3 > file` creates the file before it writes the code. The
  // writer holds the empty file open across many polls, and none of them may settle the wait.
  it('resolves exit_file with the code the command wrote, not with the empty file before it', async () => {
    const exitFile = join(root, 'build.exit');
    const proc = child(`: > ${exitFile}; sleep 0.2; echo 3 > ${exitFile}`);
    const result = await supervisor().watch(request(proc, { exitFile }), new AbortController().signal);
    expect(result).toMatchObject({ outcome: 'exit_file', exitCode: 3 });
  });

  it('resolves exited when the process is killed without an exit file', async () => {
    const proc = child('sleep 30');
    const watching = supervisor().watch(request(proc, { exitFile: join(root, 'never.exit') }), new AbortController().signal);
    proc.kill('SIGKILL');
    expect(await watching).toMatchObject({ outcome: 'exited' });
    expect((await watching).exitCode).toBeUndefined();
  });

  it('resolves deadline while the process still runs, and leaves it running', async () => {
    const proc = child('sleep 30');
    const result = await supervisor().watch(request(proc, { deadline: new Date(Date.now() + 100).toISOString() }), new AbortController().signal);
    expect(result).toMatchObject({ outcome: 'deadline' });
    expect(alive(proc)).toBe(true);
  });

  it('never matches a reused PID: a different start token reads as exited', async () => {
    const proc = child('sleep 30');
    expect(await supervisor().watch(request(proc, { startToken: 'another-incarnation' }), new AbortController().signal)).toMatchObject({ outcome: 'exited' });
  });

  it('resolves at once from an exit file that already exists', async () => {
    const exitFile = join(root, 'old.exit');
    writeFileSync(exitFile, '0\n');
    const proc = child('sleep 30');
    expect(await supervisor().watch(request(proc, { exitFile }), new AbortController().signal)).toMatchObject({ outcome: 'exit_file', exitCode: 0 });
  });

  it('stops polling on abort and never settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const proc = child('sleep 30');
    const abort = new AbortController();
    let settled = false;
    void supervisor().watch(request(proc), abort.signal).then(() => { settled = true; });
    expect(vi.getTimerCount()).toBe(1);
    abort.abort();
    expect(vi.getTimerCount()).toBe(0);
    proc.kill('SIGKILL');
    await new Promise<void>(resolve => proc.once('exit', () => resolve()));
    // Ten poll intervals after the abort, on the fake clock: a poll left armed would see the exit.
    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe(false);
  });
});

describe('probeProcessWait', () => {
  it('reads the exit file again when the process is gone: a command writes it just before it ends', () => {
    const exitFile = join(root, 'late.exit');
    vi.mocked(recordedProcessLive).mockImplementationOnce(() => { writeFileSync(exitFile, '3\n'); return false; });
    const result = probeProcessWait({ pid: process.pid, exitFile, deadline: new Date(Date.now() + 60_000).toISOString(), roots: { worktree: root } }, Date.now());
    expect(result).toMatchObject({ outcome: 'exit_file', exitCode: 3 });
  });

  it('reports exited when the process is gone and its exit file is still empty', () => {
    const exitFile = join(root, 'empty.exit');
    writeFileSync(exitFile, '');
    vi.mocked(recordedProcessLive).mockReturnValueOnce(false);
    const result = probeProcessWait({ pid: process.pid, exitFile, deadline: new Date(Date.now() + 60_000).toISOString(), roots: { worktree: root } }, Date.now());
    expect(result).toMatchObject({ outcome: 'exited' });
  });

  it('reports a probe that throws as error, never as success', () => {
    const exitFile = join(root, 'x.exit');
    writeFileSync(exitFile, '0\n');
    const result = probeProcessWait({ pid: process.pid, exitFile, deadline: new Date(Date.now() + 60_000).toISOString(), roots: { worktree: join(root, 'missing-root') } }, Date.now());
    expect(result).toMatchObject({ outcome: 'error' });
    expect(result?.diagnostic?.length).toBeLessThanOrEqual(512);
  });
});
