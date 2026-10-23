import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processStartToken } from '../delegation/process-liveness.ts';
import { ProcessWaitSupervisor, probeProcessWait, type ProcessWatchRequest } from './supervisor.ts';

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
  for (const proc of children.splice(0)) if (alive(proc)) proc.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

describe('ProcessWaitSupervisor', () => {
  it('resolves exit_file with the code the command wrote', async () => {
    const exitFile = join(root, 'build.exit');
    const proc = child(`sleep 0.2; echo 3 > ${exitFile}`);
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
    const proc = child('sleep 30');
    const abort = new AbortController();
    let settled = false;
    void supervisor().watch(request(proc), abort.signal).then(() => { settled = true; });
    abort.abort();
    proc.kill('SIGKILL');
    await new Promise<void>(resolve => proc.once('exit', () => resolve()));
    // bound: the poll interval is 20 ms; ten intervals pass with no settlement after the abort.
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(settled).toBe(false);
  });
});

describe('probeProcessWait', () => {
  it('reports a probe that throws as error, never as success', () => {
    const exitFile = join(root, 'x.exit');
    writeFileSync(exitFile, '0\n');
    const result = probeProcessWait({ pid: process.pid, exitFile, deadline: new Date(Date.now() + 60_000).toISOString(), roots: { worktree: join(root, 'missing-root') } }, Date.now());
    expect(result).toMatchObject({ outcome: 'error' });
    expect(result?.diagnostic?.length).toBeLessThanOrEqual(512);
  });
});
