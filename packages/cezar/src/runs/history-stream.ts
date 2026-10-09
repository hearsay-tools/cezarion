import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { addAbortSignal } from 'node:stream';
import { createBrotliDecompress } from 'node:zlib';
import { historyPaths } from './history-file.ts';
import { HistoryCursorError } from './event-history.ts';

/** Incremental decoded bytes: archived transcripts must not expand into an unbounded buffer. */
export async function* streamHistoryAfter(dataDir: string, id: string, offset: number, signal: AbortSignal): AsyncGenerator<Buffer> {
  signal.throwIfAborted();
  const { plain, compressed } = historyPaths(dataDir, id);
  let path = plain;
  let archive = false;
  try {
    const info = await stat(plain);
    if (offset > info.size) throw new HistoryCursorError(409, 'history cursor expired');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    path = compressed;
    archive = true;
    try { await stat(path); }
    catch (missing) {
      if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing;
      if (offset > 0) throw new HistoryCursorError(409, 'history cursor expired');
      return;
    }
  }
  signal.throwIfAborted();
  const file = addAbortSignal(signal, createReadStream(path, { ...(archive ? {} : { start: offset }), highWaterMark: 64 * 1024 }));
  const decoded = archive ? addAbortSignal(signal, createBrotliDecompress()) : file;
  // pipe does not propagate source errors to the destination.
  if (archive) { file.on('error', error => decoded.destroy(error)); file.pipe(decoded as ReturnType<typeof createBrotliDecompress>); }
  let skip = archive ? offset : 0;
  try {
    for await (const raw of decoded) {
      signal.throwIfAborted();
      const chunk = raw as Buffer;
      if (skip >= chunk.length) { skip -= chunk.length; continue; }
      yield chunk.subarray(skip);
      skip = 0;
    }
    if (skip > 0) throw new HistoryCursorError(409, 'history cursor expired');
  } finally {
    file.destroy();
    decoded.destroy();
  }
}
