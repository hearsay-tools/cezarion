import { lstatSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join, posix, resolve, sep, win32 } from 'node:path';
import { nativePathPlatform, platformKindRoots } from './kind-roots.ts';

/**
 * The legacy home and every platform default kind root of one account. Pure.
 * `scripts/test-install-marker.mjs` keeps a copy; a test holds the two equal.
 */
export function protectedRootsFor(accountHome: string, env: { TMPDIR?: string | undefined }, platform: NodeJS.Platform): string[] {
  const { join } = platform === 'win32' ? win32 : posix;
  return [join(accountHome, '.cezar'), ...Object.values(platformKindRoots(accountHome, { TMPDIR: env.TMPDIR }, platform))];
}

/** The account's real cezar roots. HOME and a caller's env can name a sandbox, so the account home comes from the OS. */
export function accountProtectedRoots(): string[] {
  return protectedRootsFor(userInfo().homedir, { TMPDIR: process.env.TMPDIR }, nativePathPlatform);
}

/**
 * Throws `refusal()` when `path` is, or is below, an account root. Existing ancestors and
 * symlink aliases are canonicalized, and an unreadable lookup or dangling link fails closed.
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
  const destination = canonicalTarget(path);
  for (const root of accountProtectedRoots()) {
    const protectedHome = canonicalTarget(root, false);
    if (destination === protectedHome || destination.startsWith(protectedHome + sep)) throw refusal();
  }
}

/** A test install marker belongs to a sandbox. Refuse an account root in every process, test runner or not. */
export function assertTestHomeOutsideAccountHome(root: string): void {
  assertOutsideAccountHome(root, () => new Error(
    `[cez] refusing to write a test install marker to ${root}: it is the account's real cezar home. ` +
      'Use a sandbox directory for a test home.',
  ));
}
