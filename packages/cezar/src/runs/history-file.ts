/**
 * Both on-disk forms of a run transcript: `runs/<id>.ndjson` and `runs/<id>.ndjson.br`.
 *
 * Plain wins whenever both exist — readers return the plain file, and restoreHistory unlinks
 * the `.br`. compressHistory commits in one synchronous block: re-check stillEligible() and
 * that the plain file's size and mtime are unchanged since the read, then rename tmp → `.br`
 * and unlink plain. A crash between rename and unlink leaves both files; the next reader still
 * returns the plain content.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
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

export function historyPaths(dataDir: string, id: string): { plain: string; compressed: string } {
  const plain = join(dataDir, 'runs', `${id}.ndjson`);
  return { plain, compressed: `${plain}.br` };
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

export interface HistorySource {
  size: number;
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
): Promise<'compressed' | 'skipped'> {
  const { plain, compressed } = historyPaths(dataDir, id);
  let fd: number;
  try {
    fd = openSync(plain, 'r');
  } catch (error) {
    if (isNotFound(error)) return 'skipped';
    throw error;
  }
  let st: Stats;
  let bytes: Buffer;
  try {
    st = fstatSync(fd);
    bytes = Buffer.allocUnsafe(st.size);
    const bytesRead = st.size === 0 ? 0 : readSync(fd, bytes, 0, st.size, 0);
    if (bytesRead !== st.size) bytes = bytes.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
  const encoded = await brotliCompressAsync(bytes, brotliParams);
  const tmp = `${compressed}.tmp`;
  try {
    writeTmpSync(tmp, encoded);
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
      return 'skipped';
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
  const { plain, compressed } = historyPaths(dataDir, id);
  if (existsSync(plain)) {
    rmSync(compressed, { force: true });
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
    const corrupt = `${compressed}.corrupt`;
    rmSync(corrupt, { force: true });
    renameSync(compressed, corrupt);
    warnUndecodable(compressed, `; renamed to ${corrupt}`);
    return;
  }
  const tmp = `${plain}.tmp`;
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
  const { plain, compressed } = historyPaths(dataDir, id);
  rmSync(plain, { force: true });
  rmSync(compressed, { force: true });
  rmSync(`${plain}.tmp`, { force: true });
  rmSync(`${compressed}.tmp`, { force: true });
  rmSync(`${compressed}.corrupt`, { force: true });
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
      const { bytesRead } = await handle.read(buffer, 0, toRead, position);
      return bytesRead === toRead ? buffer : buffer.subarray(0, bytesRead);
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
