import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { testHome } from '../home/test-home.testkit.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

let root: string, store: RunStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'project-routes-'));
  store = RunStore.open(join(root, '.ai/cezar'));
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
function workflow(directory: string, name: string) {
  const dir = join(root, '.ai', directory, 'workflows');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.yaml`);
  writeFileSync(path, `name: ${name}\nskills: [implement]\n`);
  return path;
}
const remove = (name: string) => apiRequest(createApp({ home: testHome(), repoRoot: root, store,
  manager: {} as RunManager, version: 'test' }), `/api/v1/workflows/${name}`, { method: 'DELETE' });

it.each([false, true])('refuses deleting fallback workflow names, including legacy duplicates (%s)', async duplicate => {
  const path = workflow('squawk', 'saved');
  if (duplicate) workflow('cezar', 'saved');
  const before = readFileSync(path);
  const response = await remove('saved');
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: expect.stringMatching(/\.ai\/squawk.*binary that migrated/) });
  expect(readFileSync(path)).toEqual(before);
});

it('keeps legacy-only workflow deletion unchanged', async () => {
  workflow('cezar', 'saved');
  expect((await remove('saved')).status).toBe(200);
});
