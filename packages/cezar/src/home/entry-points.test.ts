import { currentEntry } from '../self-update/layout.ts';
import { Home } from './home.ts';
import { testHome, useTestHome } from './test-home.testkit.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { resolveHome } from './resolve.ts'; // test-home-read: import for the annotated sandbox and refusal probes
import { runSubcommand } from '../subcommands.ts';
import { runManagedCommand } from '../self-update/cli.ts';
import { SelfUpdateService } from '../self-update/service.ts';
import { ApplicationUpdateService } from '../application-update/service.ts';
import { createServeApplicationUpdate, createServeSelfUpdate, restartServe } from '../serve-boot.ts';
import { runMigrations } from '../workspace/migrations.ts';
import type { RunStore } from '../runs/store.ts';
import type { startServer } from '../server/server.ts';

vi.mock('../self-update/service.ts', () => ({ SelfUpdateService: vi.fn(function () {}) }));
vi.mock('../application-update/service.ts', () => ({ ApplicationUpdateService: vi.fn(function () {}) }));
vi.mock('../workspace/config.ts', () => ({
  loadWorkspaceConfig: vi.fn(async () => ({ schemaVersion: 0 })),
  mergeWriteWorkspaceConfig: vi.fn(async (mutate: (value: { schemaVersion: number }) => void) => {
    const value = { schemaVersion: 0 }; mutate(value); return value;
  }),
}));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

it.each(['artifact', 'job', 'message', 'worker', 'task', 'automation', 'webhook', 'discover'])(
  'does not resolve or pass Home to the task command %s', async command => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const home = vi.fn(() => { throw new Error('Task commands must not receive Home'); });
    await runSubcommand([command, '--help'], {}, home);
    expect(home).not.toHaveBeenCalled();
  });

it('resolves Home once for a managed operator command and passes it to its service', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const home = resolveHome({ purpose: 'cli', env: { CEZ_HOME: '/operator/home' } }); // test-home-read: pure resolution; downstream services and writes are mocked
  const getHome = vi.fn(() => home);
  expect(await runManagedCommand(['use'], { pkgName: 'cezarion', version: '1.0.0', entry: '/entry' }, getHome)).toBe(1);
  expect(getHome).toHaveBeenCalledTimes(1);
  expect(SelfUpdateService).toHaveBeenCalledWith(expect.objectContaining({ home }));
});

it('uses the resolved operator home even if the supplied env changed after resolution', async () => {
  const env = { CEZ_HOME: '/resolved/home', CEZ_URL: 'http://127.0.0.1:4321' };
  const home = resolveHome({ purpose: 'cli', env }); // test-home-read: pure resolution; downstream services and writes are mocked
  env.CEZ_HOME = '/later/home';
  const getHome = vi.fn(() => home);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
  try {
    expect(await runSubcommand(['remote-settings', 'status'], env, getHome)).toBe(0);
    expect(getHome).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ path: home.remoteSettings });
  } finally { vi.unstubAllGlobals(); }
});

it('passes the boot Home to both updater services and keeps the legacy dry paths', () => {
  vi.stubEnv('CEZ_DRY_RUN', '1');
  const home = resolveHome({ purpose: 'server', env: { CEZ_HOME: '/resolved/home' } }); // test-home-read: pure resolution; downstream services and writes are mocked
  const store = { close: vi.fn(), listRuns: () => [] } as unknown as RunStore;
  const server = () => { throw new Error('No restart in this test'); };
  createServeApplicationUpdate('/repo', {}, server, () => undefined, store, home);
  expect(ApplicationUpdateService).toHaveBeenCalledWith(expect.objectContaining({
    home: home.root, npmPrefix: home.dryPrefix, npmCache: home.dryCache,
  }));
  createServeSelfUpdate({ pkgName: 'cezarion', version: '1.0.0', store, bindHost: undefined, home }, server as () => ReturnType<typeof startServer>);
  expect(SelfUpdateService).toHaveBeenCalledWith(expect.objectContaining({ home }));
});

it('passes the resolved boot home to migrations', async () => {
  const home = resolveHome({ purpose: 'server', env: { CEZ_HOME: '/resolved/home' } }); // test-home-read: pure resolution; downstream services and writes are mocked
  const run = vi.fn(async () => {});
  await runMigrations({ bootRepoRoot: '/repo', home }, [{ id: 'test', to: 1, run }]);
  expect(run).toHaveBeenCalledWith({ home: home.root, bootRepoRoot: '/repo' }, home);
});

it('restarts through the injected Home current entry after the ambient home changes', async () => {
  const home = resolveHome({ purpose: 'server', env: { CEZ_HOME: '/resolved/home' } }); // test-home-read: pure resolution; downstream services and writes are mocked
  useTestHome(Home.sandbox(join(testHome().root, 'later')));
  const restart = vi.fn();
  const server = { shutdownForRestart: vi.fn(async () => {}), address: () => ({ address: '127.0.0.1', family: 'IPv4', port: 4321 }) };
  await restartServe(server as unknown as Parameters<typeof restartServe>[0], restart, { forward: vi.fn() }, home);
  expect(restart).toHaveBeenCalledWith(expect.objectContaining({ entry: currentEntry({}, home) }));
});
