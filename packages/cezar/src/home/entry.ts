import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Home } from './home.ts';
import type { ServerType } from '@hono/node-server';
import { underTestRunner } from './install-marker.ts';
import { prepareMigrationHome, type MigrationBootOptions } from './migration-boot.ts';
import { holdCockpitLease } from './leases.ts';
import { HomeStore, readHomeFile } from './store.ts';
import { REBRAND_SWITCH } from './switch.ts';
import { authorizeHomeEntry, registryFiles } from './entry-authorization.ts';

export type HomeEntry = 'serve' | 'init' | 'run' | 'projects' | 'backup' | 'remote-settings'
  | 'install' | 'update' | 'use' | 'link' | 'unlink' | 'server-install' | 'server-deploy' | 'server-uninstall' | 'migrate'
  | 'server-migrate';

const entries: readonly string[] = ['serve', 'init', 'run', 'projects', 'backup', 'remote-settings',
  'install', 'update', 'use', 'link', 'unlink', 'server-install', 'server-deploy', 'server-uninstall'];

/** Backup listing is a pure read; restore retains its unconditional preparation. */
export function operatorHomeEntry(argv: readonly string[]): string | undefined {
  return argv[0] === 'backup' && argv[1] !== 'restore' ? 'backup-read' : argv[0];
}

/** Boot must still work with a read-only home. Mutations retain their own throwing contracts. */
export function prepareOperatorHome(home: Home, command: string | undefined, env = process.env, migration?: MigrationBootOptions): Home {
  command ??= 'serve';
  if (!entries.includes(command)) return home;
  if (prepareMigrationHome(home, env, migration)) return home;
  authorizeHomeEntry(home, command, markerKind(command, env));
  try {
    if (['serve', 'init', 'run', 'backup'].includes(command) || registryFiles(home).some(path => existsSync(path))) {
      prepareHome(home, command as HomeEntry, env);
    }
  } catch (error) {
    console.warn(`[cez] home registry unavailable (${error instanceof Error ? error.message : String(error)}) — continuing without it`);
  }
  return home;
}

function markerKind(entry: string, env: NodeJS.ProcessEnv) {
  return underTestRunner() ? 'test' : (entry === 'serve' || entry === 'init') && env.CEZ_DRY_RUN === '1' ? 'dev' : 'live';
}

/** Explicit authorization at operator entry points. Resolution itself stays free of IO. */
export function prepareHome(home: Home, entry: HomeEntry, env: NodeJS.ProcessEnv = process.env): void {
  authorizeHomeEntry(home, entry, markerKind(entry, env));
  new HomeStore(home).transaction(() => {});
}

/** The server record whose port this cockpit serves names its lease; server-migrate reports it. */
export function serverInstanceForPort(home: Home, port: number): string {
  const records: Array<[string, string]> = [['default', home.serverState()]];
  try {
    for (const name of readdirSync(home.serverInstances)) if (/^[a-z0-9-]+\.json$/.test(name)) records.push([name.slice(0, -5), join(home.serverInstances, name)]);
  } catch { /* No named instances. */ }
  for (const [instance, path] of records) {
    try { if ((JSON.parse(readHomeFile(path, home)).primaryPort ?? 4321) === port) return instance; } catch { /* Absent or unreadable. */ }
  }
  return 'default';
}

/** Prepare before server consumers read, then hold presence only for the listener's lifetime. */
export function prepareHomeLifecycle(home: Home, instance?: string, { rebrand = REBRAND_SWITCH } = {}): (server: ServerType) => void {
  prepareOperatorHome(home, 'serve');
  return server => {
    const listening = () => {
      const address = server.address();
      if (!address || typeof address !== 'object') return;
      try {
        const name = instance ?? (rebrand ? serverInstanceForPort(home, address.port) : 'default');
        const release = holdCockpitLease(home, address.port, name);
        server.once('close', () => { try { release(); } catch { /* Presence is advisory. */ } });
      } catch { /* A read-only home must not stop the cockpit. */ }
    };
    if (server.listening) listening();
    else server.once('listening', listening);
  };
}
