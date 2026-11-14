import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { legacyHomeEnv, preferredHomeEnv } from '../core/product-env.ts';
import { kindHomePaths, type Home } from './home.ts';
import { HOME_LAYOUT_ENV, oneRootKinds, platformKindRoots, type HomeLayout } from './kind-roots.ts';

export interface ResolveHomeOptions {
  purpose: 'cli' | 'server';
  env?: NodeJS.ProcessEnv;
  layout?: HomeLayout;
  platform?: NodeJS.Platform;
}

/** Resolve paths only. No filesystem reads, writes, markers or migrations. See ADR 0059. */
export function resolveHome({ env = process.env, layout = 'split',
  platform = process.platform }: ResolveHomeOptions): Home {
  const legacyHome = legacyHomeEnv(env);
  const preferredHome = preferredHomeEnv(env);
  const { join } = platform === 'win32' ? win32 : posix;
  const userHome = homedir();
  const legacyDefault = join(userHome, '.cezar');
  if (layout === 'legacy') {
    const root = legacyHome || legacyDefault;
    return kindHomePaths({ config: root, state: root, data: root, runtime: root,
      cache: join(userHome, '.cache', 'cez') }, layout, platform, legacyHome || undefined);
  }
  const { resolve } = platform === 'win32' ? win32 : posix;
  const normalize = (path: string) => platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const legacyOverride = legacyHome && normalize(legacyHome) !== normalize(legacyDefault)
    ? legacyHome : undefined;
  const override = preferredHome || legacyOverride || undefined;
  const layoutEnv = Object.fromEntries(HOME_LAYOUT_ENV.map(name => [name, env[name]]));
  const roots = override ? oneRootKinds(override, platform) : platformKindRoots(userHome, layoutEnv, platform);
  return kindHomePaths(roots, layout, platform, override);
}
