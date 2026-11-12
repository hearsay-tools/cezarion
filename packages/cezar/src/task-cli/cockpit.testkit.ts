import { testHome } from '../home/test-home.testkit.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { RunStore } from '../runs/store.ts';
import { connectedProviderAuth } from '../server/provider-auth.testkit.ts';
import { createApp } from '../server/server.ts';
import { RunManager } from '../workflows/run.ts';
import { acquireInertCiResources } from '../ci-wait/inert-ci-resources.testkit.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import type { Cockpit } from './http.ts';
import { createRunner } from '../core/runner-factory.ts';

/**
 * A real cockpit app on a real loopback socket for `cez task` tests (#504). No agent slot is
 * free (`maxParallel: 0`), so every run stays `queued` and nothing spawns; tests move runs to
 * other states through the store, the way the engine would.
 */
export interface TestCockpit {
  repoRoot: string;
  store: RunStore;
  manager: RunManager;
  cockpit: Cockpit;
  close(): Promise<void>;
}

export async function startTestCockpit(): Promise<TestCockpit> {
  const savedDryRun = process.env.CEZ_DRY_RUN;
  process.env.CEZ_DRY_RUN = '1';
  const repoRoot = mkdtempSync(join(tmpdir(), 'cez-task-cli-'));
  const store = RunStore.open(join(repoRoot, '.ai/cezar'));
  const manager = new RunManager(store, repoRoot, { acquireCiResources: acquireInertCiResources, createRunner, home: testHome(), semaphore: new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 } }) });
  const app = createApp({ home: testHome(), repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  const server = await new Promise<ServerType>((resolve) => {
    const started = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(started));
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    repoRoot, store, manager,
    cockpit: { origin, projectId: 'default', api: `${origin}/api/v1/p/default` },
    async close() {
      // SSE handlers hold connections open; drop them so close() can finish.
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      manager.dispose();
      store.close();
      rmSync(repoRoot, { recursive: true, force: true });
      if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = savedDryRun;
    },
  };
}
