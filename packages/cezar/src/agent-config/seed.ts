import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { agentHomePaths } from '../paths.ts';
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

/** Append `line` to `info/exclude` only if it is not already present (idempotent across runs). */
async function ensureExcluded(commonGitDir: string, line: string): Promise<void> {
  const excludePath = join(commonGitDir, 'info', 'exclude');
  let current = '';
  try {
    current = await readFile(excludePath, 'utf8');
  } catch {
    // no exclude file yet — created below
  }
  const lines = current.split('\n').map((l) => l.trim());
  if (lines.includes(line)) return;
  await mkdir(dirname(excludePath), { recursive: true });
  const sep = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  await writeFile(excludePath, `${current}${sep}${line}\n`, 'utf8');
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
 * reported. Returns the repo-relative paths actually seeded, for the caller's
 * note. Never throws.
 */
export async function seedAgentConfigLocalLayer(
  repoRoot: string,
  worktreeCwd: string,
  env: NodeJS.ProcessEnv = process.env,
  preserve: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  if (worktreeCwd === repoRoot) return [];
  const home = agentHomePaths(env);
  const seeded: string[] = [];

  const commonDir = await git(worktreeCwd, ['rev-parse', '--git-common-dir']);
  if (!commonDir.ok) return [];
  const commonGitDir = commonDir.stdout.trim();
  const absCommonGitDir = commonGitDir.startsWith('/') ? commonGitDir : join(worktreeCwd, commonGitDir);

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

    const dest = join(worktreeCwd, rel);
    try {
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(src, dest);
      await ensureExcluded(absCommonGitDir, rel);
      seeded.push(rel);
    } catch {
      // best-effort: a seed failure must not fail the run
    }
  }
  return seeded;
}
