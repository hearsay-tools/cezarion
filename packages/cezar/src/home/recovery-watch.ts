import { existsSync, watch, type FSWatcher } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Home } from './home.ts';
import { onHomeChange } from './changes.ts';
import { getHomeRecovery, recoveryFiles } from './recovery.ts';
import { homeFileLocation } from './file-location.ts';
import { legacyWatchDirectories } from './legacy-source.ts';

/** A subscription owns its watchers; no timer or watcher survives the last listener. */
export function subscribeHomeRecovery(home: Home, listener: () => void): () => void {
  let closed = false;
  let scheduled = false;
  const watchers = new Map<string, FSWatcher>();
  const directories = [home.config, home.state, home.remoteSettings, home.serverInstances,
    join(home.config, '.versions'), join(home.state, '.versions'),
    join(home.config, '.versions', 'remote-settings'), join(home.state, '.versions', 'server-instances')];
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
    const journals = recoveryFiles(home).map(file => join(homeFileLocation(home, file).root, '.versions', file));
    // Split state may not exist yet. Watch its nearest parent until the root appears.
    const roots = [home.config, home.state].map(existingParent);
    const legacy = legacyWatchDirectories(home).map(existingParent);
    const wanted = new Set([...directories, ...journals, ...roots, ...legacy]);
    for (const [directory, watcher] of watchers) {
      if (!wanted.has(directory)) { watcher.close(); watchers.delete(directory); }
    }
    for (const directory of wanted) {
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

function existingParent(path: string): string {
  while (!existsSync(path) && dirname(path) !== path) path = dirname(path);
  return path;
}
