import { Home } from './home.ts';
import { useTestHome } from './test-home.testkit.ts';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { loadAgentAccounts, mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import { restoreBackup } from '../workspace/backup-cli.ts';
import { runMigrations } from '../workspace/migrations.ts';
import { SelfUpdateService } from '../self-update/service.ts';

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
  const snapshot = file === 'config.json' ? { extra: 'snapshot' } : { accounts: [], selections: {}, extra: 'snapshot' };
  Home.seed(Home.sandbox(selected.root), selectedPath, snapshot);
  Home.seed(Home.sandbox(ambient.root), ambientPath, { ...snapshot, extra: 'ambient' });
  const before = readFileSync(ambientPath, 'utf8');
  const ambientFiles = readdirSync(ambient.root);
  useTestHome(ambient.root ? Home.sandbox(ambient.root) : undefined);
  if (file === 'config.json') await mergeWriteWorkspaceConfig(value => { value.extra = 'replaced'; }, selected);
  else await mergeWriteAgentAccounts(value => { value.extra = 'replaced'; }, selected);

  await restoreBackup(file, undefined, selected);

  expect(JSON.parse(readFileSync(selectedPath, 'utf8')).extra).toBe('snapshot');
  expect(readFileSync(ambientPath, 'utf8')).toBe(before);
  expect(readdirSync(ambient.root)).toEqual(ambientFiles);
});

it('keeps migration reads, imports, UI state and schemaVersion in the injected Home', async () => {
  const { selected, ambient, root } = homes();
  Home.seed(Home.sandbox(selected.root), selected.workspaceConfig, { schemaVersion: 0, resources: { maxParallel: 3 } });
  Home.seed(Home.sandbox(selected.root), selected.workspaceUiState, { appearance: { accent: 'amber' }, keep: 'selected' });
  Home.seed(Home.sandbox(ambient.root), ambient.workspaceConfig, { schemaVersion: 0, resources: { maxParallel: 8, memoryLimitMb: 999 }, keep: 'ambient' });
  Home.seed(Home.sandbox(ambient.root), ambient.workspaceUiState, { appearance: { accent: 'blue' }, keep: 'ambient' });
  const configBefore = readFileSync(ambient.workspaceConfig, 'utf8');
  const uiBefore = readFileSync(ambient.workspaceUiState, 'utf8');
  const ambientFiles = readdirSync(ambient.root);
  const repo = join(root, 'repo');
  writeProjectJson(join(repo, '.ai/cezar/config.json'), { maxParallel: 5, memoryLimitMb: 1024 });
  writeProjectJson(join(repo, '.ai/cezar/ui-state.json'), { appearance: { accent: 'violet' }, notifications: { enabled: false } });
  useTestHome(ambient.root ? Home.sandbox(ambient.root) : undefined);

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
  Home.seed(Home.sandbox(selected.root), selected.workspaceConfig, { agentProfiles: [account] });
  Home.seed(Home.sandbox(ambient.root), ambient.workspaceConfig, { agentProfiles: [{ ...account, id: 'ambient' }] });
  const before = readFileSync(ambient.workspaceConfig, 'utf8');
  const ambientFiles = readdirSync(ambient.root);
  useTestHome(ambient.root ? Home.sandbox(ambient.root) : undefined);

  expect((await loadAgentAccounts(selected)).accounts).toEqual([account]);
  expect(JSON.parse(readFileSync(selected.agentAccounts, 'utf8')).accounts).toEqual([account]);
  expect(readFileSync(ambient.workspaceConfig, 'utf8')).toBe(before);
  expect(readdirSync(ambient.root)).toEqual(ambientFiles);
});

it('reads and writes the update channel in the injected Home', async () => {
  const { selected, ambient } = homes();
  Home.seed(Home.sandbox(selected.root), selected.workspaceConfig, { updateChannel: 'nightly' });
  Home.seed(Home.sandbox(ambient.root), ambient.workspaceConfig, { updateChannel: 'stable' });
  const before = readFileSync(ambient.workspaceConfig, 'utf8');
  const ambientFiles = readdirSync(ambient.root);
  useTestHome(ambient.root ? Home.sandbox(ambient.root) : undefined);
  const service = new SelfUpdateService({ pkgName: '@wjarka/cezarion', version: '1.2.3', entry: '/entry', home: selected, restart: () => {} });

  expect(await service.channel()).toBe('nightly');
  await service.setChannel('development');
  expect(await service.channel()).toBe('development');
  expect(readFileSync(ambient.workspaceConfig, 'utf8')).toBe(before);
  expect(readdirSync(ambient.root)).toEqual(ambientFiles);
});

function writeProjectJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
