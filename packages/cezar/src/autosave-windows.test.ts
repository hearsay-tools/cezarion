import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cp from 'node:child_process';
import { watchWindowsAutosave, windowsAutosaveProcessLive, windowsAutosaveProcessToken } from './autosave-windows.ts';
import { autosaveGit } from './autosave-git.ts';

vi.mock('node:child_process', async original => ({ ...await original<typeof cp>(), execFile: vi.fn(), execFileSync: vi.fn(), spawn: vi.fn() }));
const row = (pid: number, parent: number, token: string) => ({ pid, parent, token });
describe('Windows autosave process proof', () => {
  let rows: ReturnType<typeof row>[];
  let unknown: boolean;
  let commands: string[];
  beforeEach(() => {
    rows = []; unknown = false; commands = [];
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    vi.mocked(cp.execFile).mockImplementation(((file: string, args: string[], options: unknown, callback: Function) => {
      const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
      commands.push(script);
      queueMicrotask(() => callback(unknown ? new Error('probe failed') : null, script.includes('Get-CimInstance') ? JSON.stringify(rows) : ''));
      return { pid: 900 };
    }) as unknown as typeof cp.execFile);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it('durable recovery compares Windows creation tokens before retaining a reused PID', () => {
    vi.mocked(cp.execFileSync).mockReturnValue('2000');
    expect(windowsAutosaveProcessToken(101)).toBe('2000');
    expect(windowsAutosaveProcessLive({ pid: 101, startToken: '1000' })).toBe(false);
    expect(windowsAutosaveProcessLive({ pid: 101, startToken: '2000' })).toBe(true);
    vi.mocked(cp.execFileSync).mockReturnValue('gone');
    expect(windowsAutosaveProcessLive({ pid: 101, startToken: '2000' })).toBe(false);
    vi.mocked(cp.execFileSync).mockImplementation(() => { throw new Error('probe failed'); });
    expect(windowsAutosaveProcessLive({ pid: 101, startToken: '2000' })).toBe(true);
  });

  it('serializes observed Windows creation tokens for durable cleanup recovery', async () => {
    const proof = (await watchWindowsAutosave())!;
    rows = [row(100, 1, '1000'), row(101, 100, '1001')];
    await proof.alive(100, () => false);
    expect(proof.cleanupProof().processes).toContainEqual({ pid: 101, startToken: '1001' });
  });

  it('allows a healthy Git command and returns its output', async () => {
    vi.mocked(cp.spawn).mockImplementation((() => {
      const child = Object.assign(new EventEmitter(), { pid: 100, stdout: new PassThrough(), stderr: new PassThrough() });
      setImmediate(() => { child.stdout.write('clean'); child.emit('exit', 0); child.emit('close', 0); });
      return child;
    }) as unknown as typeof cp.spawn);
    expect(await autosaveGit('/worktree', ['status'], {})).toEqual({ ok: true, stdout: 'clean', code: 0 });
    expect(cp.spawn).toHaveBeenCalled();
  });
  it('bounds shutdown but waits for an observed child after a timeout', async () => {
    let child: EventEmitter;
    vi.mocked(cp.spawn).mockImplementation((() => {
      rows = [row(100, 1, '1000'), row(101, 100, '1001')];
      child = Object.assign(new EventEmitter(), { pid: 100, stdout: new PassThrough(), stderr: new PassThrough() });
      return child;
    }) as unknown as typeof cp.spawn);
    const warning = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let settled = false;
    const job = autosaveGit('/worktree', ['status'], { timeoutMs: 20, killGraceMs: 20, confirmMs: 20, onWarning: warning }).then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(commands.some(script => script.includes('.Kill()'))).toBe(true));
    child!.emit('exit', null); child!.emit('close', null);
    rows = [row(101, 100, '1001')];
    await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(expect.stringContaining('termination not confirmed')));
    expect(settled).toBe(false);
    rows = [];
    expect(await job).toEqual({ ok: false, stdout: '', code: null });
  });
  it('tracks children after leader exit and retains remembered grandchildren', async () => {
    const proof = (await watchWindowsAutosave())!;
    rows = [row(100, 1, '1000'), row(101, 100, '1001')];
    expect(await proof.alive(100, () => false)).toBe(true);
    rows = [row(101, 100, '1001'), row(102, 101, '1002')];
    expect(await proof.alive(100, () => true)).toBe(true);
    rows = [row(102, 101, '1002')];
    expect(await proof.alive(100, () => true)).toBe(true);
    rows = [];
    expect(await proof.alive(100, () => true)).toBe(false);
  });
  it('never treats reused PIDs and their new children as owned', async () => {
    const proof = (await watchWindowsAutosave())!;
    rows = [row(100, 1, '1000'), row(101, 100, '1001')];
    await proof.alive(100, () => false);
    rows = [row(101, 1, '2000'), row(102, 101, '2001')];
    expect(await proof.alive(100, () => true)).toBe(false);
  });
  it('rechecks leader exit after an async snapshot before claiming its PID', async () => {
    const proof = (await watchWindowsAutosave())!;
    rows = [row(100, 1, '2000')];
    let exited = false;
    const observing = proof.alive(100, () => exited);
    exited = true;
    expect(await observing).toBe(true);
    proof.stop(true);
    expect(commands.some(script => script.includes('Get-Process'))).toBe(false);
    rows = [];
    expect(await proof.alive(100, () => true)).toBe(false);
  });
  it('does not signal a child whose root incarnation was never observed', async () => {
    const proof = (await watchWindowsAutosave())!;
    rows = [row(101, 100, '1001')];
    expect(await proof.alive(100, () => true)).toBe(true);
    proof.stop(true);
    expect(commands.some(script => script.includes('Get-Process'))).toBe(false);
    rows = [];
    expect(await proof.alive(100, () => true)).toBe(false);
  });
  it('never signals a newly discovered child of an absent remembered parent', async () => {
    const proof = (await watchWindowsAutosave())!;
    rows = [row(100, 1, '1000'), row(101, 100, '1001')];
    await proof.alive(100, () => false);
    rows = [row(102, 101, '2001')];
    expect(await proof.alive(100, () => true)).toBe(true);
    proof.stop(true);
    expect(commands.some(script => script.includes('Get-Process'))).toBe(false);
    rows = [];
    expect(await proof.alive(100, () => true)).toBe(false);
  });
  it('does not borrow signal authority from a later parent incarnation', async () => {
    const proof = (await watchWindowsAutosave())!;
    rows = [row(100, 1, '1000'), row(101, 100, '1001')];
    await proof.alive(100, () => false);
    rows = [row(100, 1, '1000'), row(101, 100, '2000')];
    await proof.alive(100, () => false);
    rows = [row(101, 100, '2000'), row(102, 101, '1500')];
    expect(await proof.alive(100, () => true)).toBe(true);
    proof.stop(true);
    expect(commands.filter(script => script.includes('Get-Process')).join('')).not.toContain('-Id 102');
  });
  it('tracks a PID reused by a new child in the same family', async () => {
    const proof = (await watchWindowsAutosave())!;
    rows = [row(100, 1, '1000'), row(101, 100, '1001')];
    await proof.alive(100, () => false);
    rows = [row(100, 1, '1000'), row(101, 100, '2000')];
    await proof.alive(100, () => false);
    rows = [row(101, 100, '2000')];
    expect(await proof.alive(100, () => true)).toBe(true);
    rows = [];
    expect(await proof.alive(100, () => true)).toBe(false);
  });
  it('retains the guard on an unknown post-spawn probe and refuses an unknown baseline', async () => {
    const proof = (await watchWindowsAutosave())!;
    unknown = true;
    expect(await proof.alive(100, () => true)).toBe(true);
    expect(await watchWindowsAutosave()).toBeUndefined();
  });
  it('requests incarnation-checked shutdown without treating it as exit proof', async () => {
    const proof = (await watchWindowsAutosave())!;
    rows = [row(100, 1, '1000'), row(101, 100, '1001')];
    await proof.alive(100, () => false);
    proof.stop(true);
    expect(await proof.alive(100, () => true)).toBe(true);
    expect(commands.some(script => script.includes('Get-Process') && script.includes('[void]$p.Handle') && script.includes('$birth.Substring(0,$birth.Length-1)') && script.includes("-eq '100'") && script.includes('.Kill()'))).toBe(true);
    rows = [];
    expect(await proof.alive(100, () => true)).toBe(false);
  });
});
