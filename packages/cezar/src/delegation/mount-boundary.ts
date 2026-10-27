import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export class MountBoundaryError extends Error {}

/** Linux mountinfo includes bind mounts even when they share a device number.
 * An empty, malformed or unreadable listing is not evidence of no mounts. */
export function linuxMountPoints(content: string): string[] {
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length) throw new Error('Mount boundary evidence is empty');
  return lines.map(line => {
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (separator < 6 || fields.length < separator + 4 || !/^\d+$/.test(fields[0] ?? '') || !/^\d+$/.test(fields[1] ?? '') ||
        !/^\d+:\d+$/.test(fields[2] ?? '') || !fields[3]?.startsWith('/') || !fields[5] || !fields[separator + 1] || !fields[separator + 2] || !fields[separator + 3]) {
      throw new Error('Mount boundary evidence is malformed');
    }
    const encoded = fields[4] ?? '';
    if (/\\(?!040|011|012|134)/.test(encoded) || encoded.includes('\ufffd')) throw new Error('Mount boundary path is malformed');
    const path = encoded.replace(/\\(040|011|012|134)/g, (_match, value: string) => String.fromCharCode(parseInt(value, 8)));
    if (!isAbsolute(path) || path.includes('\0')) throw new Error('Mount boundary path is malformed');
    return path;
  });
}

/** Darwin prints raw names. Every possible delimiter pair is a candidate, so
 * embedded " on ", parentheses and newlines cannot conceal the actual path. */
export function darwinMountPoints(content: string): string[] {
  if (!content || content.includes('\ufffd') || content.includes('\0')) throw new Error('Mount boundary evidence is malformed');
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  // mount(8) emits one fixed-format record per line. An unrecognizable
  // fragment, including a raw newline that splits a name, is uncertainty.
  if (!lines.length || lines.some(line => {
    const start = line.indexOf(' on /');
    return start <= 0 || line.indexOf(' (', start + 4) < 0 || !line.endsWith(')');
  })) throw new Error('Mount boundary evidence is malformed');
  const mounts: string[] = [];
  for (let start = content.indexOf(' on /'); start >= 0; start = content.indexOf(' on /', start + 1)) {
    const from = start + 4;
    for (let end = content.indexOf(' (', from); end >= 0; end = content.indexOf(' (', end + 2)) {
      // getmntinfo's f_mntonname has MAXPATHLEN bytes, including NUL.
      if (Buffer.byteLength(content.slice(from, end), 'utf8') >= 1024) break;
      if (mounts.length >= 100_000) throw new Error('Mount boundary evidence is ambiguous');
      mounts.push(content.slice(from, end));
    }
  }
  if (!mounts.includes('/')) throw new Error('Mount boundary evidence is incomplete');
  return mounts;
}

/** Resolve trusted ancestor aliases, including when the resource is absent. */
export function canonicalResourceRoot(value: string): string {
  let path = resolve(value);
  const missing: string[] = [];
  for (;;) {
    try {
      const info = lstatSync(path);
      if (!missing.length && info.isSymbolicLink()) throw new Error(`Redirected resource root: ${path}`);
      return join(realpathSync(path), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(path);
      if (parent === path) throw error;
      missing.unshift(basename(path));
      path = parent;
    }
  }
}

/** Check again at each destructive boundary. This is a cooperative namespace
 * check: another same-user actor can still mount after the check. */
export function assertLinuxMountBoundary(paths: readonly string[]): void {
  if (process.platform !== 'linux') return;
  try { assertMountBoundary(paths, readFileSync('/proc/self/mountinfo', 'utf8')); }
  catch (error) {
    if (error instanceof MountBoundaryError) throw error;
    throw new MountBoundaryError(`Mount boundary cannot be verified: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function assertDarwinMountBoundary(paths: readonly string[]): void {
  if (process.platform !== 'darwin') return;
  try {
    const result = spawnSync('/sbin/mount', [], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw result.error ?? new Error('Mount enumeration failed');
    const mounts = darwinMountPoints(result.stdout);
    for (const path of paths) assertNoMountedResource(canonicalResourceRoot(path), mounts);
  } catch (error) {
    if (error instanceof MountBoundaryError) throw error;
    throw new MountBoundaryError(`Mount boundary cannot be verified: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function assertMountBoundary(paths: readonly string[], mountInfo: string): void {
  const mounts = linuxMountPoints(mountInfo);
  for (const value of paths) {
    const root = canonicalResourceRoot(value);
    assertNoMountedResource(root, mounts);
  }
}

export function assertNoMountedResource(root: string, mounts: readonly string[]): void {
  if (mounts.some(path => path === root || path.startsWith(root === sep ? sep : root + sep))) {
    throw new MountBoundaryError(`Mounted resource boundary prevents cleanup: ${root}`);
  }
}
