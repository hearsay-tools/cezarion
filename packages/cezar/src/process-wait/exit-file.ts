import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * A process wait's exit file (hearsay-tools/cezarion#1446, spec 2026-10-17-unified-waits § Process
 * wait decisions). The agent's own shell writes the command's exit code to it, since Cezar cannot
 * read a non-child's status. It must sit in the run's worktree or its Cezar temp directory, no
 * symlink may lead out of them, and only an integer first line ever leaves it.
 */
export type ExitFileRoots = { worktree: string; tmpDir?: string };

const EXIT_FILE_READ_MAX = 64;
const INT32 = /^-?\d{1,10}$/;

function real(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** The path with every existing ancestor resolved, so a missing tail still meets its symlinks. */
function realThroughAncestors(path: string): string {
  let existing = path; const tail: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) { tail.unshift(existing.slice(dirname(existing).length + 1)); existing = dirname(existing); }
  return tail.length ? join(real(existing), ...tail) : real(existing);
}

function rootsOf(roots: ExitFileRoots): string[] {
  return [roots.worktree, ...(roots.tmpDir === undefined ? [] : [roots.tmpDir])];
}

/** Resolve `path` (absolute, or relative to the worktree) and check it stays inside a root. */
export function confineExitFile(path: string, roots: ExitFileRoots): { ok: true; path: string } | { ok: false; allowed: string[] } {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(roots.worktree, path);
  const resolved = realThroughAncestors(absolute);
  const inside = rootsOf(roots).map(real).some(root => resolved === root || resolved.startsWith(root + sep));
  return inside ? { ok: true, path: absolute } : { ok: false, allowed: rootsOf(roots) };
}

/**
 * Whether the exit file exists and, when its first line is a 32-bit integer, the code. Reads at
 * most 64 bytes. Throws when the path now resolves outside the roots (a symlink swapped in after
 * registration), so the caller reports an error instead of reading it.
 */
export function readExitCode(path: string, roots: ExitFileRoots): { present: false } | { present: true; exitCode?: number } {
  if (!existsSync(path)) return { present: false };
  if (!confineExitFile(path, roots).ok) throw new Error('the exit file now resolves outside the worktree and the Cezar temp directory');
  // Non-blocking: a FIFO with no writer would block a plain open, and this runs on the server's
  // event loop. The opened descriptor, not a path stat, decides, so a file swapped in between
  // the two cannot slip past.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) return { present: true };
    const buffer = Buffer.alloc(EXIT_FILE_READ_MAX);
    const read = readSync(fd, buffer, 0, EXIT_FILE_READ_MAX, 0);
    const text = buffer.subarray(0, read).toString('utf8');
    // A file longer than the read has no line end inside it: the first line is not all here.
    const newline = text.indexOf('\n');
    if (newline < 0 && fstatSync(fd).size > read) return { present: true };
    const first = (newline < 0 ? text : text.slice(0, newline)).trim();
    if (!INT32.test(first)) return { present: true };
    const code = Number(first);
    return code >= -2147483648 && code <= 2147483647 ? { present: true, exitCode: code } : { present: true };
  } finally { closeSync(fd); }
}
