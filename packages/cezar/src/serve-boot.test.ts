import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORKTREE_RETENTION } from './config.ts';
import { reconcileServeWorktrees, recoverServeProject, warnServeBind, createServeApplicationUpdate, printServeBanner, restartServe, stopServe } from './serve-boot.ts';
import { spawnSessionLeader } from './core/session-process.ts';
import type { RunStore } from './runs/store.ts';
import type { RunManager } from './workflows/run.ts';
import type { getRepoInfo } from './server/git.ts';
import type { DelegationController } from './delegation/provision.ts';
import type { ProviderRuntimeAuthObserver } from './server/provider-auth-runtime.ts';
import type { detectEnvironment } from './core/backend-detect.ts';
import type { startServer } from './server/server.ts';
import { ApplicationUpdateService } from './application-update/service.ts';
import { armRestartHelper } from './application-update/launcher.ts';

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
  return { store, manager, repo, steps };
}

describe('reconcileServeWorktrees', () => {
  it.each(['no repo', 'unavailable store'])('skips reconciliation with %s', async (reason) => {
    const { store, manager, repo, steps } = reconcileFixture(reason === 'unavailable store');
    await reconcileServeWorktrees('/repo', reason === 'no repo' ? null : repo, store, manager, undefined, steps);
    expect(store.listRunIds).not.toHaveBeenCalled();
    expect(steps.pruneOrphans).not.toHaveBeenCalled();
    expect(steps.resolveWorktreeRetention).not.toHaveBeenCalled();
    expect(steps.reclaimWorktrees).not.toHaveBeenCalled();
    expect(steps.sweepMergedBranches).not.toHaveBeenCalled();
    expect(steps.log).not.toHaveBeenCalled();
  });

  it('keeps step order, output, live ids and the resolved sweep retention', async () => {
    const { store, manager, repo, steps } = reconcileFixture();
    steps.pruneOrphans.mockResolvedValue(['12345678-orphan', 'abcdefgh-orphan']);
    steps.reclaimWorktrees.mockResolvedValue(['87654321-old']);
    // A sweep can remain pending without delaying boot.
    steps.sweepMergedBranches.mockReturnValue(new Promise(() => {}));
    await reconcileServeWorktrees('/repo', repo, store, manager, undefined, steps);
    expect(steps.pruneOrphans).toHaveBeenCalledWith('/repo', new Set(['live-run']));
    expect(steps.reclaimWorktrees).toHaveBeenCalledWith('/repo', store, 7, { previewHost: undefined });
    expect(steps.sweepMergedBranches).toHaveBeenCalledWith({ root: '/repo', store, manager }, { keep: 7 });
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
      const { store, manager, repo, steps } = reconcileFixture();
      steps[failedStep].mockRejectedValue(new Error('unavailable'));
      await reconcileServeWorktrees('/repo', repo, store, manager, undefined, steps);
      const keep = failedStep === 'resolveWorktreeRetention' ? DEFAULT_WORKTREE_RETENTION : 7;
      expect(steps.reclaimWorktrees).toHaveBeenCalledWith('/repo', store, keep, { previewHost: undefined });
      expect(steps.sweepMergedBranches).toHaveBeenCalledWith({ root: '/repo', store, manager }, { keep });
      expect(steps.log).not.toHaveBeenCalled();
    },
  );
});

vi.mock('./application-update/service.ts', () => ({ ApplicationUpdateService: vi.fn(class {}) }));
vi.mock('./application-update/launcher.ts', () => ({ armRestartHelper: vi.fn() }));

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
      '\n  ⚠ binding 0.0.0.0:4321 — cezar has no built-in auth.\n' +
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
      ['\n  cezar v1.2.3 — /repo'],
      [repo ? '  branch main' : '  not a git repository (tasks run in place, one at a time; repo view is empty)'],
      ['  ✓ claude v1'], ['  ✓ codex  ok'], ['  ✗ git    install it'], ['  ✗ gh     missing'],
      ['\n  cockpit → http://localhost:4321\n'],
    ]);
  });
});

