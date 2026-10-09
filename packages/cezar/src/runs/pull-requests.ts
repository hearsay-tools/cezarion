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
