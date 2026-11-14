import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOME_LOCATING_ENV } from '../core/agent-env.ts';
import { workspaceConfigPath, workspaceUiStatePath, agentAccountsPath, serverInstancesDir, serverStatePath, serverLockPath, agentHomePaths, expandTilde, ompProfilesDir, claudeStateFilePath } from '../paths.ts';
import { remoteSettingsPath } from '../remote-settings.ts';
import { binDir, versionsDir } from '../managed-install/layout.ts';
import { bareDirFor, skillFilesCacheDirFor } from '../skills-remote.ts';
import { cezCacheDir, resolveChromium } from '../preview/chromium.ts';
import { resolveHome } from './resolve.ts'; // test-home-read: import for the annotated sandbox and refusal probes

// Shared setup now loads the write guard before this file installs its OS-home mock.
vi.hoisted(() => vi.resetModules());
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => '/home/operator' }));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

// Literal outputs from the pre-Home formulas. Do not derive expected paths with the resolver.
const cases = [
  { name: 'default', env: {}, expected: {
    root: '/home/operator/.cezar', workspaceConfig: '/home/operator/.cezar/config.json',
    workspaceUiState: '/home/operator/.cezar/ui-state.json', agentAccounts: '/home/operator/.cezar/agent-accounts.json',
    remoteSettings: '/home/operator/.cezar/remote-settings', serverInstances: '/home/operator/.cezar/server-instances',
    versions: '/home/operator/.cezar/versions', bin: '/home/operator/.cezar/bin',
    backups: '/home/operator/.cezar/backups',
    cache: '/home/operator/.cache/cez', skillsCache: '/home/operator/.cache/cez/skills',
    skillFilesCache: '/home/operator/.cache/cez/skill-files',
    serverState: '/home/operator/.cezar/server.json', namedServerState: '/home/operator/.cezar/server-instances/example-com.json',
    serverLock: '/home/operator/.cezar/server.install.lock', namedServerLock: '/home/operator/.cezar/server-instances/example-com.install.lock',
    bareSkills: '/home/operator/.cache/cez/skills/team__skills', skillFiles: '/home/operator/.cache/cez/skill-files/team__skills',
  } },
  { name: 'override', env: { CEZ_HOME: '/srv/cockpit' }, expected: {
    root: '/srv/cockpit', workspaceConfig: '/srv/cockpit/config.json',
    workspaceUiState: '/srv/cockpit/ui-state.json', agentAccounts: '/srv/cockpit/agent-accounts.json',
    remoteSettings: '/srv/cockpit/remote-settings', serverInstances: '/srv/cockpit/server-instances',
    versions: '/srv/cockpit/versions', bin: '/srv/cockpit/bin',
    backups: '/srv/cockpit/backups',
    cache: '/home/operator/.cache/cez', skillsCache: '/home/operator/.cache/cez/skills',
    skillFilesCache: '/home/operator/.cache/cez/skill-files',
    serverState: '/srv/cockpit/server.json', namedServerState: '/srv/cockpit/server-instances/example-com.json',
    serverLock: '/srv/cockpit/server.install.lock', namedServerLock: '/srv/cockpit/server-instances/example-com.install.lock',
    bareSkills: '/home/operator/.cache/cez/skills/team__skills', skillFiles: '/home/operator/.cache/cez/skill-files/team__skills',
  } },
];

function slashPaths(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.replaceAll('\\', '/')]));
}

