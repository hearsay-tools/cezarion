import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { type, userInfo } from 'node:os';
import { basename, dirname, join, posix, resolve, sep, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Script-only sandbox bootstrap, before product imports or test-file mocks. */
export function ensureTestInstallMarker(root) {
  // The release gate can be mocked per test. Prepare both layouts without importing it.
  const roots = [root, join(root, 'config')];
  // The account's real home never gets a test marker, test runner or not.
  for (const candidate of roots) assertOutsideAccountHome(candidate);
  for (const candidate of roots) validateMarker(candidate);
  for (const candidate of roots) ensureMarker(candidate);
}

/*
 * A copy of packages/cezar/src/home/protected-roots.ts: this setup runs before test-file
 * mocks, so it imports no product module. test-marker-guard.test.ts holds the roots equal.
 */
const nativePlatform = sep === '\\' ? 'win32' : type() === 'Darwin' ? 'darwin' : 'linux';

/** The legacy home and every platform default kind root of one account. Pure. */
export function protectedRootsFor(accountHome, env, platform) {
  if (platform === 'win32') {
    const local = win32.join(accountHome, 'AppData', 'Local', 'Hearsay Squawk');
    return [win32.join(accountHome, '.cezar'), win32.join(accountHome, 'AppData', 'Roaming', 'Hearsay Squawk'),
      ...['state', 'data', 'cache', 'run'].map(kind => win32.join(local, kind))];
  }
  if (platform === 'darwin') {
    const support = posix.join(accountHome, 'Library', 'Application Support', 'Hearsay Squawk');
    return [posix.join(accountHome, '.cezar'), ...['config', 'state', 'data'].map(kind => posix.join(support, kind)),
      posix.join(accountHome, 'Library', 'Caches', 'Hearsay Squawk'), posix.join(env.TMPDIR || '/tmp', 'hearsay-squawk')];
  }
  const state = posix.join(accountHome, '.local', 'state', 'hearsay-squawk');
  return [posix.join(accountHome, '.cezar'), posix.join(accountHome, '.config', 'hearsay-squawk'), state,
    posix.join(accountHome, '.local', 'share', 'hearsay-squawk'), posix.join(accountHome, '.cache', 'hearsay-squawk'), posix.join(state, 'run')];
}

/** The account's real roots. HOME can name a sandbox, so the account home comes from the OS. */
export function accountProtectedRoots() {
  return protectedRootsFor(userInfo().homedir, { TMPDIR: process.env.TMPDIR }, nativePlatform);
}

/** Refuse a root that is, or is below, an account root, through symlink aliases; fail closed on lookup errors. */
function assertOutsideAccountHome(root) {
  const refusal = () => new Error(`[cez] refusing to write a test install marker to ${root}: it is the account's real cezar home. Use a sandbox directory for a test home.`);
  const canonicalTarget = (target, rejectDangling = true) => {
    let ancestor = resolve(target);
    const remaining = [];
    for (;;) {
      try { return join(realpathSync(ancestor), ...remaining); } catch (error) {
        if (error.code !== 'ENOENT') throw refusal();
      }
      try {
        if (lstatSync(ancestor).isSymbolicLink()) {
          if (!rejectDangling) return resolve(target);
          throw refusal();
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw refusal();
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw refusal();
      remaining.unshift(basename(ancestor));
      ancestor = parent;
    }
  };
  const destination = canonicalTarget(root);
  for (const protectedRoot of accountProtectedRoots()) {
    const home = canonicalTarget(protectedRoot, false);
    if (destination === home || destination.startsWith(home + sep)) throw refusal();
  }
}

/** Never downgrade a live/dev marker in either layout. */
function validateMarker(root) {
  const path = join(root, 'install.json');
  try {
    const marker = JSON.parse(readFileSync(path, 'utf8'));
    if (marker.kind !== 'test') throw new Error(`Refusing benchmark/test home with a ${marker.kind} install marker: ${root}`);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

function ensureMarker(root) {
  if (validateMarker(root)) return;
  const path = join(root, 'install.json');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, JSON.stringify({ installId: randomUUID(), kind: 'test', createdAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    ensureMarker(root);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/test-install-marker.mjs <sandbox-root>');
  ensureTestInstallMarker(process.argv[2]);
}
