import { copyFile, stat, utimes } from 'node:fs/promises';

/**
 * Copy a git index for use as a private `GIT_INDEX_FILE`, keeping the source's
 * mtime (hearsay-tools/cezarion#1088). Git re-reads a file's content only when its
 * cached mtime is not older than the index file's own mtime (the racy-git check);
 * a plain copy is newer than every entry, so a same-size edit made in the same
 * second as the original index write would read as clean and vanish from the diff.
 */
export async function copyGitIndex(source: string, target: string): Promise<void> {
  await copyFile(source, target);
  const { atime, mtime } = await stat(source);
  await utimes(target, atime, mtime);
}
