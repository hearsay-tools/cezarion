import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOME_LOCATING_ENV } from '../core/agent-env.ts';
import { posixLauncher, windowsLauncher } from '../managed-install/launcher.ts';
import { Home } from './home.ts';
import * as installMarker from './install-marker.ts';
import { HOME_LAYOUT_ENV, type HomeRoots } from './kind-roots.ts';
import { resolveHome } from './resolve.ts'; // test-home-read: pure resolver tables; writes use Home.sandbox only

vi.hoisted(() => vi.resetModules());
const account = vi.hoisted(() => ({ home: '/home/operator' }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => account.home }));
afterEach(() => { account.home = '/home/operator'; });

const linux: HomeRoots = { config: '/home/operator/.config/hearsay-squawk', state: '/home/operator/.local/state/hearsay-squawk',
  data: '/home/operator/.local/share/hearsay-squawk', cache: '/home/operator/.cache/hearsay-squawk',
  runtime: '/home/operator/.local/state/hearsay-squawk/run' };
const custom: HomeRoots = { config: '/custom/config', state: '/custom/state', data: '/custom/data', cache: '/custom/cache', runtime: '/custom/run' };
const windows: HomeRoots = { config: 'C:\\Users\\operator\\AppData\\Roaming\\Hearsay Squawk',
  state: 'C:\\Users\\operator\\AppData\\Local\\Hearsay Squawk\\state', data: 'C:\\Users\\operator\\AppData\\Local\\Hearsay Squawk\\data',
  cache: 'C:\\Users\\operator\\AppData\\Local\\Hearsay Squawk\\cache', runtime: 'C:\\Users\\operator\\AppData\\Local\\Hearsay Squawk\\run' };
const local = { state: 'D:\\Local\\Hearsay Squawk\\state', data: 'D:\\Local\\Hearsay Squawk\\data',
  cache: 'D:\\Local\\Hearsay Squawk\\cache', runtime: 'D:\\Local\\Hearsay Squawk\\run' };
const mac: HomeRoots = { config: '/home/operator/Library/Application Support/Hearsay Squawk/config',
  state: '/home/operator/Library/Application Support/Hearsay Squawk/state', data: '/home/operator/Library/Application Support/Hearsay Squawk/data',
  cache: '/home/operator/Library/Caches/Hearsay Squawk', runtime: '/tmp/hearsay-squawk' };
