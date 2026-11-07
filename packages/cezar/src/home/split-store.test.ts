import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from './home.ts';
import { HomeStore, readHomeFile } from './store.ts';
import { VersionLog } from './version-log.ts';
import { acceptHomeRecovery, getHomeRecovery, restoreHomeRecovery } from './recovery.ts';
import { listBackups } from '../workspace/backups.ts';
import { restoreBackup } from '../workspace/backup-cli.ts';
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';

afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });

it.each(['config.json', 'server.json'])('routes split %s writes, journals, backups and recovery', async file => {
  const home = Home.sandbox(storeRoot(), { layout: 'split' });
  const root = file === 'server.json' ? home.state : home.config;
  const path = join(root, file);
  const store = new HomeStore(home);
  store.writeJson(path, { saved: 'first' });
  const first = readFileSync(path);
  store.writeJson(path, { saved: 'second' });
  const second = readFileSync(path);
  const journal = join(root, '.versions', file);
  const head = JSON.parse(readFileSync(join(journal, 'HEAD'), 'utf8')) as { hash: string };
  expect(readFileSync(join(journal, head.hash))).toEqual(second);
  const backup = listBackups(file, home)[0]!;
  expect(backup.path.startsWith(join(home.state, 'backups', file))).toBe(true);
  expect(readFileSync(backup.path)).toEqual(first);
  writeFileSync(path, '{"outside":true}'); // Deliberate outside write in the file's own root.
  expect(getHomeRecovery(home).files).toContainEqual(expect.objectContaining({ file, reason: 'outside-write', canRestore: true }));
  await restoreHomeRecovery(home, file);
  expect(readFileSync(path)).toEqual(second);
  expect(getHomeRecovery(home)).toEqual({ files: [] });
  writeFileSync(path, '{"accepted":true}'); // Exercise acceptance through the same key.
  acceptHomeRecovery(home, file);
  expect(JSON.parse(store.read(path))).toEqual({ accepted: true });
  await restoreBackup(file, backup.time, home);
  // Config restore keeps its existing tolerant schema/default conversion.
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ saved: 'first' });
  expect(existsSync(join(home.state, 'install.json'))).toBe(false);
});

it.each(['config.json', 'server.json'])('locks the owning root for split %s readers and writers', file => {
  const home = Home.sandbox(storeRoot(), { layout: 'split' });
  const root = file === 'server.json' ? home.state : home.config;
  const other = file === 'server.json' ? home.config : home.state;
  const path = join(root, file);
  const inspect = VersionLog.prototype.inspect;
  const held: string[][] = [];
  vi.spyOn(VersionLog.prototype, 'inspect').mockImplementation(function(this: VersionLog, bytes) {
    held.push(readdirSync(join(root, '.locks', 'write.lock')).filter(name => name.endsWith('.json')));
    expect(existsSync(join(other, '.locks', 'write.lock')) && readdirSync(join(other, '.locks', 'write.lock')).some(name => name.endsWith('.json'))).toBe(false);
    return inspect.call(this, bytes);
  });
  const store = new HomeStore(home);
  store.writeJson(path, { saved: true });
  expect(JSON.parse(readHomeFile(path, home))).toEqual({ saved: true });
  expect(held).toHaveLength(2);
  for (const claims of held) expect(claims).toHaveLength(1);
});

it('always checks the config marker before a split state mutation', () => {
  const home = Home.sandbox(storeRoot(), { layout: 'split' });
  mkdirSync(home.state, { recursive: true });
  writeFileSync(join(home.state, 'install.json'), readFileSync(join(home.config, 'install.json'))); // A state marker is never authority.
  rmSync(join(home.config, 'install.json'));
  expect(() => new HomeStore(home).writeJson(home.serverState(), {})).toThrow(/without an install marker/);
  expect(existsSync(home.serverState())).toBe(false);
});
