import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Home, homePaths } from './home.ts';
import { prepareHomeLifecycle } from './entry.ts';
import { readCockpitLeases } from './leases.ts';
import { HomeStore } from './store.ts';
import { childEnv, cleanStoreRoots, storeFixture, storeRoot } from './store.testkit.ts';

const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }));
  cleanStoreRoots();
});

it('prepares embedded server homes and keeps their lease until close', async () => {
  const root = storeRoot();
  const home = homePaths(root, join(root, 'cache'), root);
  const server = createServer();
  prepareHomeLifecycle(home)(server);
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    expect(readCockpitLeases(home)).toHaveLength(1);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
  expect(readCockpitLeases(home)).toEqual([]);
});

it('keeps two serving cockpits independent and prunes a dead pid lease', async () => {
  const home = Home.sandbox(storeRoot());
  const serve = async (port: number) => {
    const child = spawn(process.execPath, ['--import', 'tsx', storeFixture, home.root, 'lease', String(port)], { env: childEnv(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child);
    await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('Lease child exited before readiness'); })]);
    return child;
  };
  const first = await serve(4321);
  await serve(4322);
  expect(readCockpitLeases(home).map(lease => lease.port).sort()).toEqual([4321, 4322]);
  Home.seed(home, home.workspaceConfig, { shared: true });
  expect(JSON.parse(new HomeStore(home).read(home.workspaceConfig))).toEqual({ shared: true });
  const exited = once(first, 'exit');
  first.kill('SIGKILL');
  await exited;
  expect(readCockpitLeases(home).map(lease => lease.port)).toEqual([4322]);
  expect(readdirSync(join(home.root, '.locks/cockpits'))).toHaveLength(1);
});

it('removes unique stale write claims without removing a live owner', () => {
  const home = Home.sandbox(storeRoot());
  const path = join(home.root, '.locks/write.lock', 'stale.json');
  writeFileSync(path, JSON.stringify({ pid: 999999999, ticket: 0 }));
  Home.seed(home, home.workspaceConfig, {});
  expect(readdirSync(join(home.root, '.locks/write.lock'))).toEqual([]);
});
