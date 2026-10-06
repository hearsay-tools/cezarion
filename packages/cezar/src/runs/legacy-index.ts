import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';

import { anotherCockpitOwner } from '../server/cockpit-ownership.ts';

/**
 * The legacy run index at the moment `runs.db` imports it (#779, plan step 4): its exact bytes,
 * a durable copy of them beside it, and the checks that no older cezar is still writing it.
 *
 * An older cezar writes only `runs.json` and knows nothing of `runs.db`, so importing while one
 * still runs would freeze a file that keeps moving. Two signals say one does:
 * - a live cockpit other than this process holds `cockpit.lock`. A new cockpit takes that lock
 *   before it opens its store, so with no import done yet the holder is an older cockpit (v0.15.1
 *   and later write the lock), or a new one about to import, which a retry lets finish first;
 * - `runs.json` is not the file that was read. Older cezars save it by temp file and rename, so
 *   every save replaces the inode, and a save during the import shows.
 * An older process that holds no lock (a `cez run`, a cockpit before v0.15.1) and saves nothing
 * while the import runs is not seen; whatever it writes later is never imported.
 */

/** The legacy index (#779): read once, imported into `runs.db`, never written again. */
export const LEGACY_INDEX_FILE = 'runs.json';
/** The exact bytes `runs.json` held when it was imported, kept beside it. */
export const LEGACY_INDEX_BACKUP_FILE = 'runs.json.pre-sqlite.bak';

/** Enough of a file's identity to tell that it was replaced or rewritten. */
interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

/** `runs.json` as one read saw it. */
export interface LegacyIndexSnapshot {
  bytes: Buffer;
  sha256: string;
  identity: FileIdentity;
}

const identityOf = (stats: Stats): FileIdentity => ({ dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs });
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** `path` read in one go through one descriptor, so its bytes and identity belong together.
 *  Undefined when there is no such file. */
export function readLegacyIndex(path: string): LegacyIndexSnapshot | undefined {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const identity = identityOf(fstatSync(fd));
    const bytes = readFileSync(fd);
    return { bytes, sha256: sha256(bytes), identity };
  } finally {
    closeSync(fd);
  }
}

/** Whether `path` holds exactly `snapshot`'s bytes. */
function holds(path: string, snapshot: LegacyIndexSnapshot): boolean {
  try {
    if (statSync(path).size !== snapshot.bytes.length) return false;
    return sha256(readFileSync(path)) === snapshot.sha256;
  } catch {
    return false;
  }
}

/**
 * Create `path` holding `bytes`, durably and never half-written: a temp file is written and
 * synced, then linked into place, which refuses a name that already exists. False when it does.
 * The directory is synced too, so a crash cannot forget the new name. A file system without hard
 * links gets a rename, guarded by an existence check instead.
 */
function createDurably(path: string, bytes: Buffer): boolean {
  const temp = `${path}.${randomUUID()}.tmp`;
  // Removed on every way out, a failed write (ENOSPC) included: the name is either linked or gone.
  try {
    const fd = openSync(temp, 'wx');
    try {
      for (let written = 0; written < bytes.length;) written += writeSync(fd, bytes, written);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temp, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false;
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV') throw error;
      if (statSync(path, { throwIfNoEntry: false })) return false;
      renameSync(temp, path);
    }
  } finally {
    try { unlinkSync(temp); } catch { /* never created, or renamed into place */ }
  }
  syncDirectory(path);
  return true;
}

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirname(path), 'r');
    fsyncSync(fd);
  } catch {
    // Not every platform can sync a directory; the file itself is already synced.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Keep `snapshot`'s exact bytes beside `runs.json` and answer the backup's file name. An existing
 * `runs.json.pre-sqlite.bak` is trusted only when it holds those very bytes (same size and
 * sha256). One that does not — an earlier snapshot, a file a crash cut short — is never touched:
 * the bytes go to `runs.json.pre-sqlite.<sha256 prefix>.bak` instead.
 *
 * The import calls this only inside its transaction, once nothing can refuse it any more: an
 * attempt an older cezar's writes refuse leaves no backup, so retries cannot multiply them.
 */
export function backUpLegacyIndex(dataDir: string, snapshot: LegacyIndexSnapshot): string {
  for (const name of [LEGACY_INDEX_BACKUP_FILE, `runs.json.pre-sqlite.${snapshot.sha256.slice(0, 12)}.bak`]) {
    const path = join(dataDir, name);
    if (holds(path, snapshot)) return name;
    // Re-checked only after creating it: a file this did not create may hold other bytes.
    if (createDurably(path, snapshot.bytes) || holds(path, snapshot)) return name;
  }
  throw new Error(`cannot back up ${LEGACY_INDEX_FILE}: both backup names are taken by other contents`);
}

/** An older cezar still writes `runs.json`, so it was not imported. */
export class LegacyWriterError extends Error {
  /** `cockpit`: a live cockpit other than this process holds `cockpit.lock`. `changed`: the file
   *  changed between the read and the import. */
  readonly reason: 'cockpit' | 'changed';

  constructor(reason: 'cockpit' | 'changed', message: string) {
    super(message);
    this.name = 'LegacyWriterError';
    this.reason = reason;
  }
}

/** Throw `LegacyWriterError` when a live cockpit other than this process owns `dataDir`. Cheap: one
 *  small file read and a liveness probe, so the import asks it before it reads anything. */
export function assertNoLegacyCockpit(dataDir: string): void {
  const owner = anotherCockpitOwner(dataDir);
  if (owner) {
    throw new LegacyWriterError('cockpit', `An older cezar (pid ${owner.pid}${owner.url ? ` at ${owner.url}` : ''}) still serves this project and writes ${LEGACY_INDEX_FILE}. Stop it, then restart cezar: ${LEGACY_INDEX_FILE} is imported once, while nothing else writes it.`);
  }
}

/**
 * Throw `LegacyWriterError` when an older cezar may still be writing `runs.json`: another live
 * cockpit owns `dataDir` (`assertNoLegacyCockpit`), or the file is no longer what `snapshot` read
 * (undefined: there was none). Inside the import transaction, right before it commits, this is
 * the authority; asked earlier it only saves the work of an import that could not commit.
 */
export function assertNoLegacyWriter(dataDir: string, snapshot: LegacyIndexSnapshot | undefined): void {
  assertNoLegacyCockpit(dataDir);
  const now = statSync(join(dataDir, LEGACY_INDEX_FILE), { throwIfNoEntry: false });
  const read = snapshot?.identity;
  const same = now === undefined ? read === undefined
    : read !== undefined && now.dev === read.dev && now.ino === read.ino && now.size === read.size && now.mtimeMs === read.mtimeMs;
  if (!same) {
    throw new LegacyWriterError('changed', `${LEGACY_INDEX_FILE} changed while cezar was importing it: an older cezar process still writes it. Stop every older cezar process for this project, then restart cezar.`);
  }
}
