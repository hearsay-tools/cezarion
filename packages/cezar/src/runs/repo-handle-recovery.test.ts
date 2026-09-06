import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { armRepoHandle } from './arm-repo-handle.ts';
import { RunStore } from './store.ts';
import { __clearRepoHandleCacheForTests, resolveRepoHandle } from '../server/forge/github.ts';

const foreignPr = 'https://github.com/other/repo/pull/42';
const foreignIssue = 'https://github.com/other/repo/issues/43';
type Callback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;
const reply = (error: Error | null, stdout = 'acme/service') => (...args: unknown[]) => {
  (args.at(-1) as Callback)(error, { stdout, stderr: '' });
};

describe('live repository identity recovery', () => {
  let root: string;
  let store: RunStore;
  let controller: AbortController;
  beforeEach(() => {
    vi.useFakeTimers();
    execFileMock.mockReset();
    __clearRepoHandleCacheForTests();
    root = mkdtempSync(join(tmpdir(), 'cez-repo-recovery-'));
    store = RunStore.open(root);
    controller = new AbortController();
  });
  afterEach(() => {
    controller.abort();
    store.flush();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });
  const create = (s: RunStore, task = 'research') => s.createRun({ title: 'task', workflow: 'w', task, steps: [] });

  it('recovers without restart, repairs persisted records, and scopes new events while retaining evidence and ownership', async () => {
    execFileMock.mockImplementationOnce(reply(new Error('network is unreachable'))).mockImplementation(reply(null));
    const old = create(store);
    store.appendEvent(old.id, { type: 'result', result: `${foreignPr} ${foreignIssue}` });
    const owned = create(store);
    store.updateRun(owned.id, { referencedIssueUrl: foreignIssue, issueNumber: 99 });
    const explicit = create(store, `Work on ${foreignPr}`);
    store.appendEvent(explicit.id, { type: 'result', result: foreignPr });
    store.flush();
    // Recovery must heal retained records too, not just runs created in this process.
    store = RunStore.open(root);
    expect(armRepoHandle(store, root, controller.signal)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(999);
    expect(store.getRun(old.id)?.referencedPullRequestUrl).toBe(foreignPr);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getRun(old.id)?.referencedPullRequestUrl).toBeUndefined();
    expect(store.getRun(old.id)?.referencedIssueUrl).toBeUndefined();
    expect(store.getRun(old.id)?.issueNumber).toBeUndefined();
    expect(store.getRun(old.id)?.referencedPrCandidates).toEqual([foreignPr]);
    expect(store.getRun(old.id)?.referencedIssueCandidates).toEqual([foreignIssue]);
    expect(store.getRun(owned.id)?.issueNumber).toBe(99);
    expect(store.getRun(explicit.id)?.referencedPullRequestUrl).toBe(foreignPr);
    const saved = JSON.parse(readFileSync(join(root, 'runs.json'), 'utf8'));
    expect(saved.find((r: { id: string }) => r.id === old.id).referencedPullRequestUrl).toBeUndefined();
    const fresh = create(store);
    store.appendEvent(fresh.id, { type: 'result', result: foreignPr });
    expect(store.getRun(fresh.id)?.referencedPullRequestUrl).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }),
    new Error('fatal: not a git repository (or any of the parent directories): .git'),
    new Error('no git remotes found'),
    new Error('none of the git remotes configured for this repository point to a known GitHub host'),
  ])('does not reprobe permanent unknown: %s', async (error) => {
    execFileMock.mockImplementation(reply(error));
    armRepoHandle(store, root, controller.signal);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const run = create(store);
    store.appendEvent(run.id, { type: 'result', result: foreignPr });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBe(foreignPr);
  });

  it.each([
    Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }),
    new Error('no git remotes found'),
  ])('lets a later cold-index caller discover identity after local absence: %s', async (error) => {
    execFileMock.mockImplementation(reply(error));
    armRepoHandle(store, root, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    execFileMock.mockImplementation(reply(null)); // gh installed or a remote added
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execFileMock).toHaveBeenCalledTimes(1); // live background discovery has stopped
    expect(await resolveRepoHandle(root)).toEqual({ owner: 'acme', name: 'service' });
    expect(execFileMock).toHaveBeenCalledTimes(2); // demand-driven cold lookup can recover
  });

  it('does not retry malformed identity and reuses the permanent negative for another store', async () => {
    execFileMock.mockImplementation(reply(null, 'not/a/valid/slug'));
    armRepoHandle(store, root, controller.signal);
    await vi.advanceTimersByTimeAsync(60_000);
    armRepoHandle(store, root, controller.signal);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it.each(['HTTP 503', 'HTTP 401: Bad credentials', 'HTTP 404: Not Found', 'connect ETIMEDOUT'])(
    'bounds retryable failure %s to three attempts separated by 1s and 5s', async (message) => {
    execFileMock.mockImplementation(reply(new Error(message)));
    armRepoHandle(store, root, controller.signal);
    await vi.advanceTimersByTimeAsync(999);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4999);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(execFileMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execFileMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reuses successful discovery from another caller during retry delay', async () => {
    execFileMock.mockImplementationOnce(reply(new Error('timeout'))).mockImplementation(reply(null));
    armRepoHandle(store, root, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    await resolveRepoHandle(root);
    await vi.advanceTimersByTimeAsync(1000);
    const run = create(store);
    store.appendEvent(run.id, { type: 'result', result: foreignPr });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBeUndefined();
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending retry when the owner exits', async () => {
    execFileMock.mockImplementation(reply(new Error('network is unreachable')));
    armRepoHandle(store, root, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('does not start discovery for an already disposed owner', async () => {
    execFileMock.mockImplementation(reply(null));
    controller.abort();
    armRepoHandle(store, root, controller.signal);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('rejects late results from an aborted retry in both the cache and stale store', async () => {
    let release!: Callback;
    execFileMock.mockImplementationOnce(reply(new Error('timeout'))).mockImplementationOnce((...args: unknown[]) => {
      release = args.at(-1) as Callback;
      expect((args[2] as { signal: AbortSignal }).signal).toBe(controller.signal);
    });
    const run = create(store);
    store.appendEvent(run.id, { type: 'result', result: foreignPr });
    armRepoHandle(store, root, controller.signal);
    await vi.advanceTimersByTimeAsync(1000);
    expect(release).toBeTypeOf('function');
    controller.abort();
    store.flush();
    const before = readFileSync(join(root, 'runs.json'), 'utf8');
    execFileMock.mockImplementation(reply(null, 'replacement/repo'));
    expect(await resolveRepoHandle(root)).toEqual({ owner: 'replacement', name: 'repo' });
    release(null, { stdout: 'acme/service', stderr: '' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await resolveRepoHandle(root)).toEqual({ owner: 'replacement', name: 'repo' });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBe(foreignPr);
    expect(readFileSync(join(root, 'runs.json'), 'utf8')).toBe(before);
  });
});
