import { projectPaths } from './project-paths.ts';
import { productName } from './home/display.ts';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { serveCommand, defaultServeDeps, type ServeDeps } from './serve-command.ts';
import { testHome } from './home/test-home.testkit.ts';
import type { WorkerCleanupFactory } from './delegation/service.ts';

type ManagerOptions = ConstructorParameters<ServeDeps['RunManager']>[2];

function fixture() {
  const home = testHome();
  const ownership = { acquire: vi.fn().mockResolvedValue(undefined), releaseAll: vi.fn(), publishUrl: vi.fn() };
  const semaphore = { refresh: vi.fn().mockResolvedValue(undefined) };
  const store = { close: vi.fn() };
  const webhooks = { attach: vi.fn() };
  const manager = {};
  const delegation = { attachProject: vi.fn(), service: { setDiscovery: vi.fn() } };
  const discovery = { models: {} };
  const events = { emit: vi.fn() };
  const listener = { address: vi.fn(() => ({ address: '127.0.0.1', port: 4322 })) };
  const server = Object.assign(new EventEmitter(), {
    listening: true,
    address: vi.fn<() => { address: string; port: number } | string | null>(() => ({ address: '127.0.0.1', port: 4322 })),
  });
  const processStub = Object.assign(new EventEmitter(), { exit: vi.fn(), send: vi.fn(), disconnect: vi.fn() });
  const effects = {
    ...defaultServeDeps,
    CockpitOwnership: vi.fn(function () { return ownership; }),
    acquireServeListener: vi.fn().mockResolvedValue(listener),
    initWorkspace: vi.fn().mockResolvedValue('boot-id'),
    WorkspaceSemaphore: vi.fn(function () { return semaphore; }),
    openBootStore: vi.fn(() => store),
    TaskWebhooks: vi.fn(function () { return webhooks; }),
    previewToolEnabled: vi.fn(() => false),
    PreviewHost: vi.fn(function () { return {}; }),
    ToolActivityTracker: vi.fn(function () { return {}; }),
    RunManager: vi.fn(function (_store: unknown, _root: string, _opts: ManagerOptions) { return manager; }),
    DelegationController: { start: vi.fn(async (_cleanup?: WorkerCleanupFactory) => delegation) },
    ProviderAuthService: vi.fn(function () { return {}; }),
    createHostDiscovery: vi.fn(() => discovery),
    WorkspaceEventBus: vi.fn(function () { return events; }),
    ProviderRuntimeAuthObserver: vi.fn(function (_auth: unknown, _notify: (status: unknown) => void) { return {}; }),
    readOwnVersion: vi.fn(() => '1.2.3'),
    readOwnName: vi.fn(() => '@wjarka/cezarion'),
    detectEnvironment: vi.fn().mockResolvedValue([]),
    getRepoInfo: vi.fn().mockResolvedValue(null),
    reconcileServeWorktrees: vi.fn().mockResolvedValue(undefined),
    recoverServeProject: vi.fn().mockResolvedValue(undefined),
    checkForUpdate: vi.fn().mockResolvedValue(undefined),
    warnServeBind: vi.fn(),
    startServer: vi.fn(() => server),
    printServeBanner: vi.fn(),
    stopServe: vi.fn().mockResolvedValue(undefined),
    onTerminal: vi.fn(() => true),
    ignoreHangupOffTerminal: vi.fn(),
    watchSupervisor: vi.fn(),
    waitForHealth: vi.fn().mockResolvedValue(true),
    openUrl: vi.fn(),
    sweepMergedBranches: vi.fn().mockResolvedValue(undefined),
    process: processStub,
    console: { log: vi.fn(), error: vi.fn() },
    workerCleanup: vi.fn<WorkerCleanupFactory>(),
  };
  const deps = effects as unknown as ServeDeps;
  const run = (openBrowser = false, restartExact = false, bindHost: string | undefined = undefined) => {
    return serveCommand(home, '/repo', 0, openBrowser, bindHost, restartExact, deps);
  };
  return { home, ownership, semaphore, store, webhooks, manager, delegation, discovery, events, listener, server, processStub, effects, deps, run };
}

