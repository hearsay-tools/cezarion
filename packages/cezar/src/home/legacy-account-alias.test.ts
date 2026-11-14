import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Home } from './home.ts';
import { migrateLegacyHome } from './migrate.ts';
import { getHomeRecovery, importHomeRecovery } from './recovery.ts';
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';

afterEach(cleanStoreRoots);

function aliasFixture(internal: boolean) {
  const legacy = Home.sandbox(storeRoot());
  const home = Home.sandbox(storeRoot(), { layout: 'split' });
  const profiles = Home.sandbox(storeRoot());
  const directory = join(internal ? legacy.root : profiles.root, 'credentials');
  mkdirSync(directory);
  writeFileSync(join(directory, 'auth.json'), '{}');
  const configDir = join(internal ? profiles.root : legacy.root, 'alias');
  symlinkSync(directory, configDir, process.platform === 'win32' ? 'junction' : 'dir');
  const account = { id: 'work', provider: 'claude', configDir, label: 'Original' };
  Home.seed(legacy, legacy.agentAccounts, { accounts: [account] });
  migrateLegacyHome(legacy, home);
  return { legacy, home, account };
}

it('keeps relocation for an external alias into the legacy home after a label-only Import', () => {
  const { legacy, home, account } = aliasFixture(true);
  writeFileSync(legacy.agentAccounts, JSON.stringify({ accounts: [{ ...account, label: 'Imported' }] }));
  const incident = getHomeRecovery(home).files.find(file => file.reason === 'legacy-change')!;
  importHomeRecovery(home, 'agent-accounts.json', incident.detectedAt);
  expect(JSON.parse(readFileSync(home.agentAccounts, 'utf8')).accounts).toEqual([
    { ...account, label: 'Imported', configDir: join(home.data, 'accounts', account.id) },
  ]);
});

it('keeps an alias inside the legacy home that resolves to external credentials', () => {
  const { legacy, home, account } = aliasFixture(false);
  writeFileSync(legacy.agentAccounts, JSON.stringify({ accounts: [{ ...account, label: 'Imported' }] }));
  const incident = getHomeRecovery(home).files.find(file => file.reason === 'legacy-change')!;
  importHomeRecovery(home, 'agent-accounts.json', incident.detectedAt);
  expect(JSON.parse(readFileSync(home.agentAccounts, 'utf8')).accounts).toEqual([{ ...account, label: 'Imported' }]);
});

it('refuses a new external alias into the legacy home when no relocation exists', () => {
  const legacy = Home.sandbox(storeRoot());
  const home = Home.sandbox(storeRoot(), { layout: 'split' });
  const profiles = Home.sandbox(storeRoot());
  migrateLegacyHome(legacy, home);
  const credentials = join(legacy.root, 'new-credentials');
  mkdirSync(credentials);
  const configDir = join(profiles.root, 'new-alias');
  symlinkSync(credentials, configDir, process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(legacy.agentAccounts, JSON.stringify({ accounts: [{ id: 'new', provider: 'claude', configDir }] }));
  const incident = getHomeRecovery(home).files.find(file => file.reason === 'legacy-change')!;
  expect(() => importHomeRecovery(home, 'agent-accounts.json', incident.detectedAt)).toThrow(/account new.*no completed relocation/);
});
