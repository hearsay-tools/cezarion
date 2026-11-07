import { join, relative, resolve, sep } from 'node:path';
import { homeFileSchema, type HomeFile } from '@open-mercato/cezar-contract/home-recovery';
import type { Home } from './home.ts';

/** One map for stores, migration, backup keys and recovery. HomeFile keys never change. */
export function homeFileKind(file: HomeFile): 'config' | 'state' {
  homeFileSchema.parse(file);
  return file === 'ui-state.json' || file === 'server.json' || file === 'server.install.lock'
    || file.startsWith('server-instances/') ? 'state' : 'config';
}

export function homeFileLocation(home: Home, file: HomeFile): { root: string; path: string; file: HomeFile } {
  const root = home[homeFileKind(file)];
  return { root, path: join(root, file), file };
}

/** A string root retains the legacy path-based API. Split state readers pass their Home. */
export function homePathLocation(home: Home | string, path: string): { root: string; file: HomeFile } {
  const roots = typeof home === 'string' ? [home] : [...new Set([home.config, home.state])];
  for (const root of roots) {
    const file = relative(resolve(root), resolve(path)).split(sep).join('/');
    if (homeFileSchema.safeParse(file).success
      && (typeof home === 'string' || home[homeFileKind(file)] === root)) return { root, file };
  }
  throw new Error(`Not a HomeStore file: ${path}`);
}
