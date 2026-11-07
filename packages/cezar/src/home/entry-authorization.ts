import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Home } from './home.ts';
import type { InstallMarker } from './install-marker.ts';
import type { HomeStore } from './store.ts';

interface EntryAuthorization { home: Home; entry: string; kind: InstallMarker['kind']; seeded: boolean }
const entries = new Map<string, EntryAuthorization>();

/** Authorization stays in this process; resolving or reading an empty home writes nothing. */
export function authorizeHomeEntry(home: Home, entry: string, kind: InstallMarker['kind']): void {
  entries.set(resolve(home.root), { home, entry, kind, seeded: false });
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
export function seedHomeRegistry(store: HomeStore, files: readonly string[]): boolean {
  let complete = true;
  for (const path of files) {
    const head = join(store.root, '.versions', relative(store.root, path), 'HEAD');
    if (existsSync(head)) continue;
    try { store.read(path); } catch { /* Absence is normal; failed reads leave HEAD absent. */ }
    if (!existsSync(head)) complete = false;
  }
  return complete;
}