describe('serveCommand', () => {
  it('starts delegation with worker cleanup, so a worker can be destroyed', async () => {
    const f = fixture();
    await f.run();
    expect(f.effects.DelegationController.start).toHaveBeenCalledWith(f.effects.workerCleanup);
  });

  it('holds ownership and the actual listener before workspace writes, then recovers before serving', async () => {
    const f = fixture();
    await f.run();
    expect(f.ownership.acquire).toHaveBeenCalledWith(projectPaths('/repo').write);
    expect(f.ownership.acquire).toHaveBeenCalledBefore(f.effects.acquireServeListener);
    expect(f.effects.acquireServeListener).toHaveBeenCalledWith(0, undefined);
    expect(f.effects.acquireServeListener).toHaveBeenCalledBefore(f.effects.initWorkspace);
    expect(f.effects.initWorkspace).toHaveBeenCalledBefore(f.semaphore.refresh);
    expect(f.semaphore.refresh).toHaveBeenCalledBefore(f.effects.openBootStore);
    expect(f.effects.openBootStore).toHaveBeenCalledBefore(f.webhooks.attach);
    expect(f.webhooks.attach).toHaveBeenCalledBefore(f.effects.RunManager);
    expect(f.effects.RunManager).toHaveBeenCalledBefore(f.delegation.attachProject);
    expect(f.effects.reconcileServeWorktrees).toHaveBeenCalledBefore(f.effects.recoverServeProject);
    expect(f.effects.recoverServeProject).toHaveBeenCalledBefore(f.effects.startServer);
    expect(f.effects.startServer).toHaveBeenCalledWith(expect.objectContaining({ store: f.store, manager: f.manager, bootProjectId: 'boot-id' }), 0, f.listener);
    expect(f.ownership.publishUrl).toHaveBeenCalledBefore(f.effects.printServeBanner);
    f.processStub.emit('exit');
    expect(f.ownership.releaseAll).toHaveBeenCalledOnce();
  });

  it('does no workspace work when listener acquisition fails', async () => {
    const f = fixture();
    f.effects.acquireServeListener.mockRejectedValue(new Error('occupied'));
    await expect(f.run()).rejects.toThrow('occupied');
    expect(f.effects.initWorkspace).not.toHaveBeenCalled();
    expect(f.effects.openBootStore).not.toHaveBeenCalled();
    expect(f.effects.startServer).not.toHaveBeenCalled();
  });

  it('gives recovery the held cockpit address and shares the later bound-port closure', async () => {
    const f = fixture();
    let portAtRecovery: number | undefined;
    f.effects.recoverServeProject.mockImplementation(async () => {
      portAtRecovery = f.effects.RunManager.mock.calls[0]![2]!.squawkPort?.();
    });
    await f.run();
    const options = f.effects.RunManager.mock.calls[0]![2]!;
    expect(options.cockpit).toEqual({ origin: 'http://127.0.0.1:4322', projectId: 'boot-id' });
    expect(portAtRecovery).toBeUndefined();
    expect(options.squawkPort?.()).toBe(4322);
    expect(f.delegation.attachProject).toHaveBeenCalledWith({ id: 'boot-id', root: '/repo', store: f.store, manager: f.manager, home: f.home });
    options.sweepBranches?.(7);
    expect(f.effects.sweepMergedBranches).toHaveBeenCalledWith(
      { root: '/repo', store: f.store, manager: f.manager, home: f.home },
      expect.objectContaining({ keep: 7 }),
    );
  });

  it('uses the default project identity when workspace registration is unavailable', async () => {
    const f = fixture();
    f.effects.initWorkspace.mockResolvedValue(undefined);
    await f.run();
    expect(f.webhooks.attach).toHaveBeenCalledWith({ id: 'default', root: '/repo', store: f.store });
    expect(f.effects.RunManager.mock.calls[0]![2]!.cockpit).toMatchObject({ projectId: 'default' });
    expect(f.delegation.attachProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'default' }));
  });

  it('keeps preview optional and publishes runtime provider changes', async () => {
    const f = fixture();
    f.effects.previewToolEnabled.mockReturnValue(true);
    await f.run();
    const notify = f.effects.ProviderRuntimeAuthObserver.mock.calls[0]![1];
    notify({ provider: 'codex' });
    expect(f.events.emit).toHaveBeenCalledWith('provider-status', { provider: 'codex' });
    expect(f.effects.PreviewHost).toHaveBeenCalledWith({ home: f.home });
    expect(f.effects.startServer).toHaveBeenCalledWith(expect.objectContaining({ previewHost: expect.any(Object) }), 0, f.listener);
  });

  it.each([true, false])('opens the browser only after health succeeds: %s', async (healthy) => {
    const f = fixture();
    f.effects.waitForHealth.mockResolvedValue(healthy);
    await f.run(true);
    expect(f.effects.printServeBanner).toHaveBeenCalledBefore(f.effects.waitForHealth);
    expect(f.effects.waitForHealth).toHaveBeenCalledWith('http://127.0.0.1:4322/api/v1/health', 5000);
    if (healthy) {
      expect(f.effects.waitForHealth).toHaveBeenCalledBefore(f.effects.openUrl);
      expect(f.effects.openUrl).toHaveBeenCalledWith('http://127.0.0.1:4322');
    } else expect(f.effects.openUrl).not.toHaveBeenCalled();
  });

  it('skips both the health wait and browser when opening is disabled', async () => {
    const f = fixture();
    await f.run();
    expect(f.effects.waitForHealth).not.toHaveBeenCalled();
    expect(f.effects.openUrl).not.toHaveBeenCalled();
  });

  it('waits for the server listening signal before publishing its address', async () => {
    const f = fixture();
    f.server.listening = false;
    f.effects.startServer.mockImplementation(() => {
      queueMicrotask(() => f.server.emit('listening'));
      return f.server;
    });
    await f.run();
    expect(f.server.listenerCount('listening')).toBe(0);
    expect(f.ownership.publishUrl).toHaveBeenCalledWith('http://127.0.0.1:4322');
  });

  it.each([null, 'pipe'])('rejects an unavailable TCP address: %s', async (address) => {
    const f = fixture();
    f.server.address.mockReturnValue(address);
    await expect(f.run()).rejects.toThrow('cockpit TCP listener is unavailable');
    expect(f.ownership.publishUrl).not.toHaveBeenCalled();
  });

  it('publishes an IPv6 URL and reports the exact restart listener before disconnecting', async () => {
    const f = fixture();
    f.server.address.mockReturnValue({ address: '::1', port: 5432 });
    await f.run(false, true);
    expect(f.processStub.send).toHaveBeenCalledWith({ type: 'application-update-listening', host: '::1', port: 5432, repoRoot: '/repo', version: '1.2.3' }, expect.any(Function));
    expect(f.ownership.publishUrl).toHaveBeenCalledWith('http://[::1]:5432');
    f.processStub.send.mock.calls[0]![1]();
    expect(f.processStub.disconnect).toHaveBeenCalledOnce();
  });

  it('performs one shutdown after repeated signals and waits for teardown before exit', async () => {
    const f = fixture();
    let finish!: () => void;
    f.effects.stopServe.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    await f.run();
    f.processStub.emit('SIGINT');
    f.processStub.emit('SIGTERM');
    f.processStub.emit('SIGHUP');
    expect(f.effects.stopServe).toHaveBeenCalledExactlyOnceWith(f.server, 'SIGINT', { store: f.store });
    expect(f.processStub.exit).not.toHaveBeenCalled();
    const exited = new Promise<void>((resolve) => {
      f.processStub.exit.mockImplementation(() => { resolve(); });
    });
    finish();
    await exited;
    expect(f.processStub.exit).toHaveBeenCalledWith(0);
  });

  it('ignores off-terminal hangups and maps supervisor loss to SIGTERM', async () => {
    const f = fixture();
    f.effects.onTerminal.mockReturnValue(false);
    await f.run();
    expect(f.effects.ignoreHangupOffTerminal).toHaveBeenCalledOnce();
    expect(f.processStub.listenerCount('SIGHUP')).toBe(0);
    f.effects.watchSupervisor.mock.calls[0]![0]();
    expect(f.effects.stopServe).toHaveBeenCalledWith(f.server, 'SIGTERM', { store: f.store });
  });

  it('leaves update discovery in the background and announces an available version', async () => {
    const f = fixture();
    f.effects.checkForUpdate.mockResolvedValue('2.0.0');
    await f.run();
    expect(f.effects.console.log).toHaveBeenCalledWith(`\n  ⬆ ${productName('cezar')} 2.0.0 is available (running 1.2.3) — restart with: npx @wjarka/cezarion@latest\n`);
    const squawk = fixture();
    squawk.effects.readOwnName.mockReturnValue('@hearsay-tools/squawk');
    squawk.effects.checkForUpdate.mockResolvedValue('2.0.0');
    await squawk.run();
    expect(squawk.effects.console.log).toHaveBeenCalledWith(`\n  ⬆ ${productName('cezar')} 2.0.0 is available (running 1.2.3) — restart with: npx -p @hearsay-tools/squawk@latest hsq\n`);
    expect(f.effects.startServer).toHaveBeenCalledWith(expect.objectContaining({ update: { latest: '2.0.0' } }), 0, f.listener);
    const pending = fixture();
    pending.effects.checkForUpdate.mockReturnValue(new Promise(() => {}));
    await pending.run();
    expect(pending.effects.printServeBanner).toHaveBeenCalledOnce();
  });
});
