/** A git remote as a GitHub web root (`https://github.com/owner/repo`) — the caller passes the
 *  remote `/api/v1/health` reports (`repo.remote`), via `useProjectRepoBase`. Handles the scheme forms
 *  (`https://`, `ssh://`, credentials, port) and the scp-like `git@github.com:owner/repo.git`;
 *  undefined for every non-github.com host, local path, or absent remote — the cockpit only knows
 *  how to spell GitHub issue URLs. Mirrors the server's `parseRemote` (`src/server/forge/index.ts`),
 *  duplicated rather than imported because that module is server-only. */
export function githubRepoBase(remote: string | undefined): string | undefined {
  if (!remote) return undefined
  const trimmed = remote.trim().replace(/\/+$/, '')
  const url = /^(?:https?|ssh|git|git\+ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(trimmed)
  // scp-like: [user@]host:owner/repo(.git) — a leading '/' (local path) can't match the host group.
  const scp = url ? null : /^(?:[^@/:]+@)?([^:/]+):(.+)$/.exec(trimmed)
  const match = url ?? scp
  if (!match) return undefined
  const [, host, path] = match
  if (!path || host?.toLowerCase() !== 'github.com') return undefined
  const parts = path.replace(/\.git$/i, '').split('/').filter(Boolean)
  const owner = parts[parts.length - 2]
  const repo = parts[parts.length - 1]
  return owner && repo ? `https://github.com/${owner}/${repo}` : undefined
}
