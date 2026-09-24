import { randomUUID, createHash } from 'node:crypto';
import { constants, realpathSync, type BigIntStats } from 'node:fs';
import { mkdir, open, opendir, realpath, lstat, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { publishedArtifactSchema, type PublishedArtifact } from '@open-mercato/cezar-contract';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_METADATA_BYTES = 32 * 1024;
const MAX_RUN_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACTS = 64;
const MAX_DIRECTORY_ENTRIES = 1024;
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function validateContext(directory: string, runId: string): void {
  z.uuid().parse(runId);
  if (!isAbsolute(directory) || basename(directory) !== `${runId}-artifacts`) throw new Error('Invalid artifact task directory');
}
export function artifactDirectory(dataDir: string, runId: string): string {
  z.uuid().parse(runId);
  // The server's trusted data root may have an OS alias (e.g. macOS /var).
  // Only canonicalize that root; runs/task entry redirects remain forbidden.
  let root = resolve(dataDir);
  try { root = realpathSync(root); } catch { /* absent storage reads as unavailable */ }
  return join(root, 'runs', `${runId}-artifacts`);
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function sameSnapshot(a: BigIntStats, b: BigIntStats): boolean {
  return sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
}

/** Never use readFile on untrusted descriptors: a growing file otherwise bypasses the size check. */
async function boundedRead(path: string, limit: number, stored = false): Promise<Buffer> {
  const file = await open(path, readFlags);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(limit) || (stored && before.nlink !== 1n)) throw new Error('Artifact must be a bounded regular file');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await file.read(buffer, count, buffer.length - count, count);
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (count !== Number(before.size) || !sameSnapshot(before, after) || !sameFile(after, current) || current.isSymbolicLink()) throw new Error('File changed while publishing or reading artifact');
    return buffer.subarray(0, count);
  } finally { await file.close(); }
}

type Directory = { path: string; check: () => Promise<void>; close: () => Promise<void> };
/** Reject symlinks in every storage component. Linux operations stay anchored to open directory
 * descriptors; other platforms revalidate identity before/after use, not a same-user sandbox. */
async function storageDirectory(path: string, create = false): Promise<Directory> {
  const absolute = resolve(path);
  let file: FileHandle | undefined;
  const root = parse(absolute).root;
  let current = root;
  try {
    file = await open(root, readFlags | constants.O_DIRECTORY);
    for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
      current = join(current, part);
      const anchored = process.platform === 'linux' ? join(`/proc/self/fd/${file.fd}`, part) : current;
      if (create) await mkdir(anchored, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const next = await open(anchored, readFlags | constants.O_DIRECTORY);
      await file.close(); file = next;
    }
    const handle = file;
    const original = await handle.stat({ bigint: true });
    const check = async () => {
      if (await realpath(absolute) !== absolute || !sameFile(original, await lstat(absolute, { bigint: true }))) throw new Error('Redirected artifact storage');
    };
    await check();
    return { path: process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : absolute, check, close: () => handle.close() };
  } catch (error) { await file?.close(); throw error; }
}

async function* entries(path: string): AsyncGenerator<string> {
  const stream = await opendir(path);
  let count = 0;
  for await (const entry of stream) {
    if (++count > MAX_DIRECTORY_ENTRIES) throw new Error('Artifact directory entry limit exceeded');
    yield entry.name;
  }
}

