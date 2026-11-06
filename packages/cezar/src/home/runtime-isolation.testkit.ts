import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, vi } from 'vitest';
import { resolveHome } from './resolve.ts';
import { atomicWriteJsonSync } from '../workspace/config.ts';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Distinct selected and ambient stores expose any reader that loses the injected Home. */
export function runtimeHomes() {
  const root = mkdtempSync(join(tmpdir(), 'cez-runtime-home-')); roots.push(root);
  const selected = resolveHome({ purpose: 'server', env: { CEZ_HOME: join(root, 'selected') } });
  const ambient = resolveHome({ purpose: 'server', env: { CEZ_HOME: join(root, 'ambient') } });
  vi.stubEnv('CEZ_HOME', ambient.root);
  vi.stubEnv('CEZ_AGENT_MODELS_LOCKED', '0');
  mkdirSync(join(root, 'selected-account'));
  mkdirSync(join(root, 'ambient-account'));
  const account = (path: string) => ({ accounts: [{ id: 'work', provider: 'claude', configDir: path, label: 'Work', addedAt: '' }],
    defaults: { claude: 'work' }, selections: {} });
  atomicWriteJsonSync(selected.agentAccounts, account(join(root, 'selected-account')));
  atomicWriteJsonSync(ambient.agentAccounts, account(join(root, 'ambient-account')));
  atomicWriteJsonSync(selected.workspaceConfig, { agentDefaults: { runner: 'codex' }, modelsLocked: true,
    resources: { maxParallel: 7, worktreeRetentionDefault: 17 }, disabledProviders: ['claude'],
    projects: [{ id: 'selected', root, name: 'Selected' }] });
  atomicWriteJsonSync(ambient.workspaceConfig, { agentDefaults: { runner: 'claude' }, modelsLocked: false,
    resources: { maxParallel: 2, worktreeRetentionDefault: 2 }, projects: [{ id: 'ambient', root, name: 'Ambient' }] });
  return { root, selected, ambient };
}
