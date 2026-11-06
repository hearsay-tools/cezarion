import { homedir } from 'node:os';
import { join } from 'node:path';
import { HOME_LOCATING_ENV } from '../core/agent-env.ts';
import type { Home } from './home.ts';

export interface ResolveHomeOptions {
  purpose: 'cli' | 'server';
  env?: NodeJS.ProcessEnv;
}

/** Resolve paths only. No filesystem reads, writes, markers or migrations. See ADR 0059. */
export function resolveHome({ env = process.env }: ResolveHomeOptions): Home {
  // Keep home locators in the same allowlist that child-environment filtering uses.
  const locating = Object.fromEntries(HOME_LOCATING_ENV.map(name => [name, env[name]]));
  const override = locating.CEZ_HOME || undefined;
  const userHome = homedir();
  const root = override ?? join(userHome, '.cezar');
  const serverInstances = join(root, 'server-instances');
  const cache = join(userHome, '.cache', 'cez');
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