const ownerSchema = z.object({ pid: z.number().int().positive().max(2147483647), host: z.string().min(1).max(255) }).strict();
async function reclaimDeadLock(root: Directory): Promise<void> {
  let lock: FileHandle | undefined;
  try {
    const path = join(root.path, '.publish.lock');
    lock = await open(path, readFlags | constants.O_DIRECTORY);
    const pinned = process.platform === 'linux' ? `/proc/self/fd/${lock.fd}` : path;
    const owner = ownerSchema.parse(JSON.parse((await boundedRead(join(pinned, 'owner.json'), 1024, true)).toString('utf8')));
    if (owner.host !== hostname()) return;
    try { process.kill(owner.pid, 0); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return; }
    // Only one reaper can claim this inode. Keep its marker through the rename, so another
    // observer of the old lock cannot remove a newly acquired lock (the stale-unlink race).
    await mkdir(join(pinned, '.reaping'), { mode: 0o700 });
    if (!sameFile(await lock.stat({ bigint: true }), await lstat(path, { bigint: true }))) return;
    await root.check();
    const retired = join(root.path, `.retired-lock-${randomUUID()}`);
    await rename(path, retired);
    await rm(retired, { recursive: true, force: true });
  } catch { /* Unknown owner, permission failure, or another reaper: fail closed and retry. */ }
  finally { await lock?.close(); }
}
async function acquireLock(root: Directory): Promise<() => Promise<void>> {
  const candidate = join(root.path, `.lock-candidate-${randomUUID()}`);
  const path = join(root.path, '.publish.lock');
  await mkdir(candidate, { mode: 0o700 });
  try {
    await writeFile(join(candidate, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname() }), { flag: 'wx', mode: 0o600 });
    const identity = await lstat(candidate, { bigint: true });
    const deadline = performance.now() + 5000;
    for (;;) {
      await root.check();
      try {
        // rename may replace an empty directory; an existing ownerless lock is not permission
        // to publish. Cooperating publishers only introduce non-empty locks atomically.
        const exists = await lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        });
        if (!exists) {
          await rename(candidate, path);
          return async () => {
            if (sameFile(identity, await lstat(path, { bigint: true }))) await rm(path, { recursive: true, force: true });
          };
        }
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      if (performance.now() >= deadline) throw new Error('Artifact publication lock is busy or has an unverifiable owner');
      await reclaimDeadLock(root);
      await delay(20);
    }
  } finally { await rm(candidate, { recursive: true, force: true }); }
}
async function checkCapacity(root: Directory, incomingBytes: number): Promise<void> {
  let count = 0;
  let bytes = 0;
  for await (const id of entries(root.path)) {
    if (!z.uuid().safeParse(id).success && !/^\.pending-[0-9a-f-]{36}$/i.test(id)) continue;
    if (++count >= MAX_ARTIFACTS) throw new Error('Artifact count limit exceeded');
    let entry: FileHandle | undefined;
    try {
      entry = await open(join(root.path, id), readFlags | constants.O_DIRECTORY);
      const pinned = process.platform === 'linux' ? `/proc/self/fd/${entry.fd}` : join(root.path, id);
      const stat = await lstat(join(pinned, 'content'), { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(MAX_FILE_BYTES)) throw new Error('Unsafe stored artifact');
      bytes += Number(stat.size);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    finally { await entry?.close(); }
    if (bytes + incomingBytes > MAX_RUN_BYTES) throw new Error('Artifact task byte limit exceeded');
  }
}

export async function publishArtifact(directory: string, runId: string, source: string): Promise<PublishedArtifact> {
  validateContext(directory, runId);
  const root = await storageDirectory(directory, true);
  let release: (() => Promise<void>) | undefined;
  let pending: string | undefined;
  let staging: FileHandle | undefined;
  try {
    release = await acquireLock(root);
    // With the publication lock held, no cooperating writer can own a temporary entry.
    // Completed UUID entries are never evicted, even if their metadata is corrupt.
    for await (const id of entries(root.path)) {
      if (/^\.pending-[0-9a-f-]{36}$/i.test(id)) await rm(join(root.path, id), { recursive: true, force: true });
    }
    const bytes = await boundedRead(source, MAX_FILE_BYTES);
    // A same-size rewrite inside one timestamp tick leaves the stat snapshot above
    // unchanged, so reread and compare: any mutation that landed before this second
    // read surfaces as differing bytes. Later mutations stay covered by the snapshot.
    const reread = await boundedRead(source, MAX_FILE_BYTES);
    if (!bytes.equals(reread)) throw new Error('File changed while publishing or reading artifact');
    await checkCapacity(root, bytes.length);
    const metadata = publishedArtifactSchema.parse({ id: randomUUID(), runId, name: basename(source), sourcePath: resolve(source), createdAt: new Date().toISOString(), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    pending = join(root.path, `.pending-${metadata.id}`);
    await root.check();
    await mkdir(pending, { mode: 0o700 });
    staging = await open(pending, readFlags | constants.O_DIRECTORY);
    const pinned = process.platform === 'linux' ? `/proc/self/fd/${staging.fd}` : pending;
    await writeFile(join(pinned, 'content'), bytes, { mode: 0o600, flag: 'wx' });
    await writeFile(join(pinned, 'metadata.json'), JSON.stringify(metadata), { mode: 0o600, flag: 'wx' });
    if (!sameFile(await staging.stat({ bigint: true }), await lstat(pending, { bigint: true }))) throw new Error('Redirected artifact staging');
    await root.check();
    await rename(pending, join(root.path, metadata.id));
    await root.check();
    return metadata;
  } finally {
    try { await staging?.close(); if (pending) await rm(pending, { recursive: true, force: true }); }
    finally { try { await release?.(); } finally { await root.close(); } }
  }
}

async function readEntry(root: Directory, runId: string, id: string): Promise<{ metadata: PublishedArtifact; bytes: Buffer } | null> {
  if (!z.uuid().safeParse(id).success) return null;
  let entry: FileHandle | undefined;
  try {
    await root.check();
    entry = await open(join(root.path, id), readFlags | constants.O_DIRECTORY);
    const path = process.platform === 'linux' ? `/proc/self/fd/${entry.fd}` : join(root.path, id);
    const metadata = publishedArtifactSchema.parse(JSON.parse((await boundedRead(join(path, 'metadata.json'), MAX_METADATA_BYTES, true)).toString('utf8')));
    if (metadata.runId !== runId || metadata.id !== id || metadata.size > MAX_FILE_BYTES) return null;
    const bytes = await boundedRead(join(path, 'content'), MAX_FILE_BYTES, true);
    if (bytes.length !== metadata.size || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) return null;
    if (!sameFile(await entry.stat({ bigint: true }), await lstat(join(root.path, id), { bigint: true }))) return null;
    await root.check();
    return { metadata, bytes };
  } catch { return null; } finally { await entry?.close(); }
}
export async function readArtifact(directory: string, runId: string, id: string): Promise<{ metadata: PublishedArtifact; bytes: Buffer } | null> {
  let root: Directory | undefined;
  try {
    validateContext(directory, runId);
    root = await storageDirectory(directory);
    return await readEntry(root, runId, id);
  } catch { return null; } finally { await root?.close(); }
}
export async function listArtifacts(directory: string, runId: string): Promise<PublishedArtifact[]> {
  let root: Directory | undefined;
  try {
    validateContext(directory, runId);
    root = await storageDirectory(directory);
    const artifacts: PublishedArtifact[] = [];
    let bytes = 0;
    for await (const id of entries(root.path)) {
      const entry = await readEntry(root, runId, id);
      if (entry) {
        bytes += entry.metadata.size;
        artifacts.push(entry.metadata);
        if (artifacts.length > MAX_ARTIFACTS || bytes > MAX_RUN_BYTES) return [];
      }
    }
    return artifacts.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  } catch { return []; } finally { await root?.close(); }
}
