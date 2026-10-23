import { copyFile, stat, utimes } from 'node:fs/promises';

/**
 * Copy a private GIT_INDEX_FILE while preserving mtime for Git’s racy-clean checks.
 */
export async function copyGitIndex(source: string, target: string): Promise<void> {
  await copyFile(source, target);
  const { atime, mtime } = await stat(source);
  await utimes(target, atime, mtime);
}
