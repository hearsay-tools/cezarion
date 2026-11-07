import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';
import { copyPrivateTree, migrationFiles, replacePrivateTree, writeLegacyArchive } from './migration-files.ts';

vi.mock('node:zlib', async original => {
  const zlib = await original<typeof import('node:zlib')>();
  return { ...zlib, gzipSync: vi.fn(zlib.gzipSync) };
});
afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });

it('E1: writes one gzip member per tar entry with buffers bounded by the largest file', () => {
  const source = storeRoot(), target = join(storeRoot(), 'archive.tar.gz');
  const size = 128 * 1024;
  for (const name of ['a', 'b', 'c']) writeFileSync(join(source, name), Buffer.alloc(size, name));
  const gzip = vi.mocked(gzipSync).mockClear();
  writeLegacyArchive(source, target, migrationFiles(source));
  expect(gzip.mock.calls.map(([bytes]) => Buffer.byteLength(bytes))).toEqual([size + 512, size + 512, size + 512, 1024]);
  const expanded = gunzipSync(readFileSync(target));
  expect(expanded.length).toBe(3 * (size + 512) + 1024);
  if (process.platform !== 'win32') {
    const extracted = storeRoot();
    execFileSync('tar', ['-xzf', target, '-C', extracted]);
    for (const name of ['a', 'b', 'c']) expect(readFileSync(join(extracted, name))).toEqual(readFileSync(join(source, name)));
  }
});

it('step 4: writes a private, standard ustar gzip archive with exact file bytes and exclusions', () => {
  const source = storeRoot(), target = join(storeRoot(), 'backups', 'legacy.tar.gz');
  mkdirSync(join(source, 'versions'));
  mkdirSync(join(source, 'empty'));
  writeFileSync(join(source, 'config.json'), '{"secret":"token"}\n');
  writeFileSync(join(source, 'versions', 'cached'), 'not archived');
  const long = `${'directory-'.repeat(9)}/${'name-'.repeat(15)}.json`;
  mkdirSync(join(source, long, '..'), { recursive: true });
  writeFileSync(join(source, long), '{"long":true}');
  writeLegacyArchive(source, target, migrationFiles(source, path => path === 'versions', true));
  const bytes = gunzipSync(readFileSync(target));
  expect(bytes.subarray(257, 263).toString()).toBe('ustar\0');
  expect(bytes.toString()).toContain('"secret":"token"');
  expect(bytes.toString()).not.toContain('not archived');
  expect(bytes.subarray(-1024).every(byte => byte === 0)).toBe(true);
  if (process.platform !== 'win32') {
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(statSync(join(target, '..')).mode & 0o777).toBe(0o700);
    const extracted = storeRoot();
    execFileSync('tar', ['-xzf', target, '-C', extracted]);
    expect(statSync(join(extracted, 'empty')).isDirectory()).toBe(true);
    expect(readFileSync(join(extracted, long), 'utf8')).toBe('{"long":true}');
    expect(readFileSync(join(extracted, 'config.json'))).toEqual(readFileSync(join(source, 'config.json')));
  }
});

it.skipIf(process.platform === 'win32')('copies managed versions privately and preserves internal current links and executable files', () => {
  const source = storeRoot(), target = join(storeRoot(), 'versions');
  mkdirSync(join(source, 'v1'));
  writeFileSync(join(source, 'v1', 'entry'), 'executable', { mode: 0o755 });
  symlinkSync('v1', join(source, 'current'));
  copyPrivateTree(source, target, true);
  expect(readlinkSync(join(target, 'current'))).toBe('v1');
  expect(readFileSync(join(target, 'current', 'entry'), 'utf8')).toBe('executable');
  expect(statSync(join(target, 'v1', 'entry')).mode & 0o777).toBe(0o700);
  expect(statSync(join(target, 'v1')).mode & 0o777).toBe(0o700);
  expect(readFileSync(join(source, 'current', 'entry'), 'utf8')).toBe('executable');
});

it.skipIf(process.platform === 'win32')('D4: staged relative and absolute internal links resolve against the final tree after rename', () => {
  const source = storeRoot(), target = join(storeRoot(), 'versions');
  mkdirSync(join(source, 'v1'));
  writeFileSync(join(source, 'v1/entry'), 'final bytes');
  symlinkSync('v1', join(source, 'current'));
  symlinkSync(join(source, 'v1/entry'), join(source, 'absolute-entry'));
  replacePrivateTree(source, target);
  expect(readlinkSync(join(target, 'current'))).toBe('v1');
  expect(readlinkSync(join(target, 'absolute-entry'))).toBe(join(target, 'v1/entry'));
  expect(readFileSync(join(target, 'current/entry'), 'utf8')).toBe('final bytes');
  expect(readFileSync(join(target, 'absolute-entry'), 'utf8')).toBe('final bytes');
});

it.skipIf(process.platform === 'win32')('refuses copy links that escape the source and target trees', () => {
  const source = storeRoot(), outside = storeRoot(), target = storeRoot();
  writeFileSync(join(outside, 'secret'), 'private');
  symlinkSync(join(outside, 'secret'), join(source, 'escape'));
  expect(() => copyPrivateTree(source, target)).toThrow(/escapes source/);
  expect(existsSync(join(target, 'escape'))).toBe(false);
  expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('private');
});

it('an absent source inventories no files and a failed archive leaves no staging copy', () => {
  expect(migrationFiles(join(storeRoot(), 'missing'))).toEqual([]);
  const target = join(storeRoot(), 'archive.tar.gz');
  expect(() => writeLegacyArchive(storeRoot(), target, ['missing'])).toThrow(/ENOENT/);
  expect(existsSync(target)).toBe(false);
});
