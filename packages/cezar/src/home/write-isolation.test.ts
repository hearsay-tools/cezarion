import { Home } from './home.ts';
import { useTestHome } from './test-home.testkit.ts';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { mergeWriteWorkspaceConfig, workspaceConfigSchema } from '../workspace/config.ts';
import { loadAgentAccounts, mergeWriteAgentAccounts, storeSchema } from '../workspace/agent-accounts.ts';
import { listBackups } from '../workspace/backups.ts';
import { restoreBackup } from '../workspace/backup-cli.ts';
import { runMigrations } from '../workspace/migrations.ts';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function homes() {
  const root = mkdtempSync(join(tmpdir(), 'cez-home-writes-')); roots.push(root);
  return { selected: Home.sandbox(join(root, 'selected')),
    ambient: Home.sandbox(join(root, 'ambient')), root };
}

it.each(['config.json', 'agent-accounts.json'] as const)('restores %s only in the injected Home', async file => {
  const { selected, ambient } = homes();
  const selectedPath = join(selected.root, file);
  const ambientPath = join(ambient.root, file);
  const snapshot = file === 'config.json' ? workspaceConfigSchema.parse({ extra: 'snapshot' })
    : storeSchema.parse({ accounts: [], selections: {}, extra: 'snapshot' });
  Home.seed(selected, selectedPath, snapshot);
  Home.seed(ambient, ambientPath, { ...snapshot, extra: 'ambient' });
  const snapshotBytes = readFileSync(selectedPath);
  const before = readFileSync(ambientPath, 'utf8');
  const ambientFiles = readdirSync(ambient.root);
  useTestHome(ambient);
  if (file === 'config.json') await mergeWriteWorkspaceConfig(value => { value.extra = 'replaced'; }, selected);
  else await mergeWriteAgentAccounts(value => { value.extra = 'replaced'; }, selected);

  // Select the older rotation explicitly: .bak is now the newest default config entry.
  const rotation = listBackups(file, selected).find(entry => entry.path !== `${selectedPath}.bak`)!;
  await restoreBackup(file, rotation.time, selected);

  expect(readFileSync(selectedPath)).toEqual(snapshotBytes);
  expect(JSON.parse(readFileSync(selectedPath, 'utf8')).extra).toBe('snapshot');
  expect(readFileSync(ambientPath, 'utf8')).toBe(before);
  expect(readdirSync(ambient.root)).toEqual(ambientFiles);
});

it('keeps migration reads, imports, UI state and schemaVersion in the injected Home', async () => {
  const { selected, ambient, root } = homes();
  Home.seed(selected, selected.workspaceConfig, { schemaVersion: 0, resources: { maxParallel: 3 } });
  Home.seed(selected, selected.workspaceUiState, { appearance: { accent: 'amber' }, keep: 'selected' });
  Home.seed(ambient, ambient.workspaceConfig, { schemaVersion: 0, resources: { maxParallel: 8, memoryLimitMb: 999 }, keep: 'ambient' });
  Home.seed(ambient, ambient.workspaceUiState, { appearance: { accent: 'blue' }, keep: 'ambient' });
  const configBefore = readFileSync(ambient.workspaceConfig, 'utf8');
  const uiBefore = readFileSync(ambient.workspaceUiState, 'utf8');
  const ambientFiles = readdirSync(ambient.root);
  const repo = join(root, 'repo');
  writeProjectJson(join(repo, '.ai/cezar/config.json'), { maxParallel: 5, memoryLimitMb: 1024 });
  writeProjectJson(join(repo, '.ai/cezar/ui-state.json'), { appearance: { accent: 'violet' }, notifications: { enabled: false } });
  useTestHome(ambient);

  await runMigrations({ bootRepoRoot: repo, home: selected });
  await runMigrations({ bootRepoRoot: repo, home: selected });

  expect(JSON.parse(readFileSync(selected.workspaceConfig, 'utf8'))).toMatchObject({ schemaVersion: 1, resources: { maxParallel: 3, memoryLimitMb: 1024 } });
  expect(JSON.parse(readFileSync(selected.workspaceUiState, 'utf8'))).toEqual({ appearance: { accent: 'amber' }, keep: 'selected', notifications: { enabled: false } });
  expect(readFileSync(ambient.workspaceConfig, 'utf8')).toBe(configBefore);
  expect(readFileSync(ambient.workspaceUiState, 'utf8')).toBe(uiBefore);
  expect(readdirSync(ambient.root)).toEqual(ambientFiles);
});

it('imports legacy accounts from the injected Home without writing to the ambient home', async () => {
  const { selected, ambient } = homes();
  const account = { id: 'selected', provider: 'claude', configDir: '~/.claude-selected', label: '', addedAt: '' };
  Home.seed(selected, selected.workspaceConfig, { agentProfiles: [account] });
  Home.seed(ambient, ambient.workspaceConfig, { agentProfiles: [{ ...account, id: 'ambient' }] });
  const before = readFileSync(ambient.workspaceConfig, 'utf8');
  const ambientFiles = readdirSync(ambient.root);
  useTestHome(ambient);

  expect((await loadAgentAccounts(selected)).accounts).toEqual([account]);
  expect(JSON.parse(readFileSync(selected.agentAccounts, 'utf8')).accounts).toEqual([account]);
  expect(readFileSync(ambient.workspaceConfig, 'utf8')).toBe(before);
  expect(readdirSync(ambient.root)).toEqual(ambientFiles);
});

function writeProjectJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
