import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Home } from './home.ts';
import type { ServerType } from '@hono/node-server';
import { assertHomeWritable, createInstallMarker, underTestRunner } from './install-marker.ts';
import { holdCockpitLease } from './leases.ts';
import { HomeStore } from './store.ts';

export type HomeEntry = 'serve' | 'init' | 'run' | 'projects' | 'backup' | 'remote-settings'
  | 'install' | 'update' | 'use' | 'link' | 'unlink' | 'server-install' | 'server-deploy' | 'server-uninstall';

const entries: readonly string[] = ['serve', 'init', 'run', 'projects', 'backup', 'remote-settings',
  'install', 'update', 'use', 'link', 'unlink', 'server-install', 'server-deploy', 'server-uninstall'];

/** Boot must still work with a read-only home. Mutations retain their own throwing contracts. */
export function prepareOperatorHome(home: Home, command: string | undefined, env = process.env): Home {
  command ??= 'serve';
  if (!entries.includes(command)) return home;
  try { prepareHome(home, command as HomeEntry, env); } catch (error) {
    console.warn(`[cez] home registry unavailable (${error instanceof Error ? error.message : String(error)}) — continuing without it`);
  }
  return home;
}

function registryFiles(home: Home): string[] {
  const files = [home.workspaceConfig, `${home.workspaceConfig}.bak`, home.agentAccounts, home.workspaceUiState, home.serverState()];
  for (const dir of [home.remoteSettings, home.serverInstances]) {
    try { files.push(...readdirSync(dir).filter(name => /^[a-zA-Z0-9-]+\.json$/.test(name)).map(name => join(dir, name))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return files;
}

/** Explicit authorization at operator entry points. Resolution itself stays free of IO. */
export function prepareHome(home: Home, entry: HomeEntry, env: NodeJS.ProcessEnv = process.env): void {
  const store = new HomeStore(home);
  const files = registryFiles(home);
  store.assertBoundary(files);
  const kind = underTestRunner() ? 'test' : (entry === 'serve' || entry === 'init') && env.CEZ_DRY_RUN === '1' ? 'dev' : 'live';
  createInstallMarker(home.root, kind);
  assertHomeWritable(home.root);
  store.transaction(() => {
    for (const path of files) {
      try { store.read(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  });
}

/** Prepare before server consumers read, then hold presence only for the listener's lifetime. */
export function prepareHomeLifecycle(home: Home): (server: ServerType) => void {
  prepareOperatorHome(home, 'serve');
  return server => {
    const listening = () => {
      const address = server.address();
      if (!address || typeof address !== 'object') return;
      try {
        const release = holdCockpitLease(home, address.port);
        server.once('close', () => { try { release(); } catch { /* Presence is advisory. */ } });
      } catch { /* A read-only home must not stop the cockpit. */ }
    };
    if (server.listening) listening();
    else server.once('listening', listening);
  };
}
