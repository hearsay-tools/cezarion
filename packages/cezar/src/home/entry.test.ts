import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { homePaths } from './home.ts';
import { operatorHomeEntry, prepareOperatorHome } from './entry.ts';
import { readInstallMarker } from './install-marker.ts';
import { HomeStore } from './store.ts';
import { VersionLog } from './version-log.ts';
import { cleanStoreRoots, storeChild, storeRoot } from './store.testkit.ts';

afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });
const conditional = ['projects', 'remote-settings', 'server-install', 'server-deploy', 'server-uninstall'];

it.each(conditional)('the %s entry and reads leave an empty home untouched', command => {
  const root = storeRoot();
  const home = homePaths(root, join(root, 'cache'), root);
  prepareOperatorHome(home, command);
  expect(() => new HomeStore(home).read(home.workspaceConfig)).toThrow(/ENOENT/);
  expect(readdirSync(root)).toEqual([]);
  // The authorization must not reach a child process, even when it knows the same path.
  expect(() => storeChild(root, 'write', '{}')).toThrow(/without an install marker/);
  expect(readdirSync(root)).toEqual([]);
});

it.each(conditional)('the first %s write seeds and writes inside one lock', command => {
  const root = storeRoot();
  const home = homePaths(root, join(root, 'cache'), root);
  prepareOperatorHome(home, command, {});
  const original = VersionLog.prototype.replace;
  const replace = vi.spyOn(VersionLog.prototype, 'replace').mockImplementation(function(this: VersionLog, path, bytes) {
    expect(readInstallMarker(root)?.kind).toBe('test');
    expect(readdirSync(join(root, '.locks/write.lock')).filter(name => name.endsWith('.json'))).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(root, '.versions/config.json/HEAD'), 'utf8'))).toEqual({ hash: null });
    return original.call(this, path, bytes);
  });
  new HomeStore(home).writeJson(home.workspaceConfig, { saved: true });
  expect(replace).toHaveBeenCalledOnce();
  expect(JSON.parse(readFileSync(home.workspaceConfig, 'utf8'))).toEqual({ saved: true });
});

it.each(conditional)('the %s entry seeds an existing install without changing its registry', command => {
  const root = storeRoot();
  const home = homePaths(root, join(root, 'cache'), root);
  const bytes = '{"saved":true}\n';
  writeFileSync(home.agentAccounts, bytes); // Pre-marker install input.
  prepareOperatorHome(home, command);
  expect(readInstallMarker(root)?.kind).toBe('test');
  expect(existsSync(join(root, '.versions/agent-accounts.json/HEAD'))).toBe(true);
  expect(readFileSync(home.agentAccounts, 'utf8')).toBe(bytes);
});

it('keeps backup listing and invalid restore input read-only, and a valid restore unconditional', () => {
  const root = storeRoot();
  const home = homePaths(root, join(root, 'cache'), root);
  prepareOperatorHome(home, operatorHomeEntry(['backup', 'list']));
  expect(readdirSync(root)).toEqual([]);
  prepareOperatorHome(home, operatorHomeEntry(['backup', 'restore']));
  expect(readdirSync(root)).toEqual([]);
  prepareOperatorHome(home, operatorHomeEntry(['backup', 'restore', 'config.json']));
  expect(readInstallMarker(root)?.kind).toBe('test');
});
