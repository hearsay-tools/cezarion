import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Home } from './home.ts';
import { HomeStore } from './store.ts';
import { readInstallMarker } from './install-marker.ts';
import { cleanStoreRoots, storeChild, storeRoot } from './store.testkit.ts';

afterEach(cleanStoreRoots);

it('seeds an existing install without changing any live bytes or mode', () => {
  const dir = storeRoot();
  const path = join(dir, 'config.json');
  const bytes = '{ "unknown": true, "projects": [] }';
  writeFileSync(path, bytes, { mode: 0o640 });
  const before = statSync(path);
  storeChild(dir, 'prepare', 'serve');
  expect(readFileSync(path, 'utf8')).toBe(bytes);
  expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
  expect(statSync(path).mode).toBe(before.mode);
  expect(readInstallMarker(dir)?.kind).toBe('live');
  expect(storeChild(dir, 'outside').trim()).toBe('null');
  const hash = createHash('sha256').update(bytes).digest('hex');
  expect(JSON.parse(readFileSync(join(dir, '.versions/config.json/HEAD'), 'utf8'))).toEqual({ hash });
});

it('pins HEAD on an outside write and restores it after later writes with enforcement off', () => {
  const dir = storeRoot();
  storeChild(dir, 'prepare', 'run');
  storeChild(dir, 'write', '{"original":true}');
  const path = join(dir, 'config.json');
  const original = readFileSync(path);
  writeFileSync(path, '{"outside":true}'); // Deliberate bypass: this is the behavior under test.
  storeChild(dir, 'read');
  const flag = JSON.parse(storeChild(dir, 'outside'));
  expect(flag.restoreHash).toBe(createHash('sha256').update(original).digest('hex'));
  storeChild(dir, 'write', '{"later":true}');
  expect(JSON.parse(storeChild(dir, 'outside')).restoreHash).toBe(flag.restoreHash);
  storeChild(dir, 'restore');
  expect(readFileSync(path)).toEqual(original);
  expect(storeChild(dir, 'outside').trim()).toBe('null');
});

it.each(['version', 'pending-old', 'pending-new', 'head', 'committed'])('recovers %s journal steps without a flag', state => {
  const home = Home.sandbox(storeRoot());
  const store = new HomeStore(home);
  Home.seed(home, home.workspaceConfig, { old: true });
  const bytes = Buffer.from('{"new":true}');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const log = join(home.root, '.versions/config.json');
  writeFileSync(join(log, hash), bytes);
  if (state !== 'version' && state !== 'committed') writeFileSync(join(log, 'PENDING'), JSON.stringify({ hash }));
  const replaced = ['pending-new', 'head', 'committed'].includes(state);
  if (replaced) writeFileSync(home.workspaceConfig, bytes);
  if (state === 'head' || state === 'committed') writeFileSync(join(log, 'HEAD'), JSON.stringify({ hash }));
  expect(store.outsideWrite(home.workspaceConfig)).toBeUndefined();
  expect(readdirSync(log)).not.toContain('PENDING');
  expect(JSON.parse(store.read(home.workspaceConfig))).toEqual(replaced ? { new: true } : { old: true });
});

it.each(['.locks/write.lock', '.versions/config.json'])('keeps readable live data when %s is read-only', directory => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  const dir = storeRoot();
  storeChild(dir, 'prepare', 'run');
  storeChild(dir, 'write', '{"saved":true}');
  const path = join(dir, directory);
  if (directory.startsWith('.versions')) rmSync(join(path, 'HEAD'));
  chmodSync(path, 0o500);
  try { expect(JSON.parse(storeChild(dir, 'read'))).toEqual({ saved: true }); }
  finally { chmodSync(path, 0o700); }
});

it('treats an older stored version as an outside write and can restore an absent HEAD', () => {
  const home = Home.sandbox(storeRoot());
  const store = new HomeStore(home);
  Home.seed(home, home.workspaceConfig, { old: true });
  const old = readFileSync(home.workspaceConfig);
  Home.seed(home, home.workspaceConfig, { next: true });
  writeFileSync(home.workspaceConfig, old); // Replaying a known version is still outside HomeStore.
  expect(store.outsideWrite(home.workspaceConfig)).toBeDefined();
  const absent = home.workspaceUiState;
  expect(() => store.read(absent)).toThrow(/ENOENT/);
  writeFileSync(absent, '{}'); // First external create must pin the absent HEAD.
  expect(store.outsideWrite(absent)?.restoreHash).toBeNull();
  store.restoreOutsideWrite(absent);
  expect(() => readFileSync(absent)).toThrow(/ENOENT/);
});
