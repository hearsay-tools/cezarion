import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The absent-file fast path uses at most one stat before waiting for write.lock. */
export function assertNoMigration(root: string, locked = false): void {
  const path = join(root, '.migrating');
  try {
    if (locked) readFileSync(path);
    else lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`[cez] home migration in progress at ${path}; stop this writer and retry after migration`);
}
