import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { privateDirectory, protectPrivatePath, replacePrivate } from './private-files.ts';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
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

it('protects new and existing directories and staging files before publication', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-private-acl-'));
  try {
    const dir = join(root, 'nested');
    const path = join(dir, 'secret.json');
    const options = { platform: 'win32', layout: 'split' } as const;
    privateDirectory(dir, options);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    replacePrivate(path, 'secret', options);
    expect(execFileSync).toHaveBeenCalledTimes(3);
    expect(readFileSync(path, 'utf8')).toBe('secret');
    expect(readdirSync(dir)).toEqual(['secret.json']);
    expect(vi.mocked(execFileSync).mock.calls[2]?.[1]?.[3]).toContain('.tmp');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('refuses publication and removes the stage when a Windows ACL fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-private-acl-fail-'));
  try {
    const path = join(root, 'secret.json');
    vi.mocked(execFileSync).mockImplementationOnce(() => Buffer.alloc(0)).mockImplementationOnce(() => { throw new Error('ACL refused'); });
    expect(() => replacePrivate(path, 'secret', { platform: 'win32', layout: 'split' })).toThrow('ACL refused');
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
