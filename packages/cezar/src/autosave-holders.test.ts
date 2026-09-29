import * as childProcess from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as liveness from './delegation/process-liveness.ts';
import { watchAutosaveHolders } from './autosave-holders.ts';
import { autosaveGit } from './autosave-git.ts';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFile: vi.fn(),
}));

describe('autosave cwd-holder proof', () => {
  let candidates: number[] | 'unknown';
  let tokens: Map<number, string>;
  beforeEach(() => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    candidates = [101];
    tokens = new Map([[101, 'existing']]);
    vi.spyOn(liveness, 'processesWithCwdUnder').mockImplementation(() => candidates);
    vi.spyOn(liveness, 'processStartToken').mockImplementation(pid => tokens.get(pid));
    vi.spyOn(liveness, 'recordedProcessLive').mockImplementation(entry => tokens.has(entry.pid) && tokens.get(entry.pid) === entry.startToken);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(['freebsd'] as const)('refuses %s before spawning without a termination proof', async platform => {
    vi.stubGlobal('process', { ...process, platform });
    expect(await watchAutosaveHolders('/worktree')).toBeUndefined();
    const spawn = vi.spyOn(childProcess, 'spawn');
    const warning = vi.fn();
    expect(await autosaveGit('/worktree', ['status'], { onWarning: warning })).toEqual({ ok: false, stdout: '', code: null });
    expect(spawn).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('no Git command started'));
  });
  it('retains a Darwin holder seen by lsof but missing from the independent ps snapshot', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    vi.spyOn(process, 'kill').mockReturnValue(true);
    let scans = 0;
    vi.mocked(childProcess.execFile).mockImplementation(((command: string, args: string[], _options: unknown, callback: (error: null, stdout: string) => void) => {
      const stdout = command === 'lsof'
        ? (++scans === 1 ? 'p404\nn/elsewhere\n' : 'p404\nn/elsewhere\np303\nn/worktree\n')
        : args.includes('-p') ? 'S Tue Sep 29 10:00:00 2026\n' : '404 Tue Sep 29 09:00:00 2026\n';
      queueMicrotask(() => callback(null, stdout));
      return { pid: command === 'lsof' ? 801 : 802 };
    }) as unknown as typeof childProcess.execFile);
    const pending = (await watchAutosaveHolders('/worktree'))!;
    expect(await pending()).toBe(true);
  });
  it('excludes only the same pre-existing incarnation', async () => {
    const pending = (await watchAutosaveHolders('/worktree'))!;
    expect(await pending()).toBe(false);
    tokens.set(101, 'replacement');
    expect(await pending()).toBe(true);
  });
  it('retains an observed holder after it leaves the working directory', async () => {
    const pending = (await watchAutosaveHolders('/worktree'))!;
    candidates = [101, 202]; tokens.set(202, 'child');
    expect(await pending()).toBe(true);
    candidates = [101];
    expect(await pending()).toBe(true);
    tokens.delete(202);
    expect(await pending()).toBe(false);
  });
  it('tracks a reused observed pid as a new incarnation', async () => {
    const pending = (await watchAutosaveHolders('/worktree'))!;
    candidates = [101, 202]; tokens.set(202, 'first-child');
    expect(await pending()).toBe(true);
    tokens.set(202, 'second-child');
    expect(await pending()).toBe(true);
    tokens.delete(202); candidates = [101];
    expect(await pending()).toBe(false);
  });
  it('refuses an unknown baseline and retains the guard on a later unknown scan', async () => {
    const pending = (await watchAutosaveHolders('/worktree'))!;
    candidates = 'unknown';
    expect(await pending()).toBe(true);
    expect(await watchAutosaveHolders('/worktree')).toBeUndefined();
    candidates = [101];
    expect(await pending()).toBe(false);
  });
});
