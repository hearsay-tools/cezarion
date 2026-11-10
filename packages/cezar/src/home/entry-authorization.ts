import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Home } from './home.ts';
import type { InstallMarker } from './install-marker.ts';
import type { HomeStore } from './store.ts';
import { homePathLocation } from './file-location.ts';

interface EntryAuthorization { home: Home; entry: string; kind: InstallMarker['kind']; seeded: boolean; beforeWrite?: (() => void) | undefined }
const entries = new Map<string, EntryAuthorization>();

/** Authorization stays in this process; resolving or reading an empty home writes nothing. */
export function authorizeHomeEntry(home: Home, entry: string, kind: InstallMarker['kind'], beforeWrite?: () => void): void {
  entries.set(resolve(home.root), { home, entry, kind, seeded: false, beforeWrite });
}

export function homeEntryAuthorization(root: string): EntryAuthorization | undefined {
  return entries.get(resolve(root));
}

export function registryFiles(home: Home): string[] {
  const files = [home.workspaceConfig, `${home.workspaceConfig}.bak`, home.agentAccounts, home.workspaceUiState, home.serverState()];
  for (const dir of [home.remoteSettings, home.serverInstances]) {
    try { files.push(...readdirSync(dir).filter(name => /^[a-zA-Z0-9-]+\.json$/.test(name)).map(name => join(dir, name))); }
    catch { /* An unreadable family must not hide the other registry families. Retry at entry. */ }
  }
  return files;
}

/** Caller holds write.lock. Recovery snapshots remain auxiliary during first-write seeding. */
export function seedHomeRegistry(store: HomeStore, files: readonly string[], home: Home): boolean {
  let complete = true;
  for (const path of files) {
    const { root, file } = homePathLocation(home, path);
    const head = join(root, '.versions', file, 'HEAD');
    if (existsSync(head)) continue;
    try { store.read(path); } catch { /* Absence is normal; failed reads leave HEAD absent. */ }
    if (!existsSync(head)) complete = false;
  }
  return complete;
}
