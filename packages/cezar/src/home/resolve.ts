import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { HOME_LOCATING_ENV } from '../core/agent-env.ts';
import { kindHomePaths, type Home } from './home.ts';
import { HOME_LAYOUT_ENV, oneRootKinds, platformKindRoots, type HomeLayout } from './kind-roots.ts';
import { REBRAND_SWITCH } from './switch.ts';

export interface ResolveHomeOptions {
  purpose: 'cli' | 'server';
  env?: NodeJS.ProcessEnv;
  layout?: HomeLayout;
  platform?: NodeJS.Platform;
}

/** Resolve paths only. No filesystem reads, writes, markers or migrations. See ADR 0059. */
export function resolveHome({ env = process.env, layout = REBRAND_SWITCH ? 'split' : 'legacy',
  platform = process.platform }: ResolveHomeOptions): Home {
  const locating = Object.fromEntries(HOME_LOCATING_ENV.map(name => [name, env[name]]));
  const { join } = platform === 'win32' ? win32 : posix;
  const userHome = homedir();
  const legacyDefault = join(userHome, '.cezar');
  if (layout === 'legacy') {
    const root = locating.CEZ_HOME || legacyDefault;
    return kindHomePaths({ config: root, state: root, data: root, runtime: root,
      cache: join(userHome, '.cache', 'cez') }, layout, platform, locating.CEZ_HOME || undefined);
  }
  const override = locating.HSQ_HOME || (locating.CEZ_HOME !== legacyDefault ? locating.CEZ_HOME : undefined) || undefined;
  const layoutEnv = Object.fromEntries(HOME_LAYOUT_ENV.map(name => [name, env[name]]));
  const roots = override ? oneRootKinds(override, platform) : platformKindRoots(userHome, layoutEnv, platform);
  return kindHomePaths(roots, layout, platform, override);
}
