import { posix, win32 } from 'node:path';

export type HomeLayout = 'legacy' | 'split';
export type HomeKind = 'config' | 'state' | 'data' | 'cache' | 'runtime';
export type HomeRoots = Readonly<Record<HomeKind, string>>;

/** Operator layout values remain available to agents. These are not home locators. */
export const HOME_LAYOUT_ENV: readonly string[] = [
  'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR',
];

export function oneRootKinds(root: string, platform: NodeJS.Platform): HomeRoots {
  const { join } = platform === 'win32' ? win32 : posix;
  return { config: join(root, 'config'), state: join(root, 'state'), data: join(root, 'data'),
    cache: join(root, 'cache'), runtime: join(root, 'run') };
}

/** Pure platform defaults, also used to protect passwd-home paths in test writers. */
export function platformKindRoots(userHome: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): HomeRoots {
  if (platform === 'win32') {
    const local = win32.join(env.LOCALAPPDATA || win32.join(userHome, 'AppData', 'Local'), 'Hearsay Squawk');
    return { config: win32.join(env.APPDATA || win32.join(userHome, 'AppData', 'Roaming'), 'Hearsay Squawk'),
      state: win32.join(local, 'state'), data: win32.join(local, 'data'),
      cache: win32.join(local, 'cache'), runtime: win32.join(local, 'run') };
  }
  if (platform === 'darwin') {
    const support = posix.join(userHome, 'Library', 'Application Support', 'Hearsay Squawk');
    return { config: posix.join(support, 'config'), state: posix.join(support, 'state'),
      data: posix.join(support, 'data'), cache: posix.join(userHome, 'Library', 'Caches', 'Hearsay Squawk'),
      runtime: posix.join(env.TMPDIR || '/tmp', 'hearsay-squawk') };
  }
  const xdg = (name: string, fallback: string) => posix.join(
    env[name] && posix.isAbsolute(env[name]) ? env[name] : posix.join(userHome, fallback), 'hearsay-squawk');
  const state = xdg('XDG_STATE_HOME', '.local/state');
  return { config: xdg('XDG_CONFIG_HOME', '.config'), state,
    data: xdg('XDG_DATA_HOME', '.local/share'), cache: xdg('XDG_CACHE_HOME', '.cache'),
    runtime: env.XDG_RUNTIME_DIR && posix.isAbsolute(env.XDG_RUNTIME_DIR)
      ? posix.join(env.XDG_RUNTIME_DIR, 'hearsay-squawk') : posix.join(state, 'run') };
}
