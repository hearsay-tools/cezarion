import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { brotliCompress, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';
import { z } from 'zod';

export const HISTORY_BROTLI_QUALITY = 5;

const brotliCompressAsync = promisify(brotliCompress);
const brotliParams = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: HISTORY_BROTLI_QUALITY } };

export function historyPaths(dataDir: string, id: string): { plain: string; compressed: string } {
  z.uuid().parse(id);
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
  try {
    return brotliDecompressSync(readFileSync(compressed)).toString('utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export interface HistorySource {
  size: number;
  read(position: number, length: number): Promise<Buffer>;
  stream(start?: number): Readable;
  close(): Promise<void>;
}

export async function openHistorySource(dataDir: string, id: string): Promise<HistorySource | undefined> {
  const { plain, compressed } = historyPaths(dataDir, id);
  try {
    const handle = await open(plain, 'r');
    try {
      const size = (await handle.stat()).size;
      return plainSource(plain, size, handle);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  try {
    return bufferSource(brotliDecompressSync(readFileSync(compressed)));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export async function compressHistory(
  dataDir: string,
  id: string,
  stillEligible: () => boolean,
): Promise<'compressed' | 'skipped'> {
  const { plain, compressed } = historyPaths(dataDir, id);
  let st: Stats;
  let bytes: Buffer;
  try {
    st = statSync(plain);
    bytes = readFileSync(plain);
  } catch (error) {
    if (isNotFound(error)) return 'skipped';
    throw error;
  }
  const encoded = await brotliCompressAsync(bytes, brotliParams);
  const tmp = `${compressed}.tmp`;
  writeFileSync(tmp, encoded);
  try {
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
    const fd = openSync(tmp, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
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
  const tmp = `${plain}.tmp`;
  writeFileSync(tmp, brotliDecompressSync(encoded));
  renameSync(tmp, plain);
  unlinkSync(compressed);
}

export function removeHistory(dataDir: string, id: string): void {
  const { plain, compressed } = historyPaths(dataDir, id);
  rmSync(plain, { force: true });
  rmSync(compressed, { force: true });
  rmSync(`${plain}.tmp`, { force: true });
  rmSync(`${compressed}.tmp`, { force: true });
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function slice(buffer: Buffer, position: number, length: number): Buffer {
  if (length <= 0 || position >= buffer.length) return Buffer.alloc(0);
  return Buffer.from(buffer.subarray(position, position + length));
}

function plainSource(path: string, size: number, handle: Awaited<ReturnType<typeof open>>): HistorySource {
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
      return createReadStream(path, { encoding: 'utf8', start });
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
      return slice(buffer, position, length);
    },
    stream(start = 0) {
      return Readable.from([buffer.subarray(start)], { encoding: 'utf8' });
    },
    async close() {},
  };
}