describe('legacy Home layout (the migration source)', () => {
  it.each(cases)('preserves every named path and public path helper: $name', ({ env, expected }) => {
    const home = resolveHome({ purpose: 'cli', env, layout: 'legacy' }); // test-home-read: pure resolution; result only compared or used by read-only helpers
    const { serverState: _state, serverLock: _lock, rootOverride: _override, ...paths } = home;
    expect(slashPaths({ ...paths, serverState: home.serverState(), namedServerState: home.serverState('example-com'),
      serverLock: home.serverLock(), namedServerLock: home.serverLock('example-com'),
      bareSkills: bareDirFor('team/skills', home), skillFiles: skillFilesCacheDirFor('team/skills', home),
    })).toEqual(expected);
    const readers = {
      root: resolveHome({ purpose: 'cli', env, layout: 'legacy' }).root, workspaceConfig: workspaceConfigPath(env, home), workspaceUiState: workspaceUiStatePath(home), // test-home-read: pure resolution; result only compared or used by read-only helpers
      agentAccounts: agentAccountsPath(home), remoteSettings: remoteSettingsPath(env, home), serverInstances: serverInstancesDir(home),
      versions: versionsDir(env, home), bin: binDir(env, home), cache: cezCacheDir(home),
      serverState: serverStatePath(undefined, home), namedServerState: serverStatePath('example-com', home),
      serverLock: serverLockPath(undefined, home), namedServerLock: serverLockPath('example-com', home),
      bareSkills: bareDirFor('team/skills', home), skillFiles: skillFilesCacheDirFor('team/skills', home),
    };
    for (const [name, value] of Object.entries(slashPaths(readers))) expect(value, name).toBe(expected[name as keyof typeof expected]);
  });

  it('reads only HOME_LOCATING_ENV from the supplied env object', () => {
    const read: string[] = [];
    const env = new Proxy({ CEZ_HOME: '/srv/cockpit' }, { get(target, key) {
      read.push(String(key));
      if (!HOME_LOCATING_ENV.includes(String(key))) throw new Error(`Unexpected env read: ${String(key)}`);
      return Reflect.get(target, key);
    } });
    expect(resolveHome({ purpose: 'server', env, layout: 'legacy' }).root).toBe('/srv/cockpit'); // test-home-read: pure resolution; result only compared or used by read-only helpers
    expect(read).toEqual(HOME_LOCATING_ENV);
  });

  it.each([undefined, '', 'relative/home', '  ', "/srv/operator's home"])(
    'keeps env-object root semantics for CEZ_HOME=%s', CEZ_HOME => {
      const env = { CEZ_HOME, HOME: '/ignored', HSQ_HOME: '/ignored', XDG_CACHE_HOME: '/ignored' };
      const root = CEZ_HOME || '/home/operator/.cezar';
      expect(resolveHome({ purpose: 'cli', env, layout: 'legacy' }).root.replaceAll('\\', '/')).toBe(root); // test-home-read: pure resolution; result only compared or used by read-only helpers
      expect(resolveHome({ purpose: 'cli', env, layout: 'legacy' }).root.replaceAll('\\', '/')).toBe(root); // test-home-read: pure resolution; result only compared or used by read-only helpers
      expect(resolveHome({ purpose: 'cli', env, layout: 'legacy' }).cache.replaceAll('\\', '/')).toBe('/home/operator/.cache/cez'); // test-home-read: pure resolution; result only compared or used by read-only helpers
    });

  it('keeps agent home and tilde paths independent of CEZ_HOME', () => {
    expect(slashPaths({ ...agentHomePaths({ CEZ_HOME: '/srv/cockpit' }) })).toEqual({
      claude: '/home/operator/.claude', codex: '/home/operator/.codex', opencodeConfig: '/home/operator/.config/opencode',
      pi: '/home/operator/.pi/agent', cursor: '/home/operator/.cursor', omp: '/home/operator/.omp/agent',
    });
    expect(expandTilde('~/projects').replaceAll('\\', '/')).toBe('/home/operator/projects');
    expect(ompProfilesDir({ CEZ_HOME: '/srv/cockpit' }).replaceAll('\\', '/')).toBe('/home/operator/.omp/profiles');
    expect(claudeStateFilePath(join('/home/operator', '.claude'), {}).replaceAll('\\', '/')).toBe('/home/operator/.claude.json');
  });

  it('finds the downloaded browser in the injected Home cache after the ambient user home changes', () => {
    const home = resolveHome({ purpose: 'server', layout: 'legacy' }); // test-home-read: pure resolution; result only compared or used by read-only helpers
    const cache = join('/home/operator/.cache/cez', 'chromium');
    const binary = join(cache, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    const fs = { existsSync: (path: string) => path === binary,
      readdirSync: (path: string) => path === cache ? ['chrome-headless-shell-linux64'] : [] };
    expect(resolveChromium(fs, { HOME: '/later/home', PATH: '' }, 'linux', 'x64', home)).toBe(binary);
  });
});
