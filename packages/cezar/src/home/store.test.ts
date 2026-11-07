import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Home, homePaths } from './home.ts';
import { HomeStore, readHomeFile } from './store.ts';
import { readInstallMarker } from './install-marker.ts';
import { prepareHome } from './entry.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { enableRemoteSettings } from '../remote-settings.ts';
import { childEnv, cleanStoreRoots, storeChild, storeFixture, storeRoot } from './store.testkit.ts';

afterEach(cleanStoreRoots);

it('refuses every registry file with a live marker under the actual test process, even with another env', async () => {
  const dir = storeRoot();
  storeChild(dir, 'prepare', 'run');
  const home = homePaths(dir, join(dir, 'cache'), dir);
  const store = new HomeStore(home);
  const files = [home.workspaceConfig, `${home.workspaceConfig}.bak`, home.agentAccounts, home.workspaceUiState,
    join(home.remoteSettings, '4321.json'), home.serverState(), home.serverState('other'), home.serverLock(), home.serverLock('other')];
  for (const path of files) expect(() => store.writeJson(path, {})).toThrow(/live home.*test runner/);
  await expect(enableRemoteSettings(4321, {}, new Date(), home)).rejects.toThrow(/live home/);
  await expect(mergeWriteWorkspaceConfig(() => ({} as never), home)).rejects.toThrow(/live home/);
  expect(() => Home.seed(Home.sandbox(dir), home.workspaceConfig, {})).toThrow(/test install marker/);
  expect(readInstallMarker(dir)?.kind).toBe('live');
  expect(readdirSync(dir).sort()).toEqual(['.locks', '.versions', 'install.json']);
});

it('rejects an unmarked library write without creating a marker', () => {
  const dir = storeRoot();
  expect(() => new HomeStore(dir).writeJson(join(dir, 'config.json'), {})).toThrow(/without an install marker/);
  expect(readdirSync(dir)).toEqual([]);
});

it('keeps saved registry data readable when auxiliary marker JSON is invalid', () => {
  const home = Home.sandbox(storeRoot());
  Home.seed(home, home.workspaceConfig, { saved: true });
  writeFileSync(join(home.root, 'install.json'), '{'); // Deliberately corrupt auxiliary metadata.
  expect(JSON.parse(readHomeFile(home.workspaceConfig))).toEqual({ saved: true });
  expect(() => new HomeStore(home).writeJson(home.workspaceConfig, {})).toThrow();
});

it.each(['VITEST', 'NODE_TEST_CONTEXT', 'JEST_WORKER_ID', 'STRYKER_MUTATOR'])('refuses a custom live home when the process has %s', runner => {
  const dir = storeRoot();
  storeChild(dir, 'prepare', 'run');
  expect(() => storeChild(dir, 'write', '{}', childEnv({ [runner]: '1' }))).toThrow(/live home.*test runner/);
  expect(readdirSync(dir)).not.toContain('config.json');
});

it.each(['remote-settings', 'server-instances'])('tracks ordinary registry files when the home itself is named %s', async name => {
  const home = Home.sandbox(join(storeRoot(), name));
  Home.seed(home, home.workspaceConfig, { projects: [] });
  writeFileSync(home.workspaceConfig, '{"outside":true}'); // Deliberate outside write.
  const { loadWorkspaceConfig } = await import('../workspace/config.ts');
  expect((await loadWorkspaceConfig(home.workspaceConfig)).outside).toBe(true);
  expect(new HomeStore(home).outsideWrite(home.workspaceConfig)).toHaveProperty('restoreHash');
});

it('a test-runner child creates a test marker and can write repeatedly', () => {
  const dir = storeRoot();
  const env = childEnv({ NODE_TEST_CONTEXT: 'child-v8' });
  storeChild(dir, 'prepare', 'run', env);
  storeChild(dir, 'write', '{"a":1}', env);
  storeChild(dir, 'write', '{"a":2}', env);
  expect(readInstallMarker(dir)?.kind).toBe('test');
  expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))).toEqual({ a: 2 });
});

it.each(['run', 'projects', 'remote-settings', 'backup', 'update'])('authorizes first writes from the %s entry point', entry => {
  const dir = storeRoot();
  storeChild(dir, 'prepare', entry);
  storeChild(dir, 'write', '{}');
  expect(readInstallMarker(dir)?.kind).toBe('live');
});

it.each(['serve', 'init'])('uses dev for dry %s and test under a runner', entry => {
  const dir = storeRoot();
  storeChild(dir, 'prepare', entry, childEnv({ CEZ_DRY_RUN: '1' }));
  expect(readInstallMarker(dir)?.kind).toBe('dev');
  const testDir = storeRoot();
  storeChild(testDir, 'prepare', entry, childEnv({ CEZ_DRY_RUN: '1', JEST_WORKER_ID: '1' }));
  expect(readInstallMarker(testDir)?.kind).toBe('test');
});

it('keeps every new marker, lock and version private', () => {
  if (process.platform === 'win32') return;
  const home = Home.sandbox(storeRoot());
  prepareHome(home, 'serve');
  Home.seed(home, home.workspaceConfig, { secret: 'private' });
  const walk = (path: string): void => {
    const stat = statSync(path);
    expect(stat.mode & 0o777).toBe(stat.isDirectory() ? 0o700 : 0o600);
    if (stat.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
  };
  walk(home.root);
});

it('serializes two independent writers without losing either update', async () => {
  const home = Home.sandbox(storeRoot());
  const run = () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', storeFixture, home.root, 'increment', '10'], { env: childEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  await Promise.all([run(), run()]);
  expect(JSON.parse(new HomeStore(home).read(home.workspaceConfig)).count).toBe(20);
});
