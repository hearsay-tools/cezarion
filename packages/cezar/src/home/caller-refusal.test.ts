import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from './home.ts';
import { HomeStore } from './store.ts';
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';
import { acquireLock, deleteServerState } from '../server-install/state.ts';
import { loadAgentAccounts } from '../workspace/agent-accounts.ts';

afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });

it('warns and keeps named instance bytes when outside-write enforcement refuses deletion', () => {
  const home = Home.sandbox(storeRoot());
  const path = home.serverState('named');
  Home.seed(home, path, { installed: true });
  const outside = '{"installed":false,"owner":"outside"}';
  writeFileSync(path, outside); // Deliberate outside write: deletion must refuse it.
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(() => deleteServerState('named', home)).not.toThrow();
  expect(readFileSync(path, 'utf8')).toBe(outside);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('instance state was kept'));
});

it('warns and keeps changed install-lock bytes when best-effort release refuses them', () => {
  const home = Home.sandbox(storeRoot());
  const release = acquireLock('default', home);
  const outside = `${process.pid}\n\n`;
  writeFileSync(home.serverLock(), outside); // Same owner, changed bytes: the journal must refuse removal.
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(release).not.toThrow();
  expect(readFileSync(home.serverLock(), 'utf8')).toBe(outside);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('install lock was kept'));
});

it('warns when an outside deletion prevents persisting a legacy account import', async () => {
  const home = Home.sandbox(storeRoot());
  const account = { id: 'legacy', provider: 'claude', configDir: '~/.claude-legacy', label: 'Legacy', addedAt: '' };
  Home.seed(home, home.workspaceConfig, { agentProfiles: [account] });
  Home.seed(home, home.agentAccounts, { accounts: [account] });
  rmSync(home.agentAccounts); // Deliberate outside deletion triggers the historical in-memory import.
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect((await loadAgentAccounts(home)).accounts.map(entry => entry.id)).toEqual(['legacy']);
  expect(existsSync(home.agentAccounts)).toBe(false);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('imported accounts are available in memory only'));
});

it.each(['instance state', 'install lock'])('keeps historical %s cleanup failures silent', kind => {
  const home = Home.sandbox(storeRoot());
  const operation = kind === 'install lock' ? acquireLock('default', home) : () => deleteServerState('named', home);
  vi.spyOn(HomeStore.prototype, 'replace').mockImplementation(() => { throw new Error('read-only filesystem'); });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(operation).not.toThrow();
  expect(warning).not.toHaveBeenCalled();
});
