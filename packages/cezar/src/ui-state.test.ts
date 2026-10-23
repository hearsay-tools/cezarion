import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { workspaceUiStatePath } from './paths.js';
import { readUiState, uiStatePath } from './ui-state.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it.each([null, [], 'bad', { overall: -1, needsYou: 0, finished: '2', working: 1.5 }].map(value => [value]))('normalizes malformed stored sidebar limits %j without discarding open state', async sidebarLimits => {
  const root = await mkdtemp(join(tmpdir(), 'sidebar-state-')); roots.push(root);
  await mkdir(join(root, '.ai/cezar'), { recursive: true });
  await writeFile(uiStatePath(root), JSON.stringify({ sidebarLimits, futurePreference: { nested: ['keep'] }, dismissedSkillsBanner: 'legacy' }));
  expect(await readUiState(root)).toEqual({ sidebarLimits: { overall: 10, needsYou: null, finished: null, working: null }, futurePreference: { nested: ['keep'] }, dismissedSkillsBanner: 'legacy' });
});
it('salvages valid sibling limits and preserves absent preferences', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sidebar-state-')); roots.push(root);
  await mkdir(join(root, '.ai/cezar'), { recursive: true });
  await writeFile(uiStatePath(root), JSON.stringify({ sidebarLimits: { overall: null, needsYou: -1, finished: 2, working: 3 } }));
  expect(await readUiState(root)).toEqual({ sidebarLimits: { overall: null, needsYou: null, finished: 2, working: 3 } });
  await writeFile(uiStatePath(root), '{}');
  expect(await readUiState(root)).toEqual({});
});
it('does not merge a legacy workspace importedSkills into the project state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ui-state-home-')); roots.push(home);
  vi.stubEnv('CEZ_HOME', home);
  try {
    await writeFile(workspaceUiStatePath(), JSON.stringify({ importedSkills: ['a'] }));
    const root = await mkdtemp(join(tmpdir(), 'sidebar-state-')); roots.push(root);
    await mkdir(join(root, '.ai/cezar'), { recursive: true });
    expect(await readUiState(root)).not.toHaveProperty('importedSkills');
  } finally {
    vi.unstubAllEnvs();
  }
});
