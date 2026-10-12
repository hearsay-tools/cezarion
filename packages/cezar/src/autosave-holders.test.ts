import * as childProcess from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as liveness from './delegation/process-liveness.ts';
import { AUTOSAVE_OWNER_ENV, watchAutosaveHolders, type OwnerProbe } from './autosave-holders.ts';
import { autosaveGit } from './autosave-git.ts';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFile: vi.fn(),
}));

describe('autosave cwd-holder proof', () => {
  let candidates: number[] | 'unknown';
  let tokens: Map<number, string>;
  /** Linux owner facts per pid; a pid without an entry is a marked Git descendant. */
  let owners: Map<number, Awaited<ReturnType<OwnerProbe>>>;
  const probe: OwnerProbe = async pid => owners.get(pid) ?? { marked: true, parent: 1 };
  const owner = { marker: 'marker', root: () => 900 };
  const watch = (cwd = '/worktree') => watchAutosaveHolders(cwd, owner, probe);
  beforeEach(() => {
    owners = new Map();
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
    expect(await watch()).toBeUndefined();
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
    const pending = (await watchAutosaveHolders('/worktree', owner))!;
    expect(await pending()).toBe(true);
  });
  it('a Darwin process lsof could not read is no holder (hearsay-tools/cezarion#889)', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    let scans = 0;
    vi.mocked(childProcess.execFile).mockImplementation(((command: string, args: string[], _options: unknown, callback: (error: null, stdout: string) => void) => {
      // 505 appears in ps from the second scan on, but lsof never reports its cwd.
      const stdout = command === 'lsof' ? 'p404\nn/elsewhere\n'
        : args.includes('-p') ? 'S Tue Sep 29 10:00:00 2026\n'
        : `404 Tue Sep 29 09:00:00 2026\n${++scans > 1 ? '505 Tue Sep 29 10:00:00 2026\n' : ''}`;
      queueMicrotask(() => callback(null, stdout));
      return { pid: command === 'lsof' ? 801 : 802 };
    }) as unknown as typeof childProcess.execFile);
    const pending = (await watch())!;
    expect(await pending()).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
  it('ignores a new holder that is not Git\'s and never re-reads it (hearsay-tools/cezarion#958)', async () => {
    const reads = vi.fn(probe);
    const pending = (await watchAutosaveHolders('/worktree', owner, reads))!;
    candidates = [101, 202]; tokens.set(202, 'squeal-worker'); owners.set(202, { marked: false, parent: 77 }); owners.set(77, { marked: false, parent: 1 });
    expect(await pending()).toBe(false);
    expect(await pending()).toBe(false);
    expect(reads.mock.calls.filter(([pid]) => pid === 202)).toHaveLength(1);
    expect((pending as unknown as { diagnostics: () => { pids: number[] } }).diagnostics().pids).toEqual([]);
  });
  it('attributes an unmarked child of Git or of an attributed holder', async () => {
    const pending = (await watch())!;
    candidates = [101, 202, 303]; tokens.set(202, 'env-cleared'); tokens.set(303, 'grandchild');
    owners.set(202, { marked: false, parent: 900 }); owners.set(303, { marked: false, parent: 202 });
    expect(await pending()).toBe(true);
    expect((pending as unknown as { diagnostics: () => { pids: number[] } }).diagnostics().pids).toEqual([202, 303]);
  });
  it('attributes an unmarked child whose parent outside the worktree carries the marker', async () => {
    const pending = (await watch())!;
    candidates = [101, 202]; tokens.set(202, 'child'); owners.set(202, { marked: false, parent: 404 });
    expect(await pending()).toBe(true);
  });
  it('fails closed on an environment it cannot read', async () => {
    const pending = (await watch())!;
    candidates = [101, 202]; tokens.set(202, 'hidden'); owners.set(202, { parent: 77 });
    expect(await pending()).toBe(true);
  });
  it('skips a candidate that exits before its owner is read', async () => {
    const pending = (await watch())!;
    candidates = [101, 202]; tokens.set(202, 'brief'); owners.set(202, 'gone');
    expect(await pending()).toBe(false);
  });
  it('reads the Darwin marker from ps and fails closed when ps hides the environment', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    vi.spyOn(process, 'kill').mockReturnValue(true);
    let scans = 0;
    const environment: Record<number, string> = {
      303: `1 node squeal.js PATH=/usr/bin HOME=/Users/a\n`,
      404: `1 git hook PATH=/usr/bin ${AUTOSAVE_OWNER_ENV}=marker\n`,
      505: `1 /usr/libexec/hardened\n`,
    };
    vi.mocked(childProcess.execFile).mockImplementation(((command: string, args: string[], _options: unknown, callback: (error: null, stdout: string) => void) => {
      const pid = Number(args.at(-1));
      const stdout = command === 'lsof'
        ? (++scans === 1 ? 'p999\nn/elsewhere\n' : 'p303\nn/worktree\np404\nn/worktree\np505\nn/worktree\n')
        : args.includes('-E') ? environment[pid]!
        : args.includes('-p') ? 'S Tue Sep 29 10:00:00 2026\n' : '303 Tue Sep 29 10:00:00 2026\n404 Tue Sep 29 10:00:00 2026\n505 Tue Sep 29 10:00:00 2026\n';
      queueMicrotask(() => callback(null, stdout));
      return { pid: command === 'lsof' ? 801 : 802 };
    }) as unknown as typeof childProcess.execFile);
    const pending = (await watchAutosaveHolders('/worktree', owner))!;
    expect(await pending()).toBe(true);
    expect((pending as unknown as { diagnostics: () => { pids: number[] } }).diagnostics().pids).toEqual([404, 505]);
  });
  it('excludes only the same pre-existing incarnation', async () => {
    const pending = (await watch())!;
    expect(await pending()).toBe(false);
    tokens.set(101, 'replacement');
    expect(await pending()).toBe(true);
  });
  it('retains an observed holder after it leaves the working directory', async () => {
    const pending = (await watch())!;
    candidates = [101, 202]; tokens.set(202, 'child');
    expect(await pending()).toBe(true);
    candidates = [101];
    expect(await pending()).toBe(true);
    tokens.delete(202);
    expect(await pending()).toBe(false);
  });
  it('tracks a reused observed pid as a new incarnation', async () => {
    const pending = (await watch())!;
    candidates = [101, 202]; tokens.set(202, 'first-child');
    expect(await pending()).toBe(true);
    tokens.set(202, 'second-child');
    expect(await pending()).toBe(true);
    tokens.delete(202); candidates = [101];
    expect(await pending()).toBe(false);
  });
  it('refuses an unknown baseline and retains the guard on a later unknown scan', async () => {
    const pending = (await watch())!;
    candidates = 'unknown';
    expect(await pending()).toBe(true);
    expect(await watch()).toBeUndefined();
    candidates = [101];
    expect(await pending()).toBe(false);
  });
});