describe('createServeApplicationUpdate', () => {
  it('degrades to manual update without npm metadata', () => {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    expect(createServeApplicationUpdate('/repo', {}, vi.fn(), () => undefined)).toBeUndefined();
    expect(ApplicationUpdateService).not.toHaveBeenCalled();
  });

  it('keeps callbacks late-bound to the server and update', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    const update: { latest?: string } = {};
    const getServer = vi.fn();
    const readNpm = vi.fn(() => ({ prefix: '/prefix', cache: '/cache', npmBin: '/bin/npm' }));
    createServeApplicationUpdate('/repo', update, getServer, readNpm);
    expect(getServer).not.toHaveBeenCalled();
    const options = vi.mocked(ApplicationUpdateService).mock.calls[0]![0];
    expect(options).toMatchObject({ npmPrefix: '/prefix', npmCache: '/cache', npmBin: '/bin/npm', dryRun: false });
    update.latest = '2.0.0';
    expect(options.targetVersion()).toBe('2.0.0');
    const shutdownForRestart = vi.fn().mockResolvedValue(undefined);
    const server = { address: () => ({ address: '127.0.0.1', port: 4321 }), shutdownForRestart } as unknown as ReturnType<typeof startServer>;
    getServer.mockReturnValue(server);
    const plan = {} as Parameters<typeof armRestartHelper>[0];
    await options.armRestart!(plan);
    expect(armRestartHelper).toHaveBeenCalledWith(plan, { repoRoot: '/repo', host: '127.0.0.1', port: 4321, npmBin: '/bin/npm' });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    options.handoff!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 10_000 });
    expect(shutdownForRestart).toHaveBeenCalledOnce();
  });

  it('uses dry-run defaults when npm is missing', () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    createServeApplicationUpdate('/repo', {}, vi.fn(), () => undefined);
    const options = vi.mocked(ApplicationUpdateService).mock.calls[0]![0];
    expect(options.dryRun).toBe(true);
    expect(options.npmPrefix).toMatch(/dry-prefix$/);
    expect(options.npmCache).toMatch(/dry-cache$/);
  });
});

// Agents lead their own process groups, so the server's shutdown does not reach them. A restart
// that left one running would hand its run and worktree to the replacement while it still writes.
describe.skipIf(process.platform === 'win32')('restartServe', () => {
  it('signals every live agent session group after the server shut down, then restarts', async () => {
    const agent = spawnSessionLeader('sh', ['-c', 'trap "exit 0" TERM; echo ready; while :; do sleep 1; done'], { cwd: process.cwd(), env: process.env });
    const exited = new Promise<NodeJS.Signals | number | null>((resolve) => agent.once('exit', (code, signal) => resolve(signal ?? code)));
    // The stub prints only after its trap is set, so a SIGTERM before then cannot kill it outright.
    await new Promise<void>((resolve) => agent.stdout.on('data', (chunk: Buffer) => { if (chunk.toString().includes('ready')) resolve(); }));
    const order: string[] = [];
    const server = {
      address: () => ({ address: '127.0.0.1', family: 'IPv4', port: 4321 }),
      shutdownForRestart: vi.fn(async () => { order.push(`shutdown, agent running: ${agent.exitCode === null && agent.signalCode === null}`); }),
    };
    const restart = vi.fn(() => { order.push('restart'); });
    try {
      await restartServe(server, restart);
      // bound: the stub exits within milliseconds of its SIGTERM; the bound lets `finally` reap it when none came
      const outcome = await Promise.race([exited, new Promise<string>((resolve) => setTimeout(() => resolve('still running'), 10_000))]);
      expect(outcome).toBe(0);
      expect(order).toEqual(['shutdown, agent running: true', 'restart']);
      expect(restart).toHaveBeenCalledWith(expect.objectContaining({ server: null, port: 4321 }));
    } finally {
      if (agent.exitCode === null && agent.signalCode === null) agent.kill('SIGKILL');
    }
  });
});

// The stop every serve exit runs. A listener that never closes (a preview upgrade it still holds)
// or a step that throws must not keep the store open or the agents running.
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
