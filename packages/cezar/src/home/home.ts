import { join, posix, win32 } from 'node:path';
import { nativePathPlatform, oneRootKinds, type HomeLayout, type HomeRoots } from './kind-roots.ts';
import { assertSquawkHomeWriteIsSandboxed } from '../paths.ts';
import { createInstallMarker, readInstallMarker } from './install-marker.ts';
import { assertTestHomeOutsideAccountHome } from './protected-roots.ts';
import { HomeStore } from './store.ts';

/** Resolved cockpit paths. Legacy cache paths deliberately have a different root. */
export interface Home {
  readonly root: string;
  readonly config: string;
  readonly state: string;
  readonly data: string;
  readonly runtime: string;
  readonly layout: HomeLayout;
  readonly workspaceConfig: string;
  readonly workspaceUiState: string;
  readonly agentAccounts: string;
  readonly remoteSettings: string;
  readonly serverInstances: string;
  readonly versions: string;
  readonly bin: string;
  readonly backups: string;
  readonly cache: string;
  readonly skillsCache: string;
  readonly skillFilesCache: string;
  /** The selected one-root override, kept as data for the legacy managed launcher. */
  readonly rootOverride: string | undefined;
  serverState(instance?: string): string;
  serverLock(instance?: string): string;
}

/** Build the legacy path names from explicit roots. No environment or filesystem access. */
export function homePaths(root: string, cache: string, override: string | undefined): Home {
  return kindHomePaths({ config: root, state: root, data: root, runtime: root, cache }, 'legacy', nativePathPlatform, override);
}

/** The only constructor for named paths. */
export function kindHomePaths(roots: HomeRoots, layout: HomeLayout, platform: NodeJS.Platform, override?: string): Home {
  const { join } = platform === 'win32' ? win32 : posix;
  const { config, state, data, cache } = roots;
  const serverInstances = join(state, 'server-instances');
  const paths = {
    root: config,
    workspaceConfig: join(config, 'config.json'),
    workspaceUiState: join(state, 'ui-state.json'),
    agentAccounts: join(config, 'agent-accounts.json'),
    remoteSettings: join(config, 'remote-settings'),
    serverInstances,
    versions: join(data, 'versions'),
    bin: join(data, 'bin'),
    backups: join(state, 'backups'),
    cache,
    skillsCache: join(cache, 'skills'),
    skillFilesCache: join(cache, 'skill-files'),
    rootOverride: override,
    serverState: (instance = 'default') => instance === 'default'
      ? join(state, 'server.json') : join(serverInstances, `${instance}.json`),
    serverLock: (instance = 'default') => instance === 'default'
      ? join(state, 'server.install.lock') : join(serverInstances, `${instance}.install.lock`),
  };
  // Preserve the enumerable legacy path contract (including P1's literal compatibility table).
  return Object.freeze(Object.defineProperties(paths, {
    config: { value: config }, state: { value: state }, data: { value: data },
    runtime: { value: roots.runtime }, layout: { value: layout },
  })) as Home;
}

/** Test homes contain every cockpit path, including caches, below the supplied directory. */
export const Home = Object.freeze({
  sandbox(dir: string, { layout = 'split' }: { layout?: HomeLayout } = {}): Home {
    assertTestHomeOutsideAccountHome(dir);
    assertSquawkHomeWriteIsSandboxed(dir);
    const home = layout === 'split'
      ? kindHomePaths(oneRootKinds(dir, nativePathPlatform), layout, nativePathPlatform, dir)
      : homePaths(dir, join(dir, '.cache', 'cez'), dir);
    createInstallMarker(home.root, 'test');
    return home;
  },
  /** Seed through the same journal and write lock as product writes. Never relabel a live home. */
  seed(home: Home, path: string, value: unknown): void {
    if (readInstallMarker(home.root)?.kind !== 'test') throw new Error('Home.seed requires a test install marker');
    new HomeStore(home).writeJson(path, value);
  },
  /** Preserve malformed fixtures and byte-for-byte snapshot restores without an outside write. */
  seedBytes(home: Home, path: string, bytes: Buffer | null): void {
    if (readInstallMarker(home.root)?.kind !== 'test') throw new Error('Home.seedBytes requires a test install marker');
    new HomeStore(home).replace(path, bytes);
  },
});
