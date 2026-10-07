/**
 * Both on-disk forms of a run transcript: `runs/<id>.ndjson` and `runs/<id>.ndjson.br`.
 *
 * Readers always return the plain file when it exists. restoreHistory drops the `.br` only when
 * its decoded bytes are a byte prefix of the plain file; otherwise it keeps the compressed bytes
 * as `.ndjson.br.orphaned`. compressHistory reads and writes tmp asynchronously, then commits in
 * one synchronous block: re-check stillEligible() and that the plain file's size and mtime are
 * unchanged since the read. An existing `.br` is decoded at job start; the commit re-checks its
 * size, mtime and inode and, if the decoded bytes are not a prefix of plain, moves it to
 * `.ndjson.br.orphaned` (or `.orphaned.<n>` if that name is taken) before renaming. A size/mtime/inode
 * mismatch returns `'changed'` so the compressor can retry; ineligible or missing plain returns `'skipped'`.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { open, readFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import {
  brotliCompress,
  brotliDecompress,
  brotliDecompressSync,
  constants as zlibConstants,
} from 'node:zlib';

export const HISTORY_BROTLI_QUALITY = 5;

const brotliCompressAsync = promisify(brotliCompress);
const brotliDecompressAsync = promisify(brotliDecompress);
const brotliParams = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: HISTORY_BROTLI_QUALITY } };
const warnedUndecodable = new Set<string>();
const warnedOrphaned = new Set<string>();

export function historyPaths(dataDir: string, id: string): { plain: string; compressed: string; orphaned: string; facts: string } {
  const plain = join(dataDir, 'runs', `${id}.ndjson`);
  const compressed = `${plain}.br`;
  // The transcript-facts sidecar (transcript-facts.ts) is a cache of the transcript and goes with it.
  return { plain, compressed, orphaned: `${compressed}.orphaned`, facts: join(dataDir, 'runs', `${id}.facts.json`) };
}

export function hasPlainHistory(dataDir: string, id: string): boolean {
  return existsSync(historyPaths(dataDir, id).plain);
}

export function readHistoryText(dataDir: string, id: string): string | undefined {
  const { plain, compressed } = historyPaths(dataDir, id);
  try {
    return readFileSync(plain, 'utf8');
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  let encoded: Buffer;
  try {
    encoded = readFileSync(compressed);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  const decoded = tryDecompressSync(encoded);
  if (decoded === undefined) {
    warnUndecodable(compressed);
    return undefined;
  }
  return decoded.toString('utf8');
}

/** Which form exists, without reading either: the plain byte length, or the archive's stat. */
export function historyStat(dataDir: string, id: string): { plainSize?: number; archive?: Stats } {
  const { plain, compressed } = historyPaths(dataDir, id);
  try {
    return { plainSize: statSync(plain).size };
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  try {
    return { archive: statSync(compressed) };
  } catch (error) {
    if (isNotFound(error)) return {};
    throw error;
  }
}

/** Bytes `[from, to)` of the plain transcript; short only if it ends before `to`. */
export function readPlainHistoryRange(dataDir: string, id: string, from: number, to: number): Buffer {
  const fd = openSync(historyPaths(dataDir, id).plain, 'r');
  try {
    const buffer = Buffer.alloc(Math.max(0, to - from));
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, from + offset);
      if (count === 0) break;
      offset += count;
    }
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

/** Random-access transcript bytes. `read` is short only at EOF. */
export interface HistorySource {
  /** Decoded byte length. */
  size: number;
  /** Random access; short only at EOF (or if the file shrank). */
  read(position: number, length: number): Promise<Buffer>;
  stream(start?: number): Readable;
  close(): Promise<void>;
}

export function emptyHistorySource(): HistorySource {
  return {
    size: 0,
    async read() {
      return Buffer.alloc(0);
    },
    stream() {
      return Readable.from([]);
    },
    async close() {},
  };
}

export async function openHistorySource(dataDir: string, id: string): Promise<HistorySource | undefined> {
  const { plain, compressed } = historyPaths(dataDir, id);
  try {
    const handle = await open(plain, 'r');
    try {
      const size = (await handle.stat()).size;
      return plainSource(size, handle);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  let encoded: Buffer;
  try {
    encoded = await readFile(compressed);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try {
    return bufferSource(await brotliDecompressAsync(encoded));
  } catch {
    warnUndecodable(compressed);
    return undefined;
  }
}

export async function compressHistory(
  dataDir: string,
  id: string,
  stillEligible: () => boolean,
): Promise<'compressed' | 'skipped' | 'changed'> {
  const { plain, compressed, orphaned } = historyPaths(dataDir, id);
  let handle: FileHandle;
  try {
    handle = await open(plain, 'r');
  } catch (error) {
    if (isNotFound(error)) return 'skipped';
    throw error;
  }
  let st: Stats;
  let bytes: Buffer;
  try {
    st = await handle.stat();
    bytes = Buffer.allocUnsafe(st.size);
    let offset = 0;
    while (offset < st.size) {
      const { bytesRead } = await handle.read(bytes, offset, st.size - offset, offset);
      if (bytesRead === 0) return 'changed';
      offset += bytesRead;
    }
  } finally {
    await handle.close();
  }
  const existing = await snapshotCompressed(compressed);
  const encoded = await brotliCompressAsync(bytes, brotliParams);
  const tmp = `${compressed}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeTmpAsync(tmp, encoded);
    if (!stillEligible()) {
      rmSync(tmp, { force: true });
      return 'skipped';
    }
    let current: Stats;
    try {
      current = statSync(plain);
    } catch {
      rmSync(tmp, { force: true });
      return 'skipped';
    }
    if (current.size !== st.size || current.mtimeMs !== st.mtimeMs) {
      rmSync(tmp, { force: true });
      return 'changed';
    }
    if (!commitCompressedReplace(compressed, orphaned, existing, bytes)) {
      rmSync(tmp, { force: true });
      return 'changed';
    }
    renameSync(tmp, compressed);
    unlinkSync(plain);
    return 'compressed';
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function restoreHistory(dataDir: string, id: string): void {
  const { plain, compressed, orphaned } = historyPaths(dataDir, id);
  if (existsSync(plain)) {
    disposeCompressedBesidePlain(plain, compressed, orphaned);
    return;
  }
  let encoded: Buffer;
  try {
    encoded = readFileSync(compressed);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  const decoded = tryDecompressSync(encoded);
  if (decoded === undefined) {
    const dest = uniqueOrphanPath(`${compressed}.corrupt`);
    renameSync(compressed, dest);
    warnUndecodable(compressed, `; renamed to ${dest}`);
    return;
  }
  const tmp = `${plain}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeTmpSync(tmp, decoded);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  renameSync(tmp, plain);
  unlinkSync(compressed);
}

export function removeHistory(dataDir: string, id: string): void {
  const dir = join(dataDir, 'runs');
  const prefix = `${id}.ndjson`;
  const facts = `${id}.facts.json`;
  try {
    for (const name of readdirSync(dir)) {
      if (name === prefix || name.startsWith(`${prefix}.`) || name === facts || name.startsWith(`${facts}.`)) rmSync(join(dir, name), { force: true });
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function tryDecompressSync(encoded: Buffer): Buffer | undefined {
  try {
    return brotliDecompressSync(encoded);
  } catch {
    return undefined;
  }
}

function warnUndecodable(path: string, extra = ''): void {
  if (warnedUndecodable.has(path)) return;
  warnedUndecodable.add(path);
  console.warn(`[cez] ignoring undecodable compressed transcript ${path}${extra}`);
}

function warnOrphaned(path: string): void {
  if (warnedOrphaned.has(path)) return;
  warnedOrphaned.add(path);
  console.warn(`[cez] keeping non-prefix compressed transcript as ${path}`);
}

function isDecodedPrefix(decoded: Buffer, plain: Buffer): boolean {
  return decoded.length <= plain.length && plain.subarray(0, decoded.length).equals(decoded);
}

interface CompressedSnapshot {
  size: number;
  mtimeMs: number;
  ino: number;
  decoded: Buffer | undefined;
}

async function snapshotCompressed(compressed: string): Promise<CompressedSnapshot | undefined> {
  let st: Stats;
  try {
    st = statSync(compressed);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  let encoded: Buffer;
  try {
    encoded = await readFile(compressed);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  let decoded: Buffer | undefined;
  try {
    decoded = await brotliDecompressAsync(encoded);
  } catch {
    decoded = undefined;
  }
  return { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, decoded };
}

/** False means the existing `.br` changed; caller must not rename over it. */
function commitCompressedReplace(
  compressed: string,
  orphaned: string,
  existing: CompressedSnapshot | undefined,
  plainBytes: Buffer,
): boolean {
  let current: Stats | undefined;
  try {
    current = statSync(compressed);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  if (!current) return true;
  if (
    !existing ||
    current.size !== existing.size ||
    current.mtimeMs !== existing.mtimeMs ||
    current.ino !== existing.ino
  ) {
    return false;
  }
  if (existing.decoded === undefined || !isDecodedPrefix(existing.decoded, plainBytes)) {
    moveCompressedToOrphan(compressed, orphaned);
  }
  return true;
}

function uniqueOrphanPath(orphaned: string): string {
  if (!existsSync(orphaned)) return orphaned;
  for (let n = 1; ; n++) {
    const candidate = `${orphaned}.${n}`;
    if (!existsSync(candidate)) return candidate;
  }
}

function moveCompressedToOrphan(compressed: string, orphaned: string): void {
  const dest = uniqueOrphanPath(orphaned);
  renameSync(compressed, dest);
  warnOrphaned(dest);
}

function disposeCompressedBesidePlain(plain: string, compressed: string, orphaned: string): void {
  if (!existsSync(compressed)) return;
  let encoded: Buffer;
  try {
    encoded = readFileSync(compressed);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  const decoded = tryDecompressSync(encoded);
  if (decoded !== undefined && isDecodedPrefix(decoded, readFileSync(plain))) {
    rmSync(compressed, { force: true });
    return;
  }
  moveCompressedToOrphan(compressed, orphaned);
}

async function writeTmpAsync(tmp: string, data: Buffer): Promise<void> {
  const handle = await open(tmp, 'w');
  try {
    let offset = 0;
    while (offset < data.length) {
      const { bytesWritten } = await handle.write(data, offset, data.length - offset);
      offset += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function writeTmpSync(tmp: string, data: Buffer): void {
  const fd = openSync(tmp, 'w');
  try {
    let offset = 0;
    while (offset < data.length) {
      offset += writeSync(fd, data, offset);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function plainSource(size: number, handle: FileHandle): HistorySource {
  return {
    size,
    async read(position, length) {
      if (length <= 0 || position >= size) return Buffer.alloc(0);
      const toRead = Math.min(length, size - position);
      const buffer = Buffer.allocUnsafe(toRead);
      let offset = 0;
      while (offset < toRead) {
        const { bytesRead } = await handle.read(buffer, offset, toRead - offset, position + offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return offset === toRead ? buffer : buffer.subarray(0, offset);
    },
    stream(start = 0) {
      return handle.createReadStream({ encoding: 'utf8', start, autoClose: false });
    },
    async close() {
      await handle.close();
    },
  };
}

function bufferSource(buffer: Buffer): HistorySource {
  return {
    size: buffer.length,
    async read(position, length) {
      if (length <= 0 || position >= buffer.length) return Buffer.alloc(0);
      return buffer.subarray(position, Math.min(position + length, buffer.length));
    },
    stream(start = 0) {
      return Readable.from([buffer.subarray(start)], { encoding: 'utf8' });
    },
    async close() {},
  };
}
