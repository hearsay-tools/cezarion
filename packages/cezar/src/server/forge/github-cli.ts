import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Keep account-directory and host selection attached to shared work. Never key by owner/name:
// separate local roots (including different remotes/accounts) must not share results.
export function githubContext(repoRoot: string) {
  const env = { GH_HOST: process.env.GH_HOST, GH_CONFIG_DIR: process.env.GH_CONFIG_DIR };
  return { key: JSON.stringify([repoRoot, env.GH_HOST, env.GH_CONFIG_DIR]), env };
}
export type GithubContext = ReturnType<typeof githubContext>;

export async function gh(repoRoot: string, args: string[], timeout = 15_000, signal?: AbortSignal, context?: GithubContext): Promise<string> {
  const { stdout } = await exec('gh', args, {
    cwd: repoRoot,
    ...(context ? { env: { ...process.env, ...context.env } } : {}),
    timeout,
    maxBuffer: 50 * 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
  return stdout;
}

/** `owner/name` → `{ owner, name }`, or null when the handle isn't a clean two-part slug. */
export function parseOwnerName(nameWithOwner: string): { owner: string; name: string } | null {
  const [owner, name, ...rest] = nameWithOwner.trim().split('/');
  return owner && name && rest.length === 0 ? { owner, name } : null;
}
