import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import zlib from 'node:zlib';
import { vi } from 'vitest';

/**
 * Counts synchronous transcript reads (hearsay-tools/cezarion#880): whole-file `readFileSync` and
 * read-mode `openSync` of a `.ndjson` / `.ndjson.br`, and every `brotliDecompressSync`. Writes
 * (`appendFileSync`, tmp files) and sidecar reads are not counted. Callers restore with
 * `vi.restoreAllMocks(); syncBuiltinESMExports()`.
 */
export function countTranscriptReads(match: (path: string) => boolean = () => true) {
  const counts = { files: [] as string[], decompress: 0 };
  const transcript = (path: unknown) => typeof path === 'string' && /\.ndjson(?:\.br)?$/.test(path) && match(path);
  const readFileSync = fs.readFileSync;
  const openSync = fs.openSync;
  const brotliDecompressSync = zlib.brotliDecompressSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((path: unknown, ...rest: unknown[]) => {
    if (transcript(path)) counts.files.push(path as string);
    return (readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync);
  vi.spyOn(fs, 'openSync').mockImplementation(((path: unknown, flags?: unknown, ...rest: unknown[]) => {
    if (transcript(path) && (flags === undefined || flags === 'r' || flags === fs.constants.O_RDONLY)) counts.files.push(path as string);
    return (openSync as (...args: unknown[]) => number)(path, flags, ...rest);
  }) as typeof fs.openSync);
  vi.spyOn(zlib, 'brotliDecompressSync').mockImplementation(((...args: unknown[]) => {
    counts.decompress++;
    return (brotliDecompressSync as (...a: unknown[]) => Buffer)(...args);
  }) as typeof zlib.brotliDecompressSync);
  syncBuiltinESMExports();
  return {
    counts,
    reset() { counts.files.length = 0; counts.decompress = 0; },
  };
}

export function restoreTranscriptReads(): void {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
}
