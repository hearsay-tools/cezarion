import { POWERSHELL, powershellEnv } from '../core/process-stat.ts';
import { execFileSync } from 'node:child_process';
import type { HomeLayout } from './kind-roots.ts';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface PrivateFileOptions {
  platform?: NodeJS.Platform;
  layout?: HomeLayout;
}

/** Replace the Windows DACL, rather than adding a grant to an inherited public ACL. */
export function protectPrivatePath(path: string, directory: boolean, {
  platform = process.platform, layout = 'split',
}: PrivateFileOptions = {}): void {
  if (platform !== 'win32' || layout !== 'split') return;
  const security = directory ? 'DirectorySecurity' : 'FileSecurity';
  const inheritance = directory ? 'ContainerInherit, ObjectInherit' : 'None';
  // PowerShell also treats typographic apostrophes as quote delimiters.
  const literal = "'" + path.replace(/['\u2018-\u201B]/g, quote => quote + quote) + "'";
  // A fresh descriptor has no old explicit grants. Disable inheritance and grant one SID.
  const script = `$ErrorActionPreference = 'Stop';
$acl = New-Object System.Security.AccessControl.${security};
$acl.SetAccessRuleProtection($true, $false);
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User;
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', '${inheritance}', 'None', 'Allow');
$acl.AddAccessRule($rule);
Set-Acl -LiteralPath ${literal} -AclObject $acl;`;
  execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { env: powershellEnv(), windowsHide: true, stdio: 'pipe' });
}

const protectedDirectories = new Map<string, { dev: bigint; ino: bigint }>();

function directoryIdentity(path: string): { dev: bigint; ino: bigint } | undefined {
  try {
    const { dev, ino } = statSync(path, { bigint: true });
    return { dev, ino };
  } catch { return undefined; }
}

/** Cache only successful grants for one directory identity; replacements need a fresh grant. */
function protectDirectoryOnce(path: string, options: PrivateFileOptions, created: boolean): void {
  const platform = options.platform ?? process.platform;
  const layout = options.layout ?? 'split';
  if (platform !== 'win32' || layout !== 'split') return;
  const canonical = realpathSync(path).toLowerCase();
  const identity = directoryIdentity(path);
  const previous = protectedDirectories.get(canonical);
  if (!created && identity && previous?.dev === identity.dev && previous.ino === identity.ino) return;
  protectedDirectories.delete(canonical);
  protectPrivatePath(path, true, options);
  if (identity) protectedDirectories.set(canonical, identity);
}

/** The directories from `path`'s nearest existing ancestor down to `path`, outermost first. */
function missingDirectories(path: string): string[] {
  const missing: string[] = [];
  for (let directory = resolve(path); !existsSync(directory);) {
    missing.unshift(directory);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return missing;
}

export function privateDirectory(path: string, options: PrivateFileOptions = {}): void {
  // Walk from `path` itself: on Windows the first-created path that mkdirSync returns does not
  // share `path`'s form, so a walk relative to it named a drive as a child directory.
  const missing = missingDirectories(path);
  const created = mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!created || !missing.length) { protectDirectoryOnce(path, options, false); return; }
  syncDirectory(dirname(missing[0]!));
  for (const directory of missing) {
    protectDirectoryOnce(directory, options, true);
    syncDirectory(directory);
  }
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
