import { runPullRequestSchema, type ArchivePullRequestIdentity } from '@open-mercato/cezar-contract/runs';
import type { RunPullRequest, RunSummary } from '@open-mercato/cezar-contract';

/** Compare repository identities rather than URL formatting or reference numbers alone. */
function repository(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}${parsed.pathname.split('/').slice(0, 3).join('/')}`.toLowerCase();
}

/** Stable, immutable union. Numeric declarations belong to the project only when it is known. */
export function mergePullRequests(
  current: readonly RunPullRequest[] | undefined,
  incoming: readonly RunPullRequest[],
  repoBase?: string,
): RunPullRequest[] {
  const own = repoBase ? repository(repoBase) : undefined;
  const result: RunPullRequest[] = [];
  const identity = (entry: RunPullRequest) =>
    `${entry.url ? repository(entry.url) : own ?? 'unscoped'}:${entry.number}`;
  for (const entry of [...(current ?? []), ...incoming]) {
    const index = result.findIndex((previous) => identity(previous) === identity(entry));
    if (index < 0) result.push({ ...entry });
    else {
      const previous = result[index]!;
      result[index] = {
        ...previous,
        ...(previous.url === undefined && entry.url !== undefined ? { url: entry.url } : {}),
        source: previous.source === 'created' || entry.source === 'created' ? 'created' : 'declared',
      };
    }
  }
  return result;
}

/** Cache invalidation is project-scoped; foreign links never address the local number. */
export function ownPullRequestNumbers(
  run: Pick<RunSummary, 'pullRequests' | 'pullRequestUrl' | 'referencedPullRequestUrl' | 'prNumber' | 'markerRefs'>,
  repoBase?: string,
): number[] {
  const own = repoBase ? repository(repoBase) : undefined;
  const legacyUrls = [run.pullRequestUrl, run.referencedPullRequestUrl].filter((url): url is string => url !== undefined);
  const entries: RunPullRequest[] = [...(run.pullRequests ?? [])];
  for (const url of legacyUrls) {
    const number = Number(/\/pull\/(\d+)/i.exec(url)?.[1]);
    if (Number.isInteger(number) && number > 0) entries.push({ number, url, source: 'created' });
  }
  for (const number of [run.prNumber, run.markerRefs?.pr]) {
    if (number === undefined || legacyUrls.some(url => Number(/\/pull\/(\d+)/i.exec(url)?.[1]) === number)) continue;
    entries.push({ number, source: 'declared' });
  }
  return [...new Set(entries.filter(entry => {
    if (!entry.url) return true;
    try { return own !== undefined && repository(entry.url) === own; } catch { return false; }
  }).map(entry => entry.number))];
}

/** Fail closed over the COMPLETE collection, including unresolved or malformed members. */
export function archivePullRequests(
  family: readonly { pullRequests?: unknown; pullRequestUrl?: string | undefined; referencedPullRequestUrl?: string | undefined; prNumber?: number | undefined }[],
  repoBase?: string,
): ArchivePullRequestIdentity[] | undefined {
  const own = repoBase ? githubIdentity(`${repoBase.replace(/\/$/, '')}/pull/1`) : undefined;
  const result = new Map<string, ArchivePullRequestIdentity>();
  for (const run of family) {
    if (run.pullRequests !== undefined) {
      if (!Array.isArray(run.pullRequests)) return undefined;
      for (const raw of run.pullRequests) {
        const parsed = runPullRequestSchema.safeParse(raw);
        if (!parsed.success) return undefined;
        const entry = parsed.data;
        const identity = entry.url ? githubIdentity(entry.url) : own ? { ...own, number: entry.number } : undefined;
        if (!identity || identity.number !== entry.number) return undefined;
        result.set(pullRequestKey(identity), identity);
      }
    } else if (run.pullRequestUrl !== undefined) {
      const identity = githubIdentity(run.pullRequestUrl);
      if (!identity || !own || identity.owner !== own.owner || identity.repo !== own.repo) return undefined;
      result.set(pullRequestKey(identity), identity);
    }
  }
  return result.size ? [...result].sort(([a], [b]) => a.localeCompare(b)).map(([, identity]) => identity) : undefined;
}

export function pullRequestKey(identity: ArchivePullRequestIdentity): string {
  return `${identity.owner.toLowerCase()}/${identity.repo.toLowerCase()}#${identity.number}`;
}

function githubIdentity(value: string): ArchivePullRequestIdentity | undefined {
  try {
    const url = new URL(value);
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/.exec(url.pathname);
    if (!match || url.hostname.toLowerCase() !== 'github.com' || url.port || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return undefined;
    return { owner: match[1]!.toLowerCase(), repo: match[2]!.toLowerCase(), number: Number(match[3]) };
  } catch { return undefined; }
}