const cases: { name: string; env: NodeJS.ProcessEnv; expected: HomeRoots; platform?: NodeJS.Platform }[] = [
  { name: 'Linux defaults without XDG values', env: {}, expected: linux },
  { name: 'Linux XDG_CONFIG_HOME', env: { XDG_CONFIG_HOME: '/config' }, expected: { ...linux, config: '/config/hearsay-squawk' } },
  { name: 'Linux XDG_STATE_HOME and runtime fallback', env: { XDG_STATE_HOME: '/state' }, expected: { ...linux, state: '/state/hearsay-squawk', runtime: '/state/hearsay-squawk/run' } },
  { name: 'Linux XDG_DATA_HOME', env: { XDG_DATA_HOME: '/data' }, expected: { ...linux, data: '/data/hearsay-squawk' } },
  { name: 'Linux XDG_CACHE_HOME', env: { XDG_CACHE_HOME: '/cache' }, expected: { ...linux, cache: '/cache/hearsay-squawk' } },
  { name: 'Linux XDG_RUNTIME_DIR', env: { XDG_RUNTIME_DIR: '/run/user/42' }, expected: { ...linux, runtime: '/run/user/42/hearsay-squawk' } },
  { name: 'Linux ignores relative XDG values', env: Object.fromEntries(HOME_LAYOUT_ENV.filter(name => name.startsWith('XDG_')).map(name => [name, 'relative'])), expected: linux },
  { name: 'Linux ignores empty XDG values', env: Object.fromEntries(HOME_LAYOUT_ENV.map(name => [name, ''])), expected: linux },
  { name: 'macOS defaults without TMPDIR', platform: 'darwin', env: {}, expected: mac },
  { name: 'macOS TMPDIR ignores XDG', platform: 'darwin', env: { TMPDIR: '/private/tmp/session', XDG_CONFIG_HOME: '/ignored' }, expected: { ...mac, runtime: '/private/tmp/session/hearsay-squawk' } },
  { name: 'Windows defaults without APPDATA or LOCALAPPDATA', platform: 'win32', env: {}, expected: windows },
  { name: 'Windows APPDATA only', platform: 'win32', env: { APPDATA: 'D:\\Roaming' }, expected: { ...windows, config: 'D:\\Roaming\\Hearsay Squawk' } },
  { name: 'Windows LOCALAPPDATA only', platform: 'win32', env: { LOCALAPPDATA: 'D:\\Local' }, expected: { ...windows, ...local } },
  { name: 'Windows APPDATA and LOCALAPPDATA', platform: 'win32', env: { APPDATA: 'D:\\Roaming', LOCALAPPDATA: 'D:\\Local' }, expected: { config: 'D:\\Roaming\\Hearsay Squawk', ...local } },
  { name: 'HSQ_HOME overrides CEZ_HOME and platform defaults', env: { HSQ_HOME: '/custom', CEZ_HOME: '/ignored', XDG_CONFIG_HOME: '/ignored' }, expected: custom },
  { name: 'custom CEZ_HOME overrides platform defaults', env: { CEZ_HOME: '/custom', XDG_CONFIG_HOME: '/ignored' }, expected: custom },
  { name: 'empty HSQ_HOME falls through to CEZ_HOME', env: { HSQ_HOME: '', CEZ_HOME: '/custom' }, expected: custom },
  { name: 'empty home locators fall through to platform defaults', env: { HSQ_HOME: '', CEZ_HOME: '' }, expected: linux },
  { name: 'CEZ_HOME legacy default counts as unset', env: { CEZ_HOME: '/home/operator/.cezar' }, expected: linux },
  { name: 'CEZ_HOME trailing slash counts as the legacy default', env: { CEZ_HOME: '/home/operator/.cezar/' }, expected: linux },
  { name: 'CEZ_HOME dotted path counts as the legacy default', env: { CEZ_HOME: '/home/operator/./.cezar' }, expected: linux },
  { name: 'HSQ_HOME legacy spelling remains an explicit one-root override', env: { HSQ_HOME: '/home/operator/.cezar/' },
    expected: { config: '/home/operator/.cezar/config', state: '/home/operator/.cezar/state', data: '/home/operator/.cezar/data', cache: '/home/operator/.cezar/cache', runtime: '/home/operator/.cezar/run' } },
  { name: 'HSQ_HOME wins even at the legacy default', env: { HSQ_HOME: '/custom', CEZ_HOME: '/home/operator/.cezar' }, expected: custom },
  { name: 'Windows one-root precedence uses win32 paths', platform: 'win32', env: { HSQ_HOME: 'E:\\home', CEZ_HOME: 'D:\\ignored' },
    expected: { config: 'E:\\home\\config', state: 'E:\\home\\state', data: 'E:\\home\\data', cache: 'E:\\home\\cache', runtime: 'E:\\home\\run' } },
  { name: 'Windows legacy default trailing separator and case count as unset', platform: 'win32', env: { CEZ_HOME: 'c:/users/OPERATOR/.CEZAR/' }, expected: windows },
  { name: 'Windows legacy default dotted path counts as unset', platform: 'win32', env: { CEZ_HOME: 'C:/Users/operator/./.cezar' }, expected: windows },
  { name: 'Windows legacy default counts as unset', platform: 'win32', env: { CEZ_HOME: 'C:\\Users\\operator\\.cezar' }, expected: windows },
];

