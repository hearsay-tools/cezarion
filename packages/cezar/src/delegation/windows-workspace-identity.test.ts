import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, readFile, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { windowsIdentityDirectory, windowsReadIdentity, windowsWriteIdentity } from './windows-workspace-identity.ts';

it.runIf(process.platform === 'win32')('creates private Unicode identities exclusively and replaces checkpoints atomically', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cez-private-')));
  try {
    const dir = join(root, 'private'); windowsIdentityDirectory(dir, true); windowsIdentityDirectory(dir, true);
    const path = join(dir, 'zażółć.json'); windowsWriteIdentity(path, 'receipt');
    expect(windowsReadIdentity(path, 16)).toBe('receipt');
    expect(() => windowsWriteIdentity(path, 'collision')).toThrow();
    expect(() => windowsReadIdentity(path, 2)).toThrow();
    windowsWriteIdentity(path, 'checkpoint', true);
    expect(windowsReadIdentity(path, 16)).toBe('checkpoint');
    execFileSync('icacls.exe', [path, '/grant', '*S-1-1-0:F']);
    expect(() => windowsWriteIdentity(path, 'unsafe replacement', true)).toThrow();
    expect(await readFile(path, 'utf8')).toBe('checkpoint');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120_000);

it.runIf(process.platform === 'win32')('refuses to adopt a pre-existing broad directory', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cez-broad-')));
  try {
    const dir = join(root, 'existing'); await mkdir(dir);
    execFileSync('icacls.exe', [dir, '/grant', '*S-1-1-0:F']);
    expect(() => windowsIdentityDirectory(dir, true)).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);

it.runIf(process.platform === 'win32')('rejects junctions in intermediate path components', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cez-junction-')));
  try {
    const parent = join(root, 'parent'); await mkdir(parent);
    const dir = join(parent, 'private'); windowsIdentityDirectory(dir, true);
    const path = join(dir, 'receipt.json'); windowsWriteIdentity(path, 'original');
    await rename(parent, `${parent}-saved`); await symlink(`${parent}-saved`, parent, 'junction');
    expect(() => windowsReadIdentity(path, 16)).toThrow();
    expect(() => windowsWriteIdentity(path, 'replacement', true)).toThrow();
    expect(await readFile(join(`${parent}-saved`, 'private', 'receipt.json'), 'utf8')).toBe('original');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120_000);
