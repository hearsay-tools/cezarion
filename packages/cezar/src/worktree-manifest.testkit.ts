import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { identityOf, MANIFEST_FILE, type ManifestEntry } from './worktree-manifest.ts';

const execFileAsync = promisify(execFile);

async function gitLines(cwd: string, args: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.split('\n').filter(Boolean);
}

/** The worktree's committed manifest, as a crash would leave it; null when there is none. */
export async function readManifest(worktree: string): Promise<{ entries: ManifestEntry[]; skills?: { roots?: string[] } } | null> {
  const [gitDir] = await gitLines(worktree, ['rev-parse', '--absolute-git-dir']);
  const text = await readFile(join(gitDir!, MANIFEST_FILE), 'utf8').catch(() => null);
  return text === null ? null : (JSON.parse(text) as { entries: ManifestEntry[] });
}

/**
 * The coverage walk (hearsay-tools/cezarion#1814): every path git does not track, ignored or not,
 * lies at or under a manifest entry whose identity still matches, unless the test made it
 * (`made`, worktree-relative, `/`-joined; a dir covers what is under it). Returns the paths that
 * break it: a write path that skips the manifest leaves one.
 */
export async function uncoveredPaths(worktree: string, made: readonly string[] = []): Promise<string[]> {
  const untracked = [
    ...(await gitLines(worktree, ['ls-files', '--others', '--exclude-standard'])),
    ...(await gitLines(worktree, ['ls-files', '--others', '--ignored', '--exclude-standard'])),
  ];
  const entries = (await readManifest(worktree))?.entries ?? [];
  const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
  const uncovered: string[] = [];
  for (const path of new Set(untracked)) {
    if (made.some((root) => under(path, root))) continue;
    const entry = entries.find((candidate) => under(path, candidate.path));
    const current = entry ? await identityOf(join(worktree, entry.path)) : null;
    if (!entry || (current !== entry.identity && current !== entry.alternate)) uncovered.push(path);
  }
  return uncovered.sort();
}
