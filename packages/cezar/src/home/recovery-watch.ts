import { existsSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { Home } from './home.ts';
import { onHomeChange } from './changes.ts';
import { getHomeRecovery, recoveryFiles } from './recovery.ts';

/** A subscription owns its watchers; no timer or watcher survives the last listener. */
export function subscribeHomeRecovery(home: Home, listener: () => void): () => void {
  let closed = false;
  let scheduled = false;
  const watchers = new Map<string, FSWatcher>();
  const directories = [home.root, home.remoteSettings, home.serverInstances, join(home.root, '.versions'),
    join(home.root, '.versions', 'remote-settings'), join(home.root, '.versions', 'server-instances')];
  const schedule = () => {
    if (closed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (closed) return;
      bind();
      getHomeRecovery(home); // Inspect changed files before publishing the authoritative snapshot.
      listener();
    });
  };
  const bind = () => {
    for (const directory of [...directories, ...recoveryFiles(home).map(file => join(home.root, '.versions', file))]) {
      if (watchers.has(directory)) continue;
      try {
        const watcher = watch(directory, { persistent: false }, () => {
          if (!existsSync(directory)) { watcher.close(); watchers.delete(directory); }
          schedule();
        });
        watcher.on('error', () => { watcher.close(); watchers.delete(directory); });
        watchers.set(directory, watcher);
      } catch { /* Parent watcher will retry when a missing family is created. */ }
    }
  };
  bind();
  const unsubscribe = onHomeChange(home.root, schedule);
  // Close the subscribe/initial-snapshot race after the watches are installed.
  schedule();
  return () => {
    closed = true;
    unsubscribe();
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };
}
