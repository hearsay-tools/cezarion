import { logPrefix, productName } from './display.ts';
import { lstatSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import { nativePathPlatform, platformKindRoots } from './kind-roots.ts';

/**
 * The legacy home and every platform default kind root of one account. Pure.
 * `scripts/test-install-marker.mjs` keeps a copy; a test holds the two equal.
 */
export function protectedRootsFor(accountHome: string, env: { TMPDIR?: string | undefined }, platform: NodeJS.Platform): string[] {
  const { join } = platform === 'win32' ? win32 : posix;
  return [join(accountHome, '.cezar'), ...Object.values(platformKindRoots(accountHome, { TMPDIR: env.TMPDIR }, platform))];
}

/**
 * The account's real Squawk roots. HOME and a caller's env can name a sandbox, so the account home
 * comes from the OS. Throws when the OS gives no absolute home: relative roots would protect nothing.
 */
export function accountProtectedRoots(): string[] {
  const accountHome = userInfo().homedir;
  if (!accountHome || !isAbsolute(accountHome)) throw new Error(`${logPrefix()} the OS gives no absolute account home`);
  return protectedRootsFor(accountHome, { TMPDIR: process.env.TMPDIR }, nativePathPlatform);
}

/**
 * True when `destination` is `root` or below it. Windows and default macOS volumes ignore case, so
 * there an absent `.CEZAR` still names `.cezar`. `scripts/test-install-marker.mjs` keeps a copy.
 */
export function insideRoot(destination: string, root: string, platform: NodeJS.Platform): boolean {
  const ignoreCase = platform === 'win32' || platform === 'darwin';
  const path = ignoreCase ? destination.toLowerCase() : destination;
  const home = ignoreCase ? root.toLowerCase() : root;
  const separator = platform === 'win32' ? '\\' : '/';
  return path === home || path.startsWith(home.endsWith(separator) ? home : home + separator);
}

/**
 * Throws `refusal()` when `path` is, or is below, an account root. Existing ancestors and
 * symlink aliases are canonicalized. An unverifiable account home, an unreadable lookup or a
 * dangling link fails closed.
 */
export function assertOutsideAccountHome(path: string, refusal: () => Error): void {
  // Resolve existing ancestors too: the destination itself may not exist yet.
  function canonicalTarget(target: string, rejectDangling = true): string {
    let ancestor = resolve(target);
    const remaining: string[] = [];
    for (;;) {
      try { return join(realpathSync(ancestor), ...remaining); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw refusal();
      }
      // A dangling link has no canonical target; fail closed instead of treating it as a missing directory.
      try {
        if (lstatSync(ancestor).isSymbolicLink()) {
          if (!rejectDangling) return resolve(target);
          throw refusal();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw refusal();
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw refusal();
      remaining.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
  let roots: string[];
  try { roots = accountProtectedRoots(); } catch { throw refusal(); }
  const destination = canonicalTarget(path);
  for (const root of roots) {
    if (insideRoot(destination, canonicalTarget(root, false), nativePathPlatform)) throw refusal();
  }
}

/** A test install marker belongs to a sandbox. Refuse an account root in every process, test runner or not. */
export function assertTestHomeOutsideAccountHome(root: string): void {
  assertOutsideAccountHome(root, () => new Error(
    `${logPrefix()} refusing to write a test install marker to ${root}: it is the account's real ${productName('cezar')} home, ` +
      'or the OS gives no account home to check it against. ' +
      'Use a sandbox directory for a test home.',
  ));
}
