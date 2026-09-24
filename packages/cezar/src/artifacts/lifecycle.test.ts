import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { artifactInstructions, provisionArtifactDirectory } from './lifecycle.ts';
import { artifactDirectory } from './store.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cez-artifact-life-')); roots.push(root);
  const store = RunStore.open(join(root, '.ai/cezar'));
  const run = store.createRun({ title: 'a', task: 'a', workflow: 'quick-task', steps: [] });
  const directory = provisionArtifactDirectory(join(root, '.ai/cezar'), run.id);
  return { root, store, run, directory };
}
it('removes published bytes when ordinary task history is deleted', () => {
  const { root, store, run, directory } = fixture();
  writeFileSync(join(directory, 'snapshot'), 'saved');
  store.updateRun(run.id, { status: 'done' });
  expect(store.deleteRun(run.id)).toBe(true);
  store.flush();
  expect(existsSync(directory)).toBe(false);
  expect(existsSync(root)).toBe(true);
});
it('provisions distinct task stores and keeps an existing store on Continue', () => {
  const { root, store, run, directory } = fixture();
  writeFileSync(join(directory, 'snapshot'), 'saved');
  expect(provisionArtifactDirectory(join(root, '.ai/cezar'), run.id)).toBe(directory);
  expect(existsSync(join(directory, 'snapshot'))).toBe(true);
  store.flush();
});
it('anchors storage to the canonical data directory when its ancestor is an OS alias', () => {
  const { root, store, run, directory } = fixture();
  const alias = join(root, 'alias'); symlinkSync(root, alias);
  const dataDir = join(alias, '.ai/cezar');
  expect(provisionArtifactDirectory(dataDir, run.id)).toBe(directory);
  expect(artifactDirectory(dataDir, run.id)).toBe(directory);
  store.flush();
});
it('degrades without following a redirected artifact store', () => {
  const { root, store, run, directory } = fixture();
  rmSync(directory, { recursive: true });
  const outside = join(root, 'outside'); mkdirSync(outside);
  symlinkSync(outside, directory);
  expect(provisionArtifactDirectory(join(root, '.ai/cezar'), run.id)).toBe('');
  expect(artifactInstructions('')).toContain('unavailable');
  store.flush();
});
it('teaches an explicit bundled publication command without requiring delegation', () => {
  expect(artifactInstructions('/owned/store')).toContain('artifact publish');
  expect(artifactInstructions('/owned/store')).toContain('never credentials');
});
