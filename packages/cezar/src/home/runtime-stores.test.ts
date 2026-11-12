import { testHome } from './test-home.testkit.ts';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runtimeHomes } from './runtime-isolation.testkit.ts';
import { loadConfig, resolveWorktreeRetention } from '../config.ts';
import { agentModelsLocked } from '../core/agent-model-policy.ts';
import { resolveProfileEnvForRoot, resolveRuntimeAuthVerificationTarget } from '../workspace/agent-profiles.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { listProjects, registerProject, removeProject } from '../workspace/projects.ts';
import { registryEntry } from '../workspace/registry-entry.ts';
import { createWorkspaceProjects } from '../server/workspace-projects.ts';
import { resolveServerDeps } from '../server/server-deps.ts';
import { modelLockRefusal as startRefusal } from '../server/start-run-options.ts';
import { modelLockRefusal as continueRefusal } from '../workflows/continuation-admission.ts';

it('loads machine defaults and retention from the selected Home', async () => {
  const { root, selected } = runtimeHomes();
  expect((await loadConfig(root, selected)).defaultRunner).toBe('codex');
  expect(await resolveWorktreeRetention(root, selected)).toBe(17);
  expect((await loadConfig(root, testHome())).defaultRunner).toBe('claude');
  expect(await resolveWorktreeRetention(root, testHome())).toBe(2);
});

it('applies selected model policy at start and Continue gates', () => {
  const { root, selected } = runtimeHomes();
  expect(agentModelsLocked(root, process.env, selected)).toBe(true);
  expect(startRefusal(root, { model: 'sonnet' }, selected)).toMatchObject({ status: 409 });
  expect(continueRefusal(root, { effort: 'high' }, selected)).toMatchObject({ ok: false });
  expect(agentModelsLocked(root, undefined, testHome())).toBe(false);
});

it('resolves task accounts and runtime auth verification in the selected Home', async () => {
  const { root, selected } = runtimeHomes();
  const resolved = await resolveProfileEnvForRoot(root, 'claude', undefined, process.env, selected);
  expect(resolved.env.CLAUDE_CONFIG_DIR).toBe(join(root, 'selected-account'));
  expect(await resolveRuntimeAuthVerificationTarget('claude', 'work', selected)).toEqual({ kind: 'profile', id: 'work', configDir: join(root, 'selected-account') });
  expect((await resolveProfileEnvForRoot(root, 'claude', undefined, undefined, testHome())).env.CLAUDE_CONFIG_DIR).toBe(join(root, 'ambient-account'));
});

it('refreshes the semaphore from the selected Home', async () => {
  const { selected } = runtimeHomes();
  const semaphore = new WorkspaceSemaphore({ home: selected });
  await semaphore.refresh();
  expect(semaphore.maxParallel()).toBe(7);
});

it('lists, registers and removes projects without changing the ambient registry', async () => {
  const { root, selected, ambient } = runtimeHomes();
  const before = readFileSync(ambient.workspaceConfig, 'utf8');
  expect((await listProjects(undefined, selected)).map(project => project.id)).toEqual(['selected']);
  const added = await registerProject(join(root, 'new-project'), 'local', selected);
  expect(await registryEntry(added.id, added.root, selected)).toMatchObject({ id: added.id });
  expect(await removeProject(added.id, selected)).toBe(true);
  expect(readFileSync(ambient.workspaceConfig, 'utf8')).toBe(before);
});

it('binds server identity, registry and config writes to the selected Home', async () => {
  const { root, selected, ambient } = runtimeHomes();
  const registry = createWorkspaceProjects({ bootRoot: root, home: selected });
  expect(await registry.resolveBootProject()).toBe('selected');
  expect(await registry.registryEntry('selected')).toMatchObject({ name: 'Selected' });
  const before = readFileSync(ambient.workspaceConfig, 'utf8');
  const services = resolveServerDeps({ home: selected }, root);
  expect((await services.workspaceConfig.load()).agentDefaults.runner).toBe('codex');
  await services.workspaceConfig.mergeWrite(config => { config.modelsLocked = false; });
  expect(agentModelsLocked(root, process.env, selected)).toBe(false);
  expect(readFileSync(ambient.workspaceConfig, 'utf8')).toBe(before);
});

it('keeps a missing selected store on defaults instead of consulting ambient state', async () => {
  const { root, selected, ambient } = runtimeHomes();
  rmSync(selected.workspaceConfig);
  rmSync(selected.agentAccounts);
  const before = readFileSync(ambient.agentAccounts, 'utf8');
  expect((await loadConfig(root, selected)).defaultRunner).toBe('claude');
  expect((await resolveProfileEnvForRoot(root, 'claude', undefined, process.env, selected)).profile.isDefault).toBe(true);
  expect(readFileSync(ambient.agentAccounts, 'utf8')).toBe(before);
});
