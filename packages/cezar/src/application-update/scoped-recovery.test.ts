import * as fs from 'node:fs/promises';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { restorePackageTrees } from './scoped-recovery.ts';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, cp: vi.fn(actual.cp), rename: vi.fn(actual.rename) };
});

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'scoped-recovery-')); roots.push(root);
  const trees = ['alias', 'wrapper', 'runtime'].map(name => {
    const source = join(root, 'saved', name), destination = join(root, 'installed', name);
    for (const [dir, value] of [[source, 'old'], [destination, 'promoted']]) {
      mkdirSync(dir!, { recursive: true }); writeFileSync(join(dir!, 'version'), value!);
    }
    return { source, destination };
  });
  return { root, trees, versions: () => trees.map(tree => readFileSync(join(tree.destination, 'version'), 'utf8')) };
}

it('leaves alias, wrapper and runtime intact if any recovery copy fails', async () => {
  const f = fixture(), copy = fs.cp;
  vi.spyOn(fs, 'cp').mockImplementationOnce(copy).mockRejectedValueOnce(new Error('fixture copy failure'));
  await expect(restorePackageTrees(f.trees, async () => {})).rejects.toThrow('copy failure');
  expect(f.versions()).toEqual(['promoted', 'promoted', 'promoted']);
  expect(readdirSync(join(f.root, 'installed')).sort()).toEqual(['alias', 'runtime', 'wrapper']);
});

it('undoes every root replacement when a later rename fails', async () => {
  const f = fixture(), rename = fs.rename;
  vi.spyOn(fs, 'rename').mockImplementationOnce(rename).mockImplementationOnce(rename)
    .mockImplementationOnce(rename).mockRejectedValueOnce(new Error('fixture rename failure'));
  await expect(restorePackageTrees(f.trees, async () => {})).rejects.toThrow('rename failure');
  expect(f.versions()).toEqual(['promoted', 'promoted', 'promoted']);
  expect(readdirSync(join(f.root, 'installed')).sort()).toEqual(['alias', 'runtime', 'wrapper']);
});

it('restores all roots together and removes promoted-only entries', async () => {
  const f = fixture(), extra = join(f.root, 'installed', 'extra'); writeFileSync(extra, 'promoted-only');
  await restorePackageTrees([...f.trees, { source: undefined, destination: extra }], async () => {});
  expect(f.versions()).toEqual(['old', 'old', 'old']);
  expect(readdirSync(join(f.root, 'installed')).sort()).toEqual(['alias', 'runtime', 'wrapper']);
});
