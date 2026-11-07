import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testHome } from './home/test-home.testkit.ts';
import { DEFAULT_SERVER_INSTANCE } from './paths.ts';
import { defaultServerCommandDeps, serverCommand, type ServerCommandFlags, type ServerCommandMode } from './server-command.ts';
import type { Home } from './home/home.ts';
import type { RunOptions, RunStatus } from './server-install/engine.ts';

let savedExitCode: typeof process.exitCode;

beforeEach(() => {
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.stubEnv('HSQ_DRY_RUN', '0');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-08T00:00:00.000Z'));
});

afterEach(() => {
  process.exitCode = savedExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function fixture() {
  const home = testHome();
  const trace: string[] = [];
  const output = { log: vi.spyOn(console, 'log').mockImplementation(() => {}), error: vi.spyOn(console, 'error').mockImplementation(() => {}) };
  const state = { status: 'complete' as RunStatus };
  const strategy = { id: 'ubuntu-vps' };
  const engine = (mode: string) => vi.fn(async (_strategy: unknown, _opts: RunOptions) => {
    trace.push(mode);
    return { status: state.status };
  });
  const modules = {
    availablePlatformIds: vi.fn(() => ['ubuntu-vps', 'macosx-ngrok']),
    getStrategy: vi.fn((_platform: string): typeof strategy | undefined => strategy),
    loadServerState: vi.fn((_instance: string, _home: Home) => ({ installed: false, platform: undefined as string | undefined })),
    listServerInstances: vi.fn(() => [] as Array<{ instance: string }>),
    nextFreeInstancePort: vi.fn(() => 4322),
    instanceSlug: vi.fn((domain: string) => domain.replaceAll('.', '-')),
    runInstall: engine('install'), runDeploy: engine('deploy'), runUninstall: engine('uninstall'),
  };
  const deps = {
    augmentPathFromLoginShell: vi.fn(() => { trace.push('path'); }),
    load: vi.fn(async () => { trace.push('load'); return modules; }),
    promptSecondInstanceDomain: vi.fn(async (): Promise<string | undefined> => undefined),
    stdin: { isTTY: false },
  };
  const run = (mode: ServerCommandMode = 'install', platform: string | undefined = 'ubuntu-vps', flags: ServerCommandFlags = { yes: false }) =>
    serverCommand(mode, home, '/repo', platform, flags, deps as unknown as typeof defaultServerCommandDeps);
  return { home, trace, output, state, strategy, modules, deps, run };
}

describe('serverCommand', () => {
  it('augments PATH before lazily loading modules and running the engine', async () => {
    const f = fixture();
    await f.run();
    expect(f.trace).toEqual(['path', 'load', 'install']);
    expect(f.modules.availablePlatformIds).toHaveBeenCalledOnce();
    expect(f.modules.runInstall).toHaveBeenCalledWith(f.strategy, {
      home: f.home, dryRun: false, assumeYes: false, reconfigure: new Set(), reinstall: false,
      repoRoot: '/repo', now: '2026-11-08T00:00:00.000Z', instance: DEFAULT_SERVER_INSTANCE,
      domain: undefined, port: undefined, externalProxy: undefined, bindHost: undefined,
    });
    expect(f.modules.listServerInstances).not.toHaveBeenCalled();
    expect(f.modules.nextFreeInstancePort).not.toHaveBeenCalled();
  });

  it('propagates a lazy-load rejection after augmenting PATH', async () => {
    const f = fixture();
    const error = new Error('module failed to load');
    f.deps.load.mockRejectedValue(error);
    await expect(f.run()).rejects.toBe(error);
    expect(f.deps.augmentPathFromLoginShell).toHaveBeenCalledBefore(f.deps.load);
    expect(f.modules.runInstall).not.toHaveBeenCalled();
    expect(f.output.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('reports a missing platform without selecting a strategy', async () => {
    const f = fixture();
    await serverCommand('install', f.home, '/repo', undefined, { yes: true }, f.deps as unknown as typeof defaultServerCommandDeps);
    expect(f.output.error).toHaveBeenCalledExactlyOnceWith('--platform is required. Valid platforms: ubuntu-vps, macosx-ngrok');
    expect(process.exitCode).toBe(1);
    expect(f.modules.getStrategy).not.toHaveBeenCalled();
    expect(f.modules.runInstall).not.toHaveBeenCalled();
  });

  it('reports an unknown platform and retains the valid-platform list', async () => {
    const f = fixture();
    f.modules.getStrategy.mockReturnValue(undefined);
    await f.run('install', 'unknown');
    expect(f.output.error).toHaveBeenCalledExactlyOnceWith('unknown platform: unknown (valid: ubuntu-vps, macosx-ngrok)');
    expect(process.exitCode).toBe(1);
    expect(f.modules.runInstall).not.toHaveBeenCalled();
  });

  it('rejects a named instance on a platform that does not support it', async () => {
    const f = fixture();
    await f.run('install', 'macosx-ngrok', { yes: true, domain: 'shop.example.com' });
    expect(f.output.error).toHaveBeenCalledExactlyOnceWith('--domain (multi-instance) is only supported on ubuntu-vps, not macosx-ngrok.');
    expect(process.exitCode).toBe(1);
    expect(f.modules.runInstall).not.toHaveBeenCalled();
    expect(f.modules.nextFreeInstancePort).not.toHaveBeenCalled();
  });

  it.each([
    ['deploy', undefined], ['uninstall', undefined],
    ['deploy', 'shop.example.com'], ['uninstall', 'shop.example.com'],
  ] as const)('reads the remembered platform for %s domain=%s', async (mode, domain) => {
    const f = fixture();
    f.modules.loadServerState.mockReturnValue({ installed: true, platform: 'ubuntu-vps' });
    await serverCommand(mode, f.home, '/repo', undefined, { yes: false, domain }, f.deps as unknown as typeof defaultServerCommandDeps);
    const instance = domain === undefined ? DEFAULT_SERVER_INSTANCE : 'shop-example-com';
    expect(f.modules.loadServerState).toHaveBeenCalledExactlyOnceWith(instance, f.home);
    expect(f.modules.getStrategy).toHaveBeenCalledWith('ubuntu-vps');
    expect(f.modules.nextFreeInstancePort).not.toHaveBeenCalled();
    expect(f.deps.promptSecondInstanceDomain).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it.each(['deploy', 'uninstall'] as const)('requires a platform when %s has no remembered platform', async (mode) => {
    const f = fixture();
    await serverCommand(mode, f.home, '/repo', undefined, { yes: false }, f.deps as unknown as typeof defaultServerCommandDeps);
    expect(process.exitCode).toBe(1);
    expect(f.output.error).toHaveBeenCalledWith('--platform is required. Valid platforms: ubuntu-vps, macosx-ngrok');
    expect(f.modules.getStrategy).not.toHaveBeenCalled();
  });

  it('prompts for a second instance only after finding an installed cockpit', async () => {
    const f = fixture();
    f.deps.stdin.isTTY = true;
    f.modules.loadServerState.mockReturnValue({ installed: true, platform: 'ubuntu-vps' });
    f.deps.promptSecondInstanceDomain.mockResolvedValue('shop.example.com');
    await f.run();
    expect(f.modules.loadServerState).toHaveBeenCalledWith(DEFAULT_SERVER_INSTANCE, f.home);
    expect(f.deps.promptSecondInstanceDomain).toHaveBeenCalledOnce();
    expect(f.modules.loadServerState).toHaveBeenCalledBefore(f.deps.promptSecondInstanceDomain);
    expect(f.deps.promptSecondInstanceDomain).toHaveBeenCalledBefore(f.modules.instanceSlug);
    expect(f.modules.runInstall.mock.calls[0]![1]).toMatchObject({ domain: 'shop.example.com', instance: 'shop-example-com', port: 4322 });
  });

  it('keeps the default instance when the second-instance prompt returns no domain', async () => {
    const f = fixture();
    f.deps.stdin.isTTY = true;
    f.modules.loadServerState.mockReturnValue({ installed: true, platform: 'ubuntu-vps' });
    await f.run();
    expect(f.deps.promptSecondInstanceDomain).toHaveBeenCalledOnce();
    expect(f.modules.instanceSlug).not.toHaveBeenCalled();
    expect(f.modules.runInstall.mock.calls[0]![1]).toMatchObject({ instance: DEFAULT_SERVER_INSTANCE, domain: undefined });
  });

  it.each([
    [true, true, true, undefined],
    [false, false, true, undefined],
    [false, true, false, undefined],
    [false, true, true, 'shop.example.com'],
  ] as const)('skips the second-instance prompt for yes=%s tty=%s installed=%s domain=%s', async (yes, tty, installed, domain) => {
    const f = fixture();
    f.deps.stdin.isTTY = tty;
    f.modules.loadServerState.mockReturnValue({ installed, platform: 'ubuntu-vps' });
    await f.run('install', 'ubuntu-vps', { yes, domain });
    expect(f.deps.promptSecondInstanceDomain).not.toHaveBeenCalled();
  });

  it('trims a new domain and chooses the next free instance port', async () => {
    const f = fixture();
    await f.run('install', 'ubuntu-vps', { yes: true, domain: '  shop.example.com  ' });
    expect(f.modules.instanceSlug).toHaveBeenCalledWith('shop.example.com');
    expect(f.modules.listServerInstances).toHaveBeenCalledWith(f.home);
    expect(f.modules.nextFreeInstancePort).toHaveBeenCalledWith(undefined, f.home);
    expect(f.modules.runInstall.mock.calls[0]![1]).toMatchObject({ instance: 'shop-example-com', domain: 'shop.example.com', port: 4322 });
    expect(f.output.log).toHaveBeenCalledWith('\n  New instance "shop-example-com" (shop.example.com) → loopback port 4322 (override with --port).');
    expect(f.output.log).toHaveBeenCalledWith('\n  cez server-install (ubuntu-vps, shop.example.com) complete.');
    expect(f.output.log).toHaveBeenCalledWith('  Redeploy a new version any time with: cez server-deploy --platform ubuntu-vps --domain shop.example.com\n');
  });

  it('retains an explicit port without inspecting the instance list', async () => {
    const f = fixture();
    await f.run('install', 'ubuntu-vps', { yes: true, domain: 'shop.example.com', port: 5000 });
    expect(f.modules.runInstall.mock.calls[0]![1].port).toBe(5000);
    expect(f.modules.listServerInstances).not.toHaveBeenCalled();
    expect(f.modules.nextFreeInstancePort).not.toHaveBeenCalled();
  });

  it('lets a known named instance retain its recorded port', async () => {
    const f = fixture();
    f.modules.listServerInstances.mockReturnValue([{ instance: 'shop-example-com' }]);
    await f.run('install', 'ubuntu-vps', { yes: true, domain: 'shop.example.com' });
    expect(f.modules.runInstall.mock.calls[0]![1].port).toBeUndefined();
    expect(f.modules.nextFreeInstancePort).not.toHaveBeenCalled();
  });

  it.each([
    ['install', '\n  cez server-install (ubuntu-vps) complete.'],
    ['deploy', '\n  cez server-deploy (ubuntu-vps) complete — the service was reloaded and verified.\n'],
    ['uninstall', '\n  cez server-uninstall (ubuntu-vps) complete — the changes it made were reversed.\n'],
  ] as const)('runs the %s engine and reports completion', async (mode, message) => {
    const f = fixture();
    await f.run(mode);
    const engines = { install: f.modules.runInstall, deploy: f.modules.runDeploy, uninstall: f.modules.runUninstall };
    expect(engines[mode]).toHaveBeenCalledOnce();
    expect(f.output.log).toHaveBeenCalledWith(message);
    expect(process.exitCode).toBe(0);
  });

  it.each([
    ['install', 'cancelled', 0], ['deploy', 'cancelled', 0], ['uninstall', 'cancelled', 0],
    ['install', 'failed', 1], ['deploy', 'failed', 1], ['uninstall', 'failed', 1],
  ] as const)('reports %s %s with exit %s', async (mode, status, exitCode) => {
    const f = fixture();
    f.state.status = status;
    await f.run(mode);
    expect(process.exitCode).toBe(exitCode);
    expect(f.output.log).not.toHaveBeenCalled();
    expect(f.output.error).not.toHaveBeenCalled();
  });

  it.each([new Error('engine failed'), 'engine failed'])('reports a thrown engine value %s', async (error) => {
    const f = fixture();
    f.modules.runInstall.mockRejectedValue(error);
    await f.run();
    expect(f.output.error).toHaveBeenCalledExactlyOnceWith('engine failed');
    expect(process.exitCode).toBe(1);
  });

  it('passes install flags and a deduplicated reconfigure set', async () => {
    const f = fixture();
    vi.stubEnv('HSQ_DRY_RUN', '1');
    await f.run('install', 'ubuntu-vps', {
      yes: true, externalProxy: true, bindHost: '172.17.0.1', reinstall: true,
      reconfigure: ' nginx, , certbot,nginx ',
    });
    expect(f.modules.runInstall.mock.calls[0]![1]).toMatchObject({
      assumeYes: true, dryRun: true, externalProxy: true, bindHost: '172.17.0.1',
      reinstall: true, reconfigure: new Set(['nginx', 'certbot']),
    });
  });

  it.each(['deploy', 'uninstall'] as const)('omits install-only proxy options for %s', async (mode) => {
    const f = fixture();
    await f.run(mode, 'ubuntu-vps', { yes: true, externalProxy: true, bindHost: '172.17.0.1' });
    const engines = { deploy: f.modules.runDeploy, uninstall: f.modules.runUninstall };
    const options = engines[mode].mock.calls[0]![1];
    expect(options).not.toHaveProperty('externalProxy');
    expect(options).not.toHaveProperty('bindHost');
  });
});
