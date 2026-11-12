import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertSquawkHomeWriteIsSandboxed } from '../paths.ts';

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

/** Validate one operation's paths once per component, without retaining checks across mutations. */
export function assertHomePaths(root: string, paths: readonly string[]): string[] {
  const lexicalRoot = resolve(root);
  const home = canonical(lexicalRoot);
  assertSquawkHomeWriteIsSandboxed(home);
  const checked = new Map([[lexicalRoot, home]]);
  return paths.map(path => {
    const rel = relative(lexicalRoot, resolve(path));
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
      throw new Error(`Path escapes canonical HomeStore root: ${path}`);
    }
    let current = lexicalRoot;
    let target = home;
    for (const part of rel.split(sep).filter(Boolean)) {
      current = join(current, part);
      const known = checked.get(current);
      if (known) { target = known; continue; }
      // Ordinary components inherit the checked parent. Resolve links individually so a
      // chain cannot leave the home and then return through a later link.
      target = join(target, part);
      try {
        if (lstatSync(current).isSymbolicLink()) {
          target = canonical(current);
          assertSquawkHomeWriteIsSandboxed(target);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const inside = relative(home, target);
      if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) {
        throw new Error(`Path escapes canonical HomeStore root: ${path}`);
      }
      checked.set(current, target);
    }
    assertSquawkHomeWriteIsSandboxed(target);
    return target;
  });
}

export function assertHomePath(root: string, path: string): string {
  return assertHomePaths(root, [path])[0]!;
}

/** Only these paths can be mutated while acquiring a short write lock or marker. */
export function assertHomeMetadata(root: string): void {
  assertHomePaths(root, [join(root, 'install.json'), join(root, '.locks', 'write.lock')]);
}
