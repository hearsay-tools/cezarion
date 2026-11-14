import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homeFileSchema, type HomeFile, type HomeRecovery, type HomeRecoveryFile } from '@open-mercato/cezar-contract/home-recovery';
import type { Home } from './home.ts';
import { registryFiles } from './entry-authorization.ts';
import { HomeStore } from './store.ts';
import { digest, readBytes } from './version-log.ts';
import { restorePinnedRecovery } from '../workspace/backup-cli.ts';
import { homeFileLocation, homePathLocation } from './file-location.ts';
import { getLegacyRecovery, resolveLegacyRecovery } from './legacy-recovery.ts';

interface CachedFile { fingerprint: string; state: HomeRecoveryFile | undefined; pinnedPath?: string | undefined }
const caches = new Map<string, Map<HomeFile, CachedFile>>();

function stamp(path: string): string {
  try {
    const s = statSync(path, { bigint: true });
    const metadata = `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    // Filesystems can report identical metadata for different bytes. Read content without
    // taking a HomeStore lock; unchanged fingerprints still reuse the recovery snapshot.
    return s.isFile() ? `${metadata}:${digest(readBytes(path))}` : metadata;
  }
  catch { return 'unavailable'; }
}

export function recoveryFiles(home: Home): HomeFile[] {
  const files = new Set(registryFiles(home).map(path => homePathLocation(home, path).file));
  files.add('server.install.lock');
  // Include journals of deleted files: absence is itself an outside write.
  for (const root of new Set([home.config, home.state])) {
    for (const dir of ['.versions', 'remote-settings', 'server-instances', '.versions/remote-settings', '.versions/server-instances']) {
      try {
        for (const name of readdirSync(join(root, dir))) {
          const family = dir.replace(/^\.versions\/?/, '');
          const file = family ? `${family}/${name}` : name;
          if (homeFileSchema.safeParse(file).success && homeFileLocation(home, file).root === root) files.add(file);
        }
      } catch { /* Missing or unreadable auxiliary families never prevent boot. */ }
    }
  }
  return [...files].filter((file): file is HomeFile => homeFileSchema.safeParse(file).success).sort();
}

/** Content fingerprints avoid reacquiring every HomeStore lock on repeated cockpit requests. */
export function getHomeRecovery(home: Home): HomeRecovery {
  const key = JSON.stringify([home.config, home.state]);
  let cache = caches.get(key);
  if (!cache) { cache = new Map(); caches.set(key, cache); }
  const store = new HomeStore(home);
  const files: HomeRecoveryFile[] = [];
  for (const file of recoveryFiles(home)) {
    const { path, root } = homeFileLocation(home, file);
    const journal = join(root, '.versions', file);
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
  // A live-file incident takes precedence. Offer the legacy row once that incident resolves.
  files.push(...getLegacyRecovery(home).filter(legacy => !files.some(file => file.file === legacy.file)));
  return { files };
}

/** Recovery shares the CLI's pinned writer; an already resolved incident never falls back. */
export async function restoreHomeRecovery(home: Home, file: HomeFile, detectedAt?: string): Promise<void> {
  homeFileSchema.parse(file);
  restorePinnedRecovery(file, home, detectedAt);
}

export function acceptHomeRecovery(home: Home, file: HomeFile, detectedAt?: string): void {
  homeFileSchema.parse(file);
  const store = new HomeStore(home);
  const path = homeFileLocation(home, file).path;
  if (!store.recovery(path)) resolveLegacyRecovery(home, file, detectedAt, 'ignore');
  else store.acceptRecovery(path, detectedAt);
}

export function importHomeRecovery(home: Home, file: HomeFile, detectedAt?: string): void {
  resolveLegacyRecovery(home, file, detectedAt, 'import');
}
