import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { agentHomePaths } from '../paths.ts';
import { excludeFromGit } from '../skills-remote.ts';
import { fileIdentity, withWorktreeFiles, type WorktreeFilesOptions } from '../worktree-manifest.ts';
import { CONFIG_FILES } from './catalog.ts';

/**
 * Seed only supported gitignored personal config into task worktrees and exclude it from Git.
 * Tracked files apply through commits and are never copied here.
 */

function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (err, stdout) =>
      resolve({ ok: !err, stdout: stdout ?? '' }),
    );
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether the native repo-relative `rel` is one of the caller's POSIX `preserve` paths. */
export function isPreserved(preserve: ReadonlySet<string>, rel: string, separator: string = sep): boolean {
  return preserve.has(rel.split(separator).join('/'));
}

/**
 * Copy the seeded personal-layer files from `repoRoot` into `worktreeCwd`.
 * Guards every file with `git check-ignore` so a file the user genuinely tracked
 * (against the vendor's advice) is neither copied nor excluded. `preserve` names
 * repo-relative paths the caller already placed on purpose (a worker's explicit
 * `--attach` files, hearsay-tools/cezarion#1149): those are left alone and not
 * reported. A file is written only where nothing is, or where cezar's own unchanged
 * copy is (the worktree manifest, hearsay-tools/cezarion#1814), so the agent's edit
 * survives a re-seed. Returns the repo-relative paths that hold cezar's current copy,
 * for the caller's note. Never throws.
 */
export async function seedAgentConfigLocalLayer(
  repoRoot: string,
  worktreeCwd: string,
  env: NodeJS.ProcessEnv = process.env,
  preserve: ReadonlySet<string> = new Set(),
  options: WorktreeFilesOptions = {},
): Promise<string[]> {
  if (worktreeCwd === repoRoot) return [];
  const home = agentHomePaths(env);
  const sources: Array<{ id: string; rel: string; src: string }> = [];
  for (const def of CONFIG_FILES) {
    if (!def.seeded) continue;
    const src = def.resolve(repoRoot, home);
    const rel = relative(repoRoot, src);
    // Never seed something outside the repo, or that isn't there.
    if (rel.startsWith('..') || !(await fileExists(src))) continue;
    if (isPreserved(preserve, rel)) continue;
    // Only seed a genuinely-ignored file — never force-exclude a tracked one.
    const ignored = await git(repoRoot, ['check-ignore', '-q', '--', rel]);
    if (!ignored.ok) continue;
    sources.push({ id: def.id, rel, src });
  }
  if (sources.length === 0) return [];

  return withWorktreeFiles(worktreeCwd, 'seed', options, [], async (files) => {
    const seeded: string[] = [];
    for (const { id, rel, src } of sources) {
      const path = rel.split(sep).join('/');
      try {
        const state = await files.inspect(path);
        // The agent's edit, or a file cezar never wrote: left as it is.
        if (state.owner === 'theirs') files.forget(path);
        if (state.owner !== 'free' && state.owner !== 'ours') continue;
        // Ignore first: a seeded file git could see must never exist, not even for a crash's length.
        await excludeFromGit(worktreeCwd, path);
        const meta = { kind: 'file' as const, source: id };
        if (state.owner === 'ours' && state.current === fileIdentity(await readFile(src))) {
          if (state.entry?.kind !== 'file') files.record(path, meta, state.current);
        } else {
          await files.put(path, { type: 'file', copyOf: src }, meta);
        }
        seeded.push(rel);
      } catch {
        // best-effort: a seed failure must not fail the run
      }
    }
    await files.save().catch(() => undefined);
    return seeded;
  }).catch(() => []);
}
