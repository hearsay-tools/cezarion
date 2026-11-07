import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from './home.ts';
import { HomeStore } from './store.ts';
import { getHomeRecovery } from './recovery.ts';
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';

vi.hoisted(() => vi.resetModules());
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, statSync: vi.fn(fs.statSync) };
});
afterEach(() => { vi.mocked(statSync).mockReset(); vi.restoreAllMocks(); cleanStoreRoots(); });

function holdMetadata(path: string): void {
  const snapshot = statSync(path, { bigint: true });
  const original = vi.mocked(statSync).getMockImplementation()!;
  vi.mocked(statSync).mockImplementation((...args) => String(args[0]) === path ? snapshot : original(...args));
}

it('detects changed content when all metadata fields stay unchanged, without a watch subscriber', () => {
  const home = Home.sandbox(storeRoot());
  Home.seed(home, home.workspaceUiState, { value: 'old' });
  holdMetadata(home.workspaceUiState);
  getHomeRecovery(home);
  expect(getHomeRecovery(home)).toEqual({ files: [] });
  const metadata = statSync(home.workspaceUiState, { bigint: true });
  const transaction = vi.spyOn(HomeStore.prototype, 'transaction');
  expect(getHomeRecovery(home)).toEqual({ files: [] });
  expect(transaction).not.toHaveBeenCalled();
  const outside = readFileSync(home.workspaceUiState, 'utf8').replace('old', 'new');
  writeFileSync(home.workspaceUiState, outside); // Deliberate same-size outside write on a coarse-timestamp filesystem.
  expect(statSync(home.workspaceUiState, { bigint: true })).toBe(metadata);
  expect(getHomeRecovery(home).files).toContainEqual(expect.objectContaining({ file: 'ui-state.json', reason: 'outside-write' }));
  expect(transaction).toHaveBeenCalled();
});

it('detects corrupt pinned content when its metadata stays unchanged', () => {
  const home = Home.sandbox(storeRoot());
  Home.seed(home, home.workspaceUiState, { value: 'old' });
  writeFileSync(home.workspaceUiState, '{"outside":true}'); // Deliberate incident with one pinned restore version.
  getHomeRecovery(home);
  const directory = join(home.root, '.versions', 'ui-state.json');
  const flag = JSON.parse(readFileSync(join(directory, 'OUTSIDE'), 'utf8')) as { restoreHash: string };
  const pinned = join(directory, flag.restoreHash);
  holdMetadata(pinned);
  getHomeRecovery(home);
  expect(getHomeRecovery(home).files[0]).toMatchObject({ canRestore: true });
  const metadata = statSync(pinned, { bigint: true });
  writeFileSync(pinned, Buffer.alloc(readFileSync(pinned).length, 120)); // Deliberate same-size corruption of auxiliary retained content.
  expect(statSync(pinned, { bigint: true })).toBe(metadata);
  expect(getHomeRecovery(home).files[0]).toMatchObject({ reason: 'outside-write', canRestore: false });
});
