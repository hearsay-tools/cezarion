import { existsSync, readFileSync } from 'node:fs';

/**
 * The JSON records a native mock appended to `path`, one per line, or none when the file does not
 * exist. A mock can still be appending its last record while a test reads the file, so only lines
 * that end in a newline are parsed; the next read sees the trailing fragment whole
 * (hearsay-tools/cezarion#1855). Every mock writes one record per `appendFileSync`, newline included.
 */
export function readMockRecords<T = unknown>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line) as T);
}
