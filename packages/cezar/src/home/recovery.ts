import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { homeFileSchema, type HomeFile, type HomeRecovery, type HomeRecoveryFile } from '@open-mercato/cezar-contract/home-recovery';
import type { Home } from './home.ts';
import { registryFiles } from './entry-authorization.ts';
import { HomeStore } from './store.ts';
import { restoreBackup } from '../workspace/backup-cli.ts';
export { subscribeHomeRecovery } from './recovery-watch.ts';

interface CachedFile { fingerprint: string; state: HomeRecoveryFile | undefined; pinnedPath?: string | undefined }
const caches = new Map<string, Map<HomeFile, CachedFile>>();

function stamp(path: string): string {
  try { const s = statSync(path); return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
  catch { return 'unavailable'; }
}

export function recoveryFiles(home: Home): HomeFile[] {
  const files = new Set(registryFiles(home).map(path => relative(home.root, path).replaceAll('\\', '/')));
  files.add('server.install.lock');
  // Include journals of deleted files: absence is itself an outside write.
  for (const dir of ['.versions', 'remote-settings', 'server-instances', '.versions/remote-settings', '.versions/server-instances']) {
    try {
      for (const name of readdirSync(join(home.root, dir))) {
        const family = dir.replace(/^\.versions\/?/, '');
        files.add(family ? `${family}/${name}` : name);
      }
    } catch { /* Missing or unreadable auxiliary families never prevent boot. */ }
  }
  return [...files].filter((file): file is HomeFile => homeFileSchema.safeParse(file).success).sort();
}

/** Metadata checks avoid reacquiring every HomeStore lock on repeated cockpit requests. */
export function getHomeRecovery(home: Home): HomeRecovery {
  let cache = caches.get(home.root);
  if (!cache) { cache = new Map(); caches.set(home.root, cache); }
  const store = new HomeStore(home);
  const files: HomeRecoveryFile[] = [];
  for (const file of recoveryFiles(home)) {
    const path = join(home.root, file);
    const journal = join(home.root, '.versions', file);
    const fingerprint = [path, journal, ...['HEAD', 'OUTSIDE', 'RESET', 'ACCEPTED'].map(name => join(journal, name)),
      ...(file === 'config.json' ? [`${path}.bak`, join(home.backups, file)] : []),
      ...(cache.get(file)?.pinnedPath ? [cache.get(file)!.pinnedPath!] : [])].map(stamp).join('|');
    let entry = cache.get(file);
    if (!entry || entry.fingerprint !== fingerprint) {
      try {
        const recovery = store.recovery(path);
        const state = recovery ? { file, reason: recovery.reason, detectedAt: recovery.detectedAt, canRestore: recovery.canRestore } : undefined;
        entry = { fingerprint, state, pinnedPath: recovery?.restoreHash ? join(journal, recovery.restoreHash) : undefined };
        cache.set(file, entry);
      } catch { /* Read-only or corrupt auxiliary state leaves the cockpit available. Retry next demand. */ }
    }
    if (entry?.state) files.push(entry.state);
  }
  return { files };
}

/** Both HTTP and CLI restores select the same pinned target, then the same backup writer. */
export async function restoreHomeRecovery(home: Home, file: HomeFile): Promise<void> {
  homeFileSchema.parse(file);
  await restoreBackup(file, undefined, home);
}

export function acceptHomeRecovery(home: Home, file: HomeFile): void {
  homeFileSchema.parse(file);
  new HomeStore(home).acceptOutsideWrite(join(home.root, file));
}
