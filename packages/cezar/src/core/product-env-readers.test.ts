import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from '../home/home.ts';
import { resolveCapabilities } from '../server/capabilities.ts';
import { resolveGlobalArchiveOnMerge } from '../archive-on-merge-setting.ts';
import { agentModelsLocked } from './agent-model-policy.ts';
import { providerAuthChecksDisabled } from './provider-auth.ts';
import { workspaceConfigSchema } from '../workspace/config.ts';
import { previewToolEnabled, automationsToolEnabled } from '../ci-wait/tools.ts';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });

it.each([
  [{ HSQ_PREVIEW: '1', CEZ_PREVIEW: '0' }, true],
  [{ HSQ_PREVIEW: '', CEZ_PREVIEW: '1' }, false],
  [{ CEZ_PREVIEW: '1' }, true],
  [{}, false],
])('capabilities and native tools share preview precedence: %j', (env, expected) => {
  expect(resolveCapabilities(env).preview).toBe(expected);
  expect(previewToolEnabled(env)).toBe(expected);
});

it('keeps D8 hosted mode pinned while ordinary preferred clears still win', () => {
  const caps = resolveCapabilities({HSQ_REMOTE: '', CEZ_REMOTE: '1', HSQ_HIDE_TOKEN_METRICS: '', CEZ_HIDE_TOKEN_METRICS: '1'});
  expect(caps).toMatchObject({localHandoff: false, tokenMetrics: true});
  expect(resolveCapabilities({HSQ_REMOTE: '1', CEZ_REMOTE: '0', HSQ_HIDE_COST: '1'})).toMatchObject({localHandoff: false, costMetrics: false, tokenUsageMetrics: true});
});

it('keeps automations opt-out and archive opt-in distinct with the same env precedence', () => {
  expect(automationsToolEnabled({HSQ_AUTOMATIONS: '', CEZ_AUTOMATIONS: '0'})).toBe(true);
  expect(automationsToolEnabled({HSQ_AUTOMATIONS: '0', CEZ_AUTOMATIONS: '1'})).toBe(false);
  expect(resolveGlobalArchiveOnMerge({}, {HSQ_ARCHIVE_ON_MERGE: '', CEZ_ARCHIVE_ON_MERGE: '1'}).enabled).toBe(false);
  expect(resolveGlobalArchiveOnMerge({}, {HSQ_ARCHIVE_ON_MERGE: '1', CEZ_ARCHIVE_ON_MERGE: '0'}).enabled).toBe(true);
});

it('reads the preferred native model lock for both auth and model policy', () => {
  const root = mkdtempSync(join(tmpdir(), 'env-policy-')); roots.push(root);
  const home = Home.sandbox(root);
  for (const env of [{HSQ_AGENT_MODELS_LOCKED: '1', CEZ_AGENT_MODELS_LOCKED: '0'}, {CEZ_AGENT_MODELS_LOCKED: '1'}]) {
    expect(agentModelsLocked(undefined, env, home)).toBe(true);
    expect(providerAuthChecksDisabled(env)).toBe(true);
  }
  const cleared = {HSQ_AGENT_MODELS_LOCKED: '', CEZ_AGENT_MODELS_LOCKED: '1'};
  expect(agentModelsLocked(undefined, cleared, home)).toBe(false);
  expect(providerAuthChecksDisabled(cleared)).toBe(false);
});

it('workspace path defaults use preferred aliases, keep empty fallback and honor saved values', () => {
  vi.stubEnv('CEZ_BROWSE_ROOT', '/old-browse'); vi.stubEnv('HSQ_BROWSE_ROOT', '/new-browse');
  vi.stubEnv('CEZ_PROJECTS_DIR', '/old-projects'); vi.stubEnv('HSQ_PROJECTS_DIR', '/new-projects');
  expect(workspaceConfigSchema.parse({})).toMatchObject({browseRoot: '/new-browse', projectsDir: '/new-projects'});
  expect(workspaceConfigSchema.parse({browseRoot: '/saved', projectsDir: '/saved'})).toMatchObject({browseRoot: '/saved', projectsDir: '/saved'});
  vi.stubEnv('HSQ_BROWSE_ROOT', ''); vi.stubEnv('HSQ_PROJECTS_DIR', '');
  expect(workspaceConfigSchema.parse({})).toMatchObject({browseRoot: '~/', projectsDir: '~/cezar/projects'});
});
