import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertCezarHomeWriteIsSandboxed } from '../paths.ts';

/** Resolve missing descendants too, while refusing dangling links and lookup errors. */
function canonical(path: string): string {
  try { return realpathSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error(`Unresolved HomeStore symlink: ${path}`);
    } catch (lookup) {
      if ((lookup as NodeJS.ErrnoException).code !== 'ENOENT') throw lookup;
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonical(parent), basename(path));
  }
}

export function assertHomePath(root: string, path: string): string {
  const home = canonical(resolve(root));
  const target = canonical(resolve(path));
  assertCezarHomeWriteIsSandboxed(target);
  const rel = relative(home, target);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`Path escapes canonical HomeStore root: ${path}`);
  }
  return target;
}

/** Regular entries inherit their checked parent's boundary; only links need another lookup. */
export function assertHomeDirectory(root: string, directory: string, recursive = false, seen = new Set<string>()): void {
  const target = assertHomePath(root, directory);
  if (seen.has(target)) return;
  seen.add(target);
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) assertHomePath(root, path);
    if (recursive && (entry.isDirectory() || (entry.isSymbolicLink() && statSync(path).isDirectory()))) {
      assertHomeDirectory(root, path, true, seen);
    }
  }
}

/** Check every existing metadata chain before the first claim, journal or marker mutation. */
export function assertHomeMetadata(root: string): void {
  assertHomePath(root, join(root, 'install.json'));
  assertHomeDirectory(root, join(root, '.locks'), true);
  assertHomeDirectory(root, join(root, '.versions'), true);
}
