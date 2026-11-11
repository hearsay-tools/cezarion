import { productName } from './home/display.ts';
import { testHome } from './home/test-home.testkit.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORKTREE_RETENTION } from './config.ts';
import { reconcileServeWorktrees, recoverServeProject, warnServeBind, printServeBanner, stopServe } from './serve-boot.ts';
import type { RunStore } from './runs/store.ts';
import type { RunManager } from './workflows/run.ts';
import type { getRepoInfo } from './server/git.ts';
import type { DelegationController } from './delegation/provision.ts';
import type { ProviderRuntimeAuthObserver } from './server/provider-auth-runtime.ts';
import type { detectEnvironment } from './core/backend-detect.ts';
import type { PreviewHost } from './preview/host.ts';

function reconcileFixture(unavailable = false) {
  const store = { unavailable, listRunIds: vi.fn(() => ['live-run']) } as unknown as RunStore;
  const manager = {} as RunManager;
  const repo = { root: '/repo' } as NonNullable<Awaited<ReturnType<typeof getRepoInfo>>>;
  const steps = {
    pruneOrphans: vi.fn().mockResolvedValue([]),
    resolveWorktreeRetention: vi.fn().mockResolvedValue(7),
    reclaimWorktrees: vi.fn().mockResolvedValue([]),
    sweepMergedBranches: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
  };
  return { store, manager, repo, steps, home: testHome() };
}

describe('reconcileServeWorktrees', () => {
  it.each(['no repo', 'unavailable store'])('skips reconciliation with %s', async (reason) => {
    const { store, manager, repo, steps, home } = reconcileFixture(reason === 'unavailable store');
    await reconcileServeWorktrees('/repo', reason === 'no repo' ? null : repo, store, manager, undefined, steps, home);
    expect(store.listRunIds).not.toHaveBeenCalled();
    expect(steps.pruneOrphans).not.toHaveBeenCalled();
    expect(steps.resolveWorktreeRetention).not.toHaveBeenCalled();
    expect(steps.reclaimWorktrees).not.toHaveBeenCalled();
    expect(steps.sweepMergedBranches).not.toHaveBeenCalled();
    expect(steps.log).not.toHaveBeenCalled();
  });

  it('keeps step order, output, live ids and the resolved sweep retention', async () => {
    const { store, manager, repo, steps, home } = reconcileFixture();
    steps.pruneOrphans.mockResolvedValue(['12345678-orphan', 'abcdefgh-orphan']);
    steps.reclaimWorktrees.mockResolvedValue(['87654321-old']);
    // A sweep can remain pending without delaying boot.
    steps.sweepMergedBranches.mockReturnValue(new Promise(() => {}));
    await reconcileServeWorktrees('/repo', repo, store, manager, undefined, steps, home);
    expect(steps.pruneOrphans).toHaveBeenCalledWith('/repo', new Set(['live-run']));
    expect(steps.reclaimWorktrees).toHaveBeenCalledWith('/repo', store, 7, { previewHost: undefined });
    expect(steps.sweepMergedBranches).toHaveBeenCalledWith({ root: '/repo', store, manager, home }, { keep: 7 });
    expect(steps.log.mock.calls).toEqual([
      ['  cleaned 2 orphaned worktree(s): 12345678, abcdefgh'],
      ['  reclaimed 1 old worktree(s), branch kept: 87654321'],
    ]);
    expect(steps.pruneOrphans).toHaveBeenCalledBefore(steps.resolveWorktreeRetention);
    expect(steps.resolveWorktreeRetention).toHaveBeenCalledBefore(steps.reclaimWorktrees);
    expect(steps.reclaimWorktrees).toHaveBeenCalledBefore(steps.sweepMergedBranches);
  });

  it.each(['pruneOrphans', 'resolveWorktreeRetention', 'reclaimWorktrees'] as const)(
    'keeps boot working when %s rejects', async (failedStep) => {
      const { store, manager, repo, steps, home } = reconcileFixture();
      steps[failedStep].mockRejectedValue(new Error('unavailable'));
      await reconcileServeWorktrees('/repo', repo, store, manager, undefined, steps, home);
      const keep = failedStep === 'resolveWorktreeRetention' ? DEFAULT_WORKTREE_RETENTION : 7;
      expect(steps.reclaimWorktrees).toHaveBeenCalledWith('/repo', store, keep, { previewHost: undefined });
      expect(steps.sweepMergedBranches).toHaveBeenCalledWith({ root: '/repo', store, manager, home }, { keep });
      expect(steps.log).not.toHaveBeenCalled();
    },
  );
});


afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

function recoveryFixture(unavailable = false) {
  const store = {
    unavailable,
    listRuns: vi.fn(() => ['queued', 'waiting', 'running', 'done'].map((status) => ({ status }))),
    compressArchivedHistory: vi.fn(),
  } as unknown as RunStore;
  const manager = { recover: vi.fn().mockResolvedValue(undefined) } as unknown as RunManager;
  const observer = {} as ProviderRuntimeAuthObserver;
  const armDestroyRetries = vi.fn();
  const delegation = { service: { armDestroyRetries } } as unknown as DelegationController;
  const recover = vi.fn(async (_store: RunStore, run: () => Promise<void>) => { await run(); });
  return { store, manager, observer, delegation, armDestroyRetries, recover };
}

