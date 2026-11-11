import { afterEach, expect, it, vi } from 'vitest';
import { resolveHome } from './resolve.ts'; // test-home-read: import for the annotated sandbox and refusal probes
import { runSubcommand } from '../subcommands.ts';
import { runMigrations } from '../workspace/migrations.ts';

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

it('passes the resolved boot home to migrations', async () => {
  const home = resolveHome({ purpose: 'server', env: { CEZ_HOME: '/resolved/home' } }); // test-home-read: pure resolution; downstream services and writes are mocked
  const run = vi.fn(async () => {});
  await runMigrations({ bootRepoRoot: '/repo', home }, [{ id: 'test', to: 1, run }]);
  expect(run).toHaveBeenCalledWith({ home: home.root, bootRepoRoot: '/repo' }, home);
});
