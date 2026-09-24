import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { restoreGlobalBins, snapshotGlobalBins } from './bin-recovery.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cez-bin-recovery-')); roots.push(root);
  const prefix = join(root, 'prefix'); mkdirSync(prefix);
  return { root, prefix, snapshot: join(root, 'bin-links.json'), assertOwned: async () => {} };
}

// Node 24.13 `rmSync` follows a dangling symlink, reports it missing, and returns
// without unlinking (nodejs/node#61040). `writeFileSync` then opens the leftover
// link and throws ENOENT — the release-gate failure. `unlink` removes the link.
function overwriteCommand(path: string, contents: string): void {
  unlinkSync(path);
  writeFileSync(path, contents);
}

it('keeps POSIX links, regular-file modes and absent commands intact', async () => {
  const { prefix, snapshot, assertOwned } = fixture(); const bin = join(prefix, 'bin'); mkdirSync(bin);
  symlinkSync('../lib/node_modules/@wjarka/cezarion/dist/index.js', join(bin, 'cez'));
  writeFileSync(join(bin, 'cezarion'), Buffer.from([0, 255, 13, 10]), { mode: 0o751 });
  await snapshotGlobalBins(bin, ['cez', 'cezarion', 'absent'], false, snapshot, assertOwned);
  overwriteCommand(join(bin, 'cez'), 'broken');
  writeFileSync(join(bin, 'cezarion'), 'broken'); writeFileSync(join(bin, 'absent'), 'unwanted');
  await restoreGlobalBins(prefix, ['cez', 'cezarion', 'absent'], false, snapshot, assertOwned);
  expect(readlinkSync(join(bin, 'cez'))).toBe('../lib/node_modules/@wjarka/cezarion/dist/index.js');
  expect(readFileSync(join(bin, 'cezarion'))).toEqual(Buffer.from([0, 255, 13, 10]));
  if (process.platform !== 'win32') expect(statSync(join(bin, 'cezarion')).mode & 0o777).toBe(0o751);
  expect(existsSync(join(bin, 'absent'))).toBe(false);
});

it('replaces a dangling POSIX command symlink instead of following it', () => {
  const { prefix } = fixture(); const bin = join(prefix, 'bin'); mkdirSync(bin);
  const path = join(bin, 'cez');
  symlinkSync('../lib/node_modules/@wjarka/cezarion/dist/index.js', path);
  overwriteCommand(path, 'broken');
  expect(lstatSync(path).isSymbolicLink()).toBe(false);
  expect(readFileSync(path, 'utf8')).toBe('broken');
});

it('retains existing POSIX snapshots and refuses legacy Windows snapshots that saved no launchers', async () => {
  const { prefix, snapshot, assertOwned } = fixture(); mkdirSync(join(prefix, 'bin'));
  writeFileSync(snapshot, JSON.stringify([{ name: 'cez', target: '../old-entry.js' }]));
  await restoreGlobalBins(prefix, ['cez'], false, snapshot, assertOwned);
  expect(readlinkSync(join(prefix, 'bin/cez'))).toBe('../old-entry.js');
  await expect(restoreGlobalBins(prefix, ['cez'], true, snapshot, assertOwned)).rejects.toThrow('invalid recovery');
});

it.each(['escape', 'unknown', 'duplicate', 'incomplete', 'bytes', 'mode', 'layout'])('rejects %s data before mutating any shim', async corruption => {
  const { root, prefix, snapshot, assertOwned } = fixture();
  writeFileSync(join(prefix, 'cez'), 'original');
  await snapshotGlobalBins(prefix, ['cez'], true, snapshot, assertOwned);
  const data = JSON.parse(readFileSync(snapshot, 'utf8'));
  if (corruption === 'escape') data.entries[1].name = '../outside';
  if (corruption === 'unknown') data.entries[1].name = 'npm.cmd';
  if (corruption === 'duplicate') data.entries[1].name = 'cez';
  if (corruption === 'incomplete') data.entries.pop();
  if (corruption === 'bytes') data.entries[0].bytes = 'not valid base64';
  if (corruption === 'mode') data.entries[0].mode = 0o7777;
  if (corruption === 'layout') data.windows = false;
  writeFileSync(snapshot, JSON.stringify(data));
  writeFileSync(join(prefix, 'cez'), 'must remain untouched'); writeFileSync(join(root, 'outside'), 'outside');
  await expect(restoreGlobalBins(prefix, ['cez'], true, snapshot, assertOwned)).rejects.toThrow('invalid recovery');
  expect(readFileSync(join(prefix, 'cez'), 'utf8')).toBe('must remain untouched');
  expect(readFileSync(join(root, 'outside'), 'utf8')).toBe('outside');
});

it('fails snapshot on unreadable launcher files instead of recording absence', async () => {
  const { prefix, snapshot, assertOwned } = fixture();
  const path = join(prefix, 'cez.cmd'); writeFileSync(path, 'private'); chmodSync(path, 0);
  try {
    // POSIX permissions exercise the real I/O error on this Linux CI host.
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      await expect(snapshotGlobalBins(prefix, ['cez'], true, snapshot, assertOwned)).rejects.toThrow();
      expect(existsSync(snapshot)).toBe(false);
    }
  } finally { chmodSync(path, 0o600); }
});

it('does not follow a replacement symlink and stops after ownership loss', async () => {
  const { root, prefix, snapshot, assertOwned } = fixture();
  writeFileSync(join(prefix, 'cez'), 'old');
  await snapshotGlobalBins(prefix, ['cez'], true, snapshot, assertOwned);
  const unrelated = join(root, 'unrelated'); writeFileSync(unrelated, 'safe');
  rmSync(join(prefix, 'cez')); symlinkSync(unrelated, join(prefix, 'cez'));
  await restoreGlobalBins(prefix, ['cez'], true, snapshot, assertOwned);
  expect(readFileSync(unrelated, 'utf8')).toBe('safe');
  expect(readFileSync(join(prefix, 'cez'), 'utf8')).toBe('old');
  await expect(restoreGlobalBins(prefix, ['cez'], true, snapshot, async () => { throw new Error('ownership lost'); }))
    .rejects.toThrow('ownership lost');
});
