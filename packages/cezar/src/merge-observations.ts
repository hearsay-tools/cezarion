import { z } from 'zod';
import { archivePullRequestIdentitySchema, mergedPullRequestSchema, type ArchivePullRequestIdentity, type MergedPullRequest } from '@open-mercato/cezar-contract/runs';
import { archivePullRequests, pullRequestKey } from './runs/pull-requests.ts';

const observationSchema = z.object({
  number: z.number().int().positive(),
  url: z.string(),
  state: z.literal('MERGED'),
  mergedAt: z.string().datetime(),
});

export function matchesGithubPullRequest(expected: ArchivePullRequestIdentity, raw: unknown): boolean {
  if (!archivePullRequestIdentitySchema.safeParse(expected).success) return false;
  const parsed = observationSchema.pick({ number: true, url: true }).safeParse(raw);
  if (!parsed.success || parsed.data.number !== expected.number) return false;
  const actual = archivePullRequests([{ pullRequests: [{ ...parsed.data, source: 'created' }] }]);
  return actual?.length === 1 && pullRequestKey(actual[0]!) === pullRequestKey(expected);
}

/** Only immutable GitHub facts belong here. No glyphs, negative results, CI or eligibility.
 * Process-local and bounded: eviction/restart falls back to the existing background lookup. */
export class MergedPullRequestObservations {
  private readonly entries = new Map<string, MergedPullRequest>();

  constructor(private readonly capacity = 1_000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid observation capacity');
  }

  observe(expected: ArchivePullRequestIdentity, raw: unknown, now = Date.now()): MergedPullRequest | undefined {
    const parsed = observationSchema.safeParse(raw);
    if (!parsed.success || !matchesGithubPullRequest(expected, parsed.data) || Date.parse(parsed.data.mergedAt) > now) return undefined;
    const key = pullRequestKey(expected);
    const fact = this.entries.get(key) ?? Object.freeze(mergedPullRequestSchema.parse({
      owner: expected.owner.toLowerCase(), repo: expected.repo.toLowerCase(), number: expected.number, mergedAt: parsed.data.mergedAt,
    }));
    this.entries.delete(key);
    this.entries.set(key, fact);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    return fact;
  }

  get(identity: ArchivePullRequestIdentity): MergedPullRequest | undefined {
    const key = pullRequestKey(identity);
    const fact = this.entries.get(key);
    if (fact) {
      this.entries.delete(key);
      this.entries.set(key, fact);
    }
    return fact;
  }

  clear(): void { this.entries.clear(); }
}

export const mergedPullRequestObservations = new MergedPullRequestObservations();
