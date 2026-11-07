import { execFileSync } from 'node:child_process';
import { REBRAND_SWITCH } from './switch.ts';
import type { HomeLayout } from './kind-roots.ts';
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export interface PrivateFileOptions {
  platform?: NodeJS.Platform;
  layout?: HomeLayout;
}

/** Replace the Windows DACL, rather than adding a grant to an inherited public ACL. */
export function protectPrivatePath(path: string, directory: boolean, {
  platform = process.platform, layout = REBRAND_SWITCH ? 'split' : 'legacy',
}: PrivateFileOptions = {}): void {
  if (platform !== 'win32' || layout !== 'split') return;
  const security = directory ? 'DirectorySecurity' : 'FileSecurity';
  const inheritance = directory ? 'ContainerInherit, ObjectInherit' : 'None';
  const literal = "'" + path.replaceAll("'", "''") + "'";
  // A fresh descriptor has no old explicit grants. Disable inheritance and grant one SID.
  const script = `$ErrorActionPreference = 'Stop';
$acl = New-Object System.Security.AccessControl.${security};
$acl.SetAccessRuleProtection($true, $false);
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User;
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', '${inheritance}', 'None', 'Allow');
$acl.AddAccessRule($rule);
Set-Acl -LiteralPath ${literal} -AclObject $acl;`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'pipe' });
}

const protectedDirectories = new Set<string>();

/** Cache only successful grants; a directory recreated by this call needs a fresh grant. */
function protectDirectoryOnce(path: string, options: PrivateFileOptions, created: boolean): void {
  const platform = options.platform ?? process.platform;
  const layout = options.layout ?? (REBRAND_SWITCH ? 'split' : 'legacy');
  if (platform !== 'win32' || layout !== 'split') return;
  const canonical = realpathSync(path).toLowerCase();
  if (!created && protectedDirectories.has(canonical)) return;
  protectPrivatePath(path, true, options);
  protectedDirectories.add(canonical);
}

export function privateDirectory(path: string, options: PrivateFileOptions = {}): void {
  const created = mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!created) { protectDirectoryOnce(path, options, false); return; }
  syncDirectory(dirname(created));
  let directory = created;
  for (const part of relative(created, path).split(/[\\/]/).filter(Boolean)) {
    protectDirectoryOnce(directory, options, true);
    syncDirectory(directory);
    directory = join(directory, part);
  }
  protectDirectoryOnce(directory, options, true);
  syncDirectory(directory);
}

export function atomicTmpPath(path: string): string {
  return `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

/** Flush the directory entry as well as file bytes. Windows does not open directories. */
export function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Private, durable atomic replacement. A failed write removes only its own staging file. */
export function replacePrivate(path: string, bytes: string | Buffer, options: PrivateFileOptions = {}): void {
  privateDirectory(dirname(path), options);
  const stage = atomicTmpPath(path);
  try {
    const fd = openSync(stage, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(stage, path);
    syncDirectory(dirname(path));
  } finally { rmSync(stage, { force: true }); }
}