describe('recoverServeProject', () => {
  it.each([undefined, 'project'])('recovers before compression and retries for %s', async (projectId) => {
    const f = recoveryFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await recoverServeProject(f.store, f.manager, f.observer, f.delegation, projectId, f.recover);
    expect(f.recover).toHaveBeenCalledWith(f.store, expect.any(Function), f.observer);
    expect(f.manager.recover).toHaveBeenCalledOnce();
    expect(f.manager.recover).toHaveBeenCalledBefore(vi.mocked(f.store.compressArchivedHistory));
    expect(f.store.compressArchivedHistory).toHaveBeenCalledBefore(f.armDestroyRetries);
    expect(f.armDestroyRetries).toHaveBeenCalledWith(projectId ?? 'default');
    expect(f.armDestroyRetries).toHaveBeenCalledBefore(log);
    expect(log).toHaveBeenCalledWith('  recovered 3 run(s) from the previous session');
  });

  it('skips unavailable recovery but keeps the existing count output', async () => {
    const f = recoveryFixture(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await recoverServeProject(f.store, f.manager, f.observer, f.delegation, undefined, f.recover);
    expect(f.recover).not.toHaveBeenCalled();
    expect(f.store.compressArchivedHistory).not.toHaveBeenCalled();
    expect(f.armDestroyRetries).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('  recovered 3 run(s) from the previous session');
  });

  it('prints nothing with no recovered runs', async () => {
    const f = recoveryFixture();
    vi.mocked(f.store.listRuns).mockReturnValue([]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await recoverServeProject(f.store, f.manager, f.observer, f.delegation, undefined, f.recover);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('warnServeBind', () => {
  it.each([undefined, '', '127.0.0.1', 'localhost', '::1'])('keeps %s quiet', (host) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnServeBind(host, 4321);
    expect(log).not.toHaveBeenCalled();
  });

  it('prints the exact warning for a public bind', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnServeBind('0.0.0.0', 4321);
    expect(log).toHaveBeenCalledWith(
      `\n  ⚠ binding 0.0.0.0:4321 — ${productName('cezar')} has no built-in auth.\n` +
      '    Only do this behind a reverse proxy that enforces authentication,\n' +
      '    and make sure this interface is not reachable from the internet.\n',
    );
  });
});

describe('printServeBanner', () => {
  it.each([null, { branch: 'main' }])('prints environment details with repo %j', (repo) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const checks = [
      { name: 'claude', available: true, version: 'v1' },
      { name: 'codex', available: true },
      { name: 'git', available: false, hint: 'install it' },
      { name: 'gh', available: false },
    ] as Awaited<ReturnType<typeof detectEnvironment>>;
    printServeBanner('1.2.3', '/repo', repo as Awaited<ReturnType<typeof getRepoInfo>>, checks, 'http://localhost:4321');
    expect(log.mock.calls).toEqual([
      [`\n  ${productName('cezar')} v1.2.3 — /repo`],
      [repo ? '  branch main' : '  not a git repository (tasks run in place, one at a time; repo view is empty)'],
      ['  ✓ claude v1'], ['  ✓ codex  ok'], ['  ✗ git    install it'], ['  ✗ gh     missing'],
      ['\n  cockpit → http://localhost:4321\n'],
    ]);
  });
});

describe('stopServe', () => {
  it('stops waiting at its bound, then closes the store and signals the agents', async () => {
    const store = { close: vi.fn() };
    const forward = vi.fn();
    const server = { shutdownForRestart: vi.fn(() => new Promise<void>(() => undefined)) };
    await stopServe(server, 'SIGINT', { store, forward, boundMs: 50 });
    expect(store.close).toHaveBeenCalledOnce();
    expect(forward).toHaveBeenCalledWith('SIGINT');
  });

  it('closes the store and signals the agents when a shutdown step throws', async () => {
    const store = { close: vi.fn() };
    const forward = vi.fn();
    const server = { shutdownForRestart: vi.fn(async () => { throw new Error('delegation close failed'); }) };
    await expect(stopServe(server, 'SIGTERM', { store, forward })).resolves.toBeUndefined();
    expect(store.close).toHaveBeenCalledOnce();
    expect(forward).toHaveBeenCalledWith('SIGTERM');
  });

  it('leaves the store to a shutdown that finished, and still signals the agents last', async () => {
    const order: string[] = [];
    const store = { close: vi.fn() };
    const server = { shutdownForRestart: vi.fn(async () => { order.push('shutdown'); }) };
    await stopServe(server, 'SIGHUP', { store, forward: (signal) => order.push(`forward ${signal}`) });
    expect(store.close).not.toHaveBeenCalled();
    expect(order).toEqual(['shutdown', 'forward SIGHUP']);
  });
});

describe('serve boot mutation regressions', () => {
  it('passes the preview host to worktree reclamation', async () => {
    const f = reconcileFixture();
    const previewHost = {} as PreviewHost;
    await reconcileServeWorktrees('/repo', f.repo, f.store, f.manager, previewHost, f.steps, testHome());
    expect(f.steps.reclaimWorktrees).toHaveBeenCalledWith('/repo', f.store, 7, { previewHost });
  });

  it('uses SIGTERM by default and cancels its bound after successful shutdown', async () => {
    vi.useFakeTimers();
    try {
      const forward = vi.fn();
      await stopServe({ shutdownForRestart: vi.fn().mockResolvedValue(undefined) }, undefined, { forward });
      expect(forward).toHaveBeenCalledWith('SIGTERM');
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('allows shutdown to reject after its bound without an unhandled refusal', async () => {
    vi.useFakeTimers();
    try {
      let reject!: (reason: Error) => void;
      const shutdownForRestart = vi.fn(() => new Promise<void>((_resolve, refuse) => { reject = refuse; }));
      const forward = vi.fn();
      const stopping = stopServe({ shutdownForRestart }, 'SIGTERM', { forward, boundMs: 50 });
      await vi.advanceTimersByTimeAsync(50);
      await stopping;
      expect(forward).toHaveBeenCalledWith('SIGTERM');
      reject(new Error('late shutdown refusal'));
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
