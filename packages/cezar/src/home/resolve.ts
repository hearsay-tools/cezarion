import { homedir } from 'node:os';
import { join } from 'node:path';
import { HOME_LOCATING_ENV } from '../core/agent-env.ts';
import { homePaths, type Home } from './home.ts';

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
  return homePaths(root, join(userHome, '.cache', 'cez'), override);
}
