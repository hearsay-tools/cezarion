import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { privateDirectory, protectPrivatePath, replacePrivate } from './private-files.ts';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, renameSync: vi.fn(fs.renameSync), statSync: vi.fn(fs.statSync) };
});
afterEach(() => { vi.resetAllMocks(); });

it.each([false, true])('replaces the Windows ACL with one current-user grant (directory=%s)', directory => {
  protectPrivatePath("C:\\Users\\operator's home\\private", directory, { platform: 'win32', layout: 'split' });
  expect(execFileSync).toHaveBeenCalledTimes(1);
  const [command, args, options] = vi.mocked(execFileSync).mock.calls[0]!;
  expect(command).toBe('powershell.exe');
  expect(options).toEqual({ windowsHide: true, stdio: 'pipe' });
  expect(args?.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
  const script = args?.[3];
  expect(script).toContain(`New-Object System.Security.AccessControl.${directory ? 'DirectorySecurity' : 'FileSecurity'}`);
  expect(script).toContain('$acl.SetAccessRuleProtection($true, $false)');
  expect(script).toContain('[System.Security.Principal.WindowsIdentity]::GetCurrent().User');
  expect(script).toContain(`($sid, 'FullControl', '${directory ? 'ContainerInherit, ObjectInherit' : 'None'}', 'None', 'Allow')`);
  expect(script).toContain("Set-Acl -LiteralPath 'C:\\Users\\operator''s home\\private' -AclObject $acl");
});

it('keeps legacy Windows and POSIX behavior free of ACL commands', () => {
  protectPrivatePath('/private', false, { platform: 'linux', layout: 'split' });
  protectPrivatePath('C:\\private', false, { platform: 'win32', layout: 'legacy' });
  expect(execFileSync).not.toHaveBeenCalled();
});

it('protects each directory once and lets all staging files inherit the private ACL', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-private-acl-'));
  try {
    const dir = join(root, 'nested');
    const path = join(dir, 'secret.json');
    const options = { platform: 'win32', layout: 'split' } as const;
    privateDirectory(dir, options);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    replacePrivate(path, 'secret', options);
    replacePrivate(path, 'updated secret', options);
    privateDirectory(dir + '/.', options);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(readFileSync(path, 'utf8')).toBe('updated secret');
    expect(readdirSync(dir)).toEqual(['secret.json']);
    expect(vi.mocked(execFileSync).mock.calls[0]?.[1]?.[3]).not.toContain('.tmp');
    rmSync(dir, { recursive: true });
    privateDirectory(dir, options);
    expect(execFileSync).toHaveBeenCalledTimes(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('refuses publication when a Windows directory ACL fails, then retries the grant', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-private-acl-fail-'));
  try {
    const path = join(root, 'secret.json');
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('ACL refused'); });
    expect(() => replacePrivate(path, 'secret', { platform: 'win32', layout: 'split' })).toThrow('ACL refused');
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
    replacePrivate(path, 'retry', { platform: 'win32', layout: 'split' });
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(readFileSync(path, 'utf8')).toBe('retry');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('removes its staging file when publication fails after directory protection', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-private-stage-fail-'));
  try {
    const path = join(root, 'secret.json');
    vi.mocked(renameSync).mockImplementationOnce(stage => {
      expect(existsSync(stage)).toBe(true);
      throw new Error('Publication refused');
    });
    expect(() => replacePrivate(path, 'secret', { platform: 'win32', layout: 'split' })).toThrow('Publication refused');
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('re-grants when an external replacement changes the directory identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-private-replaced-'));
  const options = { platform: 'win32', layout: 'split' } as const;
  try {
    privateDirectory(root, options);
    const identity = statSync(root, { bigint: true });
    vi.mocked(statSync).mockReturnValue(Object.assign(Object.create(Object.getPrototypeOf(identity)), identity, { ino: identity.ino + 1n }));
    privateDirectory(root, options);
    privateDirectory(root + '/.', options);
    expect(execFileSync).toHaveBeenCalledTimes(2);
    replacePrivate(join(root, 'secret.json'), 'secret', options);
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(root, 'secret.json'), 'utf8')).toBe('secret');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('re-grants after an identity lookup fails and never caches the unknown identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-private-unknown-'));
  const options = { platform: 'win32', layout: 'split' } as const;
  try {
    privateDirectory(root, options);
    vi.mocked(statSync).mockImplementationOnce(() => { throw new Error('Identity unavailable'); });
    privateDirectory(root, options);
    privateDirectory(root, options);
    privateDirectory(root, options);
    expect(execFileSync).toHaveBeenCalledTimes(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
