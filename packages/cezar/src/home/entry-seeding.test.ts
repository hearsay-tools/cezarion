import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home, homePaths } from './home.ts';
import { prepareHome, prepareOperatorHome } from './entry.ts';
import { HomeStore } from './store.ts';
import { VersionLog } from './version-log.ts';
import * as files from './private-files.ts';
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';

afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });

it.each(['later entry', 'later write'])('seeds other files after a read failure and retries at a %s', retry => {
  const root = storeRoot();
  const home = homePaths(root, join(root, 'cache'), root);
  writeFileSync(home.workspaceConfig, '{"saved":"config"}'); // Existing install before its marker.
  writeFileSync(home.agentAccounts, '{"saved":"accounts"}');
  const original = HomeStore.prototype.read;
  const read = vi.spyOn(HomeStore.prototype, 'read').mockImplementation(function(this: HomeStore, path) {
    if (path === home.workspaceConfig) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
    return original.call(this, path);
  });
  prepareHome(home, 'projects');
  const configHead = join(root, '.versions/config.json/HEAD');
  const accountHead = join(root, '.versions/agent-accounts.json/HEAD');
  expect(existsSync(configHead)).toBe(false);
  expect(existsSync(accountHead)).toBe(true);
  const committed = readFileSync(accountHead);
  // A caller's unrelated write must still succeed while config cannot be seeded.
  new HomeStore(home).writeJson(home.workspaceUiState, { saved: true });
  expect(JSON.parse(readFileSync(home.workspaceUiState, 'utf8'))).toEqual({ saved: true });
  read.mockRestore();
  if (retry === 'later entry') prepareOperatorHome(home, 'projects');
  else new HomeStore(home).writeJson(home.workspaceUiState, { saved: 'again' });
  expect(existsSync(configHead)).toBe(true);
  expect(readFileSync(accountHead)).toEqual(committed);
  writeFileSync(home.agentAccounts, '{"outside":true}'); // Deliberate outside write after seeding.
  expect(new HomeStore(home).outsideWrite(home.agentAccounts)).toHaveProperty('restoreHash');
});

it('seeds on the first authorized write even if a marker already exists', () => {
  const root = storeRoot();
  const home = homePaths(root, join(root, 'cache'), root);
  prepareOperatorHome(home, 'projects');
  Home.sandbox(root); // Another caller creates the marker after entry authorization.
  writeFileSync(home.agentAccounts, '{"saved":true}'); // Pre-journal registry input.
  const head = join(root, '.versions/agent-accounts.json/HEAD');
  expect(existsSync(head)).toBe(false);
  new HomeStore(home).writeJson(home.workspaceUiState, {});
  expect(existsSync(head)).toBe(true);
});

it('holds the same claim from marker publication through every seeded HEAD', () => {
  const root = storeRoot();
  const home = homePaths(root, join(root, 'cache'), root);
  writeFileSync(home.workspaceConfig, '{"saved":true}'); // Pre-marker install input.
  const claims = () => readdirSync(join(root, '.locks/write.lock')).filter(name => name.endsWith('.json'));
  const replace = files.replacePrivate;
  let markerClaims: string[] = [];
  vi.spyOn(files, 'replacePrivate').mockImplementation((path, bytes) => {
    replace(path, bytes);
    if (path === join(root, 'install.json')) {
      markerClaims = claims();
    }
  });
  const inspect = VersionLog.prototype.inspect;
  const seedClaims: string[][] = [];
  vi.spyOn(VersionLog.prototype, 'inspect').mockImplementation(function(this: VersionLog, bytes) {
    seedClaims.push(claims());
    return inspect.call(this, bytes);
  });
  prepareHome(home, 'projects');
  expect(markerClaims).toHaveLength(1);
  expect(seedClaims.length).toBeGreaterThan(0);
  for (const held of seedClaims) expect(held).toEqual(markerClaims);
  expect(claims()).toEqual([]);
});
