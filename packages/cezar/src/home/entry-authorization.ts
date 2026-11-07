import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Home } from './home.ts';
import type { InstallMarker } from './install-marker.ts';
import type { HomeStore } from './store.ts';

interface EntryAuthorization { home: Home; entry: string; kind: InstallMarker['kind'] }
const entries = new Map<string, EntryAuthorization>();

/** Authorization stays in this process; resolving or reading an empty home writes nothing. */
export function authorizeHomeEntry(home: Home, entry: string, kind: InstallMarker['kind']): void {
  entries.set(resolve(home.root), { home, entry, kind });
}

export function homeEntryAuthorization(root: string): EntryAuthorization | undefined {
  return entries.get(resolve(root));
}

export function registryFiles(home: Home): string[] {
  const files = [home.workspaceConfig, `${home.workspaceConfig}.bak`, home.agentAccounts, home.workspaceUiState, home.serverState()];
  for (const dir of [home.remoteSettings, home.serverInstances]) {
    try { files.push(...readdirSync(dir).filter(name => /^[a-zA-Z0-9-]+\.json$/.test(name)).map(name => join(dir, name))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return files;
}

/** Caller holds write.lock. Recovery snapshots remain auxiliary during first-write seeding. */
export function seedHomeRegistry(store: HomeStore, home: Home, files: readonly string[]): void {
  const backup = `${home.workspaceConfig}.bak`;
  for (const path of files.filter(path => path !== backup)) {
    try { store.read(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  try { store.read(backup); } catch { /* Its writer reports an unavailable snapshot when needed. */ }
}
