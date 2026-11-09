import * as fs from 'node:fs/promises';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PackageRecoveryError, restorePackageTrees } from './scoped-recovery.ts';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, cp: vi.fn(actual.cp), rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) };
});

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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

it('stops all installed-root mutations and keeps previous roots after ownership is lost following the first commit', async () => {
  const f = fixture();
  const rename = vi.spyOn(fs, 'rename'), remove = vi.spyOn(fs, 'rm');
  let lost = false;
  const assertOwned = vi.fn(async () => {
    if (!lost && rename.mock.calls.length === 2) { lost = true; throw new Error('fixture ownership lost'); }
  });
  const error = await restorePackageTrees(f.trees, assertOwned).catch(error => error);
  expect(error).toBeInstanceOf(PackageRecoveryError);
  expect(lost).toBe(true);
  expect(rename).toHaveBeenCalledTimes(2);
  expect(remove).not.toHaveBeenCalled();
  expect(f.versions()).toEqual(['old', 'promoted', 'promoted']);
  const [from, previous] = rename.mock.calls[0]!;
  expect(from).toBe(f.trees[0]!.destination);
  expect(readFileSync(join(String(previous), 'version'), 'utf8')).toBe('promoted');
  expect(error.message).toContain(`${previous} -> ${from}`);
  for (const tree of f.trees) expect(existsSync(tree.source)).toBe(true);
});

it('checks ownership again between moving the installed root and installing its replacement', async () => {
  const f = fixture(), rename = vi.spyOn(fs, 'rename'), remove = vi.spyOn(fs, 'rm');
  await expect(restorePackageTrees(f.trees, async () => {
    if (rename.mock.calls.length === 1) throw new Error('fixture ownership lost');
  })).rejects.toBeInstanceOf(PackageRecoveryError);
  expect(rename).toHaveBeenCalledTimes(1);
  expect(remove).not.toHaveBeenCalled();
  expect(existsSync(f.trees[0]!.destination)).toBe(false);
  const previous = String(rename.mock.calls[0]![1]);
  expect(readFileSync(join(previous, 'version'), 'utf8')).toBe('promoted');
});

it('checks ownership before undo removes a committed installed root', async () => {
  const f = fixture(), actual = await vi.importActual<typeof fs>('node:fs/promises');
  let failed = false;
  const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(from) === f.trees[1]!.destination) { failed = true; throw new Error('fixture commit failure'); }
    await actual.rename(from, to);
  });
  const remove = vi.spyOn(fs, 'rm');
  const error = await restorePackageTrees(f.trees, async () => {
    if (failed) throw new Error('fixture ownership lost before undo');
  }).catch(error => error);
  expect(error).toBeInstanceOf(PackageRecoveryError);
  expect(rename).toHaveBeenCalledTimes(3);
  expect(remove).not.toHaveBeenCalled();
  expect(f.versions()).toEqual(['old', 'promoted', 'promoted']);
  expect(error.message).toContain(`${rename.mock.calls[0]![1]} -> ${f.trees[0]!.destination}`);
});