describe('split Home resolution', () => {
  it.each(cases)('$name', ({ platform = 'linux', env, expected }) => {
    account.home = platform === 'win32' ? 'C:\\Users\\operator' : '/home/operator';
    const home = resolveHome({ purpose: 'cli', layout: 'split', platform, env }); // test-home-read: pure table assertions
    expect({ config: home.config, state: home.state, data: home.data, cache: home.cache, runtime: home.runtime }).toEqual(expected);
    expect(home.root).toBe(expected.config);
    expect(home.layout).toBe('split');
  });

  it('routes each named path through its kind root', () => {
    const home = resolveHome({ purpose: 'server', layout: 'split', platform: 'linux', env: { HSQ_HOME: '/custom' } }); // test-home-read: pure path assertions
    expect({ workspaceConfig: home.workspaceConfig, agentAccounts: home.agentAccounts, remoteSettings: home.remoteSettings,
      workspaceUiState: home.workspaceUiState, serverState: home.serverState(), serverInstances: home.serverInstances,
      namedState: home.serverState('named'), serverLock: home.serverLock(), namedLock: home.serverLock('named'),
      backups: home.backups, versions: home.versions, bin: home.bin,
      skillsCache: home.skillsCache, skillFilesCache: home.skillFilesCache,
    }).toEqual({ workspaceConfig: '/custom/config/config.json', agentAccounts: '/custom/config/agent-accounts.json', remoteSettings: '/custom/config/remote-settings',
      workspaceUiState: '/custom/state/ui-state.json', serverState: '/custom/state/server.json', serverInstances: '/custom/state/server-instances',
      namedState: '/custom/state/server-instances/named.json', serverLock: '/custom/state/server.install.lock', namedLock: '/custom/state/server-instances/named.install.lock',
      backups: '/custom/state/backups', versions: '/custom/data/versions', bin: '/custom/data/bin',
      skillsCache: '/custom/cache/skills', skillFilesCache: '/custom/cache/skill-files' });
  });

  it('reads layout env separately from home locators', () => {
    const read: string[] = [];
    const env = new Proxy({}, { get: (_target, key) => { read.push(String(key)); return undefined; } });
    resolveHome({ purpose: 'cli', layout: 'split', platform: 'linux', env }); // test-home-read: pure env-read probe
    expect(read).toEqual([...HOME_LOCATING_ENV, ...HOME_LAYOUT_ENV]);
    expect(HOME_LAYOUT_ENV.some(name => HOME_LOCATING_ENV.includes(name))).toBe(false);
  });

  it('keeps legacy kind roots and cache exception', () => {
    const home = resolveHome({ purpose: 'cli', layout: 'legacy', env: { CEZ_HOME: '/legacy', HSQ_HOME: '/ignored' } }); // test-home-read: pure legacy assertions
    expect([home.config, home.state, home.data, home.runtime]).toEqual(['/legacy', '/legacy', '/legacy', '/legacy']);
    expect(home.cache.replaceAll('\\', '/')).toBe('/home/operator/.cache/cez');
  });

  it('renders split launchers at the data root', () => {
    const home = resolveHome({ purpose: 'cli', layout: 'split', platform: 'linux', env: { HSQ_HOME: "/custom/operator's home" } }); // test-home-read: launcher generation only
    expect(posixLauncher({}, home)).toContain(`CEZ_MANAGED_HOME='/custom/operator'"'"'s home/data'`);
    expect(windowsLauncher({}, home)).toContain(win32.join(home.data, 'versions', 'current', 'node_modules', '@wjarka', 'cezarion', 'dist', 'index.js'));
  });

  it('renders a Windows split launcher and named state paths with win32 separators', () => {
    account.home = 'C:\\Users\\operator';
    const home = resolveHome({ purpose: 'cli', layout: 'split', platform: 'win32', env: { HSQ_HOME: 'D:\\home' } }); // test-home-read: pure Windows paths
    expect(home.serverState('named')).toBe('D:\\home\\state\\server-instances\\named.json');
    expect(home.serverLock('named')).toBe('D:\\home\\state\\server-instances\\named.install.lock');
    expect(windowsLauncher({}, home)).toContain('D:\\home\\data\\versions\\current\\node_modules\\@wjarka\\cezarion\\dist\\index.js');
  });

  it('creates a split sandbox marker in config and preserves it on reuse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-split-home-'));
    try {
      const home = Home.sandbox(dir, { layout: 'split' });
      expect([home.config, home.state, home.data, home.cache, home.runtime]).toEqual(['config', 'state', 'data', 'cache', 'run'].map(kind => join(dir, kind)));
      const marker = readFileSync(join(dir, 'config', 'install.json'), 'utf8');
      expect(JSON.parse(marker).kind).toBe('test');
      Home.sandbox(dir, { layout: 'split' });
      expect(readFileSync(join(dir, 'config', 'install.json'), 'utf8')).toBe(marker);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

it('keeps sandbox filesystem paths native when process.platform is mocked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-native-sandbox-'));
  const marker = installMarker.createInstallMarker(dir, 'test');
  // Keep marker writes on the native platform; this assertion checks path construction only.
  const createMarker = vi.spyOn(installMarker, 'createInstallMarker').mockReturnValue(marker);
  const platform = process.platform;
  Object.defineProperty(process, 'platform', { value: platform === 'win32' ? 'linux' : 'win32', configurable: true });
  try {
    const legacy = Home.sandbox(join(dir, 'legacy'), { layout: 'legacy' });
    const split = Home.sandbox(join(dir, 'split'), { layout: 'split' });
    expect(legacy.workspaceConfig).toBe(join(dir, 'legacy', 'config.json'));
    expect(split.workspaceConfig).toBe(join(dir, 'split', 'config', 'config.json'));
    expect(createMarker.mock.calls).toEqual([[join(dir, 'legacy'), 'test'], [join(dir, 'split', 'config'), 'test']]);
  } finally {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    createMarker.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
