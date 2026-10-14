import { readFileSync } from 'node:fs';

/**
 * Pid files written by test fakes and mocks, read safely (hearsay-tools/cezarion#953).
 *
 * `Number('')` is 0, and `process.kill(0, signal)` signals the CALLER's whole process group:
 * Vitest's main process and every fork worker, or the Squeal daemon hosting them. A pid file
 * is empty between its writer's open and its write, and forever when the writer dies there,
 * so `process.kill(Number(readFileSync(file)))` in a cleanup can SIGKILL the entire run.
 * `kill(1)` is no better. Every test that reads a pid from a file, a line or stdout goes
 * through here, and only a line that is a whole decimal number above 1 counts as a pid.
 */

export type Kill = (pid: number, signal?: NodeJS.Signals | number) => unknown;

/** One complete pid, or undefined for an empty, partial or garbage line, and for 0 and 1. */
export function parsePid(line: string): number | undefined {
  const text = line.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const pid = Number(text);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

/** Every complete pid in `text`, one per line. */
export function parsePids(text: string): number[] {
  return text.split('\n').flatMap(line => parsePid(line) ?? []);
}

/** Every complete pid in `file`; [] while it is absent or empty. */
export function readPids(file: string): number[] {
  try { return parsePids(readFileSync(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

/** The pid a single-pid file holds, or undefined until it holds exactly one complete pid. */
export function readPid(file: string): number | undefined {
  const pids = readPids(file);
  return pids.length === 1 ? pids[0] : undefined;
}

/** The one pid a child printed (`console.log(child.pid)`); throws, never answers 0, on anything else. */
export function requirePidText(text: string, source = 'output'): number {
  const pids = parsePids(text);
  if (pids.length !== 1) throw new Error(`${source} holds no complete pid: ${JSON.stringify(text)}`);
  return pids[0]!;
}

/** {@link readPid} for an assertion: a file that holds no complete pid fails the test, never names pid 0. */
export function requirePid(file: string): number {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (error) { text = `<${(error as NodeJS.ErrnoException).code}>`; }
  return requirePidText(text, `pid file ${file}`);
}

/**
 * Signal every complete pid in `file`. A process that is already gone (ESRCH), or whose pid
 * now belongs to someone else's process (EPERM), is skipped; any other error is thrown.
 * Returns the pids it signalled. `kill` is injectable for tests and for suites that spy on
 * `process.kill`.
 */
export function killFromPidFile(file: string, signal: NodeJS.Signals | number = 'SIGKILL', kill: Kill = process.kill.bind(process)): number[] {
  const signalled: number[] = [];
  for (const pid of readPids(file)) {
    try { kill(pid, signal); signalled.push(pid); }
    catch (error) { if (!['ESRCH', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
  return signalled;
}

/**
 * CommonJS source for a fake that publishes its pid to `file` atomically: written to a
 * temporary sibling, then renamed into place, so a reader sees no file or a complete one.
 * Pass `append` when several processes record into the same file: the first creates it with
 * a hard link (also atomic, and it fails rather than replacing a pid already there), the
 * rest append one short line each, which a single O_APPEND write never splits.
 */
export function writePidSource(file: string, { append = false }: { append?: boolean } = {}): string {
  const path = JSON.stringify(file);
  return append
    ? `{ const fs = require('node:fs'); const line = String(process.pid) + '\\n'; const tmp = ${path} + '.' + process.pid + '.tmp';`
      + ` fs.writeFileSync(tmp, line); try { fs.linkSync(tmp, ${path}); } catch (error) { if (error.code !== 'EEXIST') throw error; fs.appendFileSync(${path}, line); }`
      + ` finally { fs.rmSync(tmp, { force: true }); } }`
    : `{ const fs = require('node:fs'); const tmp = ${path} + '.' + process.pid + '.tmp';`
      + ` fs.writeFileSync(tmp, String(process.pid)); fs.renameSync(tmp, ${path}); }`;
}
