import { closeSync, openSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/** Generated names only. Reject encodings rather than decoding attacker-controlled paths twice. */
export function isAttachmentFileName(name: string): boolean {
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}

/** A run's attachment store may not be redirected through a symlink, including its runs parent. */
export function attachmentDirectory(dataDir: string, runId: string): string | null {
  if (!isAttachmentFileName(runId)) return null;
  try {
    const expected = join(realpathSync(dataDir), 'runs', `${runId}-images`);
    const actual = realpathSync(expected);
    return actual === expected && statSync(actual).isDirectory() ? actual : null;
  } catch {
    return null;
  }
}

/** Shared by HTTP reads and prompt hydration: a file must resolve inside its own run's store. */
export function resolveAttachmentPath(dataDir: string, runId: string, name: string): string | null {
  if (!isAttachmentFileName(name)) return null;
  const dir = attachmentDirectory(dataDir, runId);
  if (!dir) return null;
  try {
    const path = realpathSync(join(dir, name));
    if (!path.startsWith(`${dir}${sep}`) || !statSync(path).isFile()) return null;
    // Documents carry no inline bytes, so stat alone cannot prove the agent can read them.
    const fd = openSync(path, 'r');
    closeSync(fd);
    return path;
  } catch {
    return null;
  }
}
