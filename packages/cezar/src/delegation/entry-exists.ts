import { lstat } from 'node:fs/promises';

/** Whether a directory entry exists at `path`, without following a final symlink. Any error but ENOENT throws. */
export async function entryExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}
