import { join } from 'node:path';
import { assertCezarHomeWriteIsSandboxed } from '../paths.ts';
import { createInstallMarker, readInstallMarker } from './install-marker.ts';
import { HomeStore } from './store.ts';

/** Resolved cockpit paths. Legacy cache paths deliberately have a different root. */
export interface Home {
  readonly root: string;
  readonly workspaceConfig: string;
  readonly workspaceUiState: string;
  readonly agentAccounts: string;
  readonly remoteSettings: string;
  readonly serverInstances: string;
  readonly versions: string;
  readonly bin: string;
  readonly dryCache: string;
  readonly dryPrefix: string;
  readonly backups: string;
  readonly applicationUpdates: string;
  readonly cache: string;
  readonly skillsCache: string;
  readonly skillFilesCache: string;
  /** The nonempty legacy override, kept as data for the managed launcher. */
  readonly rootOverride: string | undefined;
  serverState(instance?: string): string;
  serverLock(instance?: string): string;
}

/** Build the legacy path names from explicit roots. No environment or filesystem access. */
export function homePaths(root: string, cache: string, override: string | undefined): Home {
  const serverInstances = join(root, 'server-instances');
  return Object.freeze({
    root,
    workspaceConfig: join(root, 'config.json'),
    workspaceUiState: join(root, 'ui-state.json'),
    agentAccounts: join(root, 'agent-accounts.json'),
    remoteSettings: join(root, 'remote-settings'),
    serverInstances,
    versions: join(root, 'versions'),
    bin: join(root, 'bin'),
    dryCache: join(root, 'dry-cache'),
    dryPrefix: join(root, 'dry-prefix'),
    backups: join(root, 'backups'),
    applicationUpdates: join(root, 'application-updates'),
    cache,
    skillsCache: join(cache, 'skills'),
    skillFilesCache: join(cache, 'skill-files'),
    rootOverride: override,
    serverState: (instance = 'default') => instance === 'default'
      ? join(root, 'server.json') : join(serverInstances, `${instance}.json`),
    serverLock: (instance = 'default') => instance === 'default'
      ? join(root, 'server.install.lock') : join(serverInstances, `${instance}.install.lock`),
  });
}

/** Test homes contain every cockpit path, including caches, below the supplied directory. */
export const Home = Object.freeze({
  sandbox(dir: string): Home {
    assertCezarHomeWriteIsSandboxed(dir);
    const home = homePaths(dir, join(dir, '.cache', 'cez'), dir);
    createInstallMarker(dir, 'test');
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
