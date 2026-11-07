import { z } from 'zod';
import type { GithubMergeRequirements } from './github-merge-requirements.ts';
import type { ForgeMergeMethod, ForgePrCheck, ForgePrMergeState } from './types.ts';

const mergeCheckSchema = z.object({
  name: z.string().optional(),
  context: z.string().optional(),
  targetUrl: z.string().nullish(),
  state: z.string().nullish(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  detailsUrl: z.string().nullish(),
});
export const mergePrSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  mergedAt: z.unknown().optional(),
  isDraft: z.boolean().default(false),
  headRefName: z.string(),
  baseRefName: z.string(),
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/),
  mergeable: z.string().nullish(),
  mergeStateStatus: z.string().nullish(),
  reviewDecision: z.string().nullish(),
  statusCheckRollup: z.array(mergeCheckSchema).nullish(),
});
const repoMergePolicySchema = z.object({
  allow_merge_commit: z.boolean().default(false),
  allow_squash_merge: z.boolean().default(false),
  allow_rebase_merge: z.boolean().default(false),
  merge_commit_title: z.string().nullish(),
  squash_merge_commit_title: z.string().nullish(),
});

function mergeCheckState(check: z.infer<typeof mergeCheckSchema>): ForgePrCheck['state'] {
  const value = (check.conclusion || check.state || check.status || '').toUpperCase();
  if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(value)) return 'passing';
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'CANCELLED'].includes(value)) return 'failing';
  if (['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', 'WAITING', 'REQUESTED'].includes(value)) return 'pending';
  return 'unknown';
}

export function normalizeMergeState(
  raw: unknown,
  policyRaw: unknown,
  requirements: GithubMergeRequirements = {
    readable: false,
    requiredChecks: [],
  },
): ForgePrMergeState {
  const pr = mergePrSchema.parse(raw);
  const policy = repoMergePolicySchema.parse(policyRaw);
  const state: ForgePrMergeState['state'] =
    pr.state.toUpperCase() === 'MERGED' ? 'merged' : pr.state.toUpperCase() === 'CLOSED' ? 'closed' : 'open';
  const mergeable: ForgePrMergeState['mergeable'] =
    pr.mergeable?.toUpperCase() === 'MERGEABLE'
      ? 'mergeable'
      : pr.mergeable?.toUpperCase() === 'CONFLICTING'
        ? 'conflicting'
        : 'unknown';
  const reviewDecision: ForgePrMergeState['reviewDecision'] =
    pr.reviewDecision?.toUpperCase() === 'APPROVED'
      ? 'approved'
      : pr.reviewDecision?.toUpperCase() === 'CHANGES_REQUESTED'
        ? 'changes-requested'
        : pr.reviewDecision?.toUpperCase() === 'REVIEW_REQUIRED'
          ? 'review-required'
          : !pr.reviewDecision?.trim() && requirements.readable && requirements.requiredApprovingReviews === 0
            ? 'not-required'
            : 'unknown';
  const checks: ForgePrCheck[] = (pr.statusCheckRollup ?? []).map((check) => {
    const name = check.name ?? check.context ?? 'Check';
    const url = check.detailsUrl ?? check.targetUrl;
    return {
      name,
      state: mergeCheckState(check),
      required: requirements.readable ? requirements.requiredChecks.includes(name) : null,
      ...(url?.startsWith('https://') || url?.startsWith('http://') ? { url } : {}),
    };
  });
  if (requirements.readable) {
    for (const name of requirements.requiredChecks) {
      if (!checks.some((check) => check.name === name)) checks.push({ name, state: 'pending', required: true });
    }
  }
  const methods: ForgeMergeMethod[] = [];
  const methodAllowed = (method: ForgeMergeMethod) => requirements.allowedMergeMethods?.includes(method) ?? true;
  if (policy.allow_squash_merge && methodAllowed('squash')) methods.push('squash');
  if (policy.allow_merge_commit && methodAllowed('merge')) methods.push('merge');
  if (policy.allow_rebase_merge && methodAllowed('rebase')) methods.push('rebase');
  const defaultMethod =
    policy.squash_merge_commit_title && methods.includes('squash')
      ? 'squash'
      : policy.merge_commit_title && methods.includes('merge')
        ? 'merge'
        : methods[0] ?? null;
  const blockers: ForgePrMergeState['blockers'] = [];
  let eligibility: ForgePrMergeState['eligibility'] = 'ready';
  if (state !== 'open') {
    eligibility = 'terminal';
    blockers.push({ code: 'terminal', message: state === 'merged' ? 'This pull request is merged.' : 'This pull request is closed.' });
  } else if (pr.isDraft) {
    eligibility = 'blocked';
    blockers.push({ code: 'draft', message: 'Mark the pull request ready for review before merging.' });
  } else if (mergeable === 'conflicting') {
    eligibility = 'blocked';
    blockers.push({ code: 'conflicts', message: 'Conflicts must be resolved before merging.' });
  } else if (checks.some((check) => check.state === 'failing')) {
    eligibility = 'blocked';
    blockers.push({ code: 'checks-failing', message: 'One or more checks are failing.' });
  } else if (reviewDecision === 'changes-requested' || reviewDecision === 'review-required') {
    eligibility = 'blocked';
    blockers.push({ code: 'reviews', message: reviewDecision === 'changes-requested' ? 'Changes were requested.' : 'A required review is missing.' });
  } else if ((requirements.unresolvedThreads ?? 0) > 0) {
    eligibility = 'blocked';
    blockers.push({ code: 'review-threads', message: 'Required review threads must be resolved before merging.' });
  } else if (
    reviewDecision === 'unknown' || !requirements.readable ||
    (requirements.requiresThreadResolution && requirements.unresolvedThreads == null) ||
    checks.some((check) => check.required === true && check.state === 'unknown')
  ) {
    eligibility = 'unknown';
    blockers.push({
      code: 'rules-unknown',
      message: 'GitHub could not confirm review and branch-protection requirements.',
    });
  } else if (checks.some((check) => check.state === 'pending') || pr.mergeStateStatus?.toUpperCase() === 'UNSTABLE') {
    eligibility = 'pending';
    blockers.push({ code: 'pending', message: 'Checks or GitHub mergeability are still pending.' });
  // GitHub's aggregate still enforces other rules and required check provider identities.
  } else if (
    mergeable !== 'mergeable' ||
    !['CLEAN', 'HAS_HOOKS'].includes(pr.mergeStateStatus?.toUpperCase() ?? '') ||
    methods.length === 0
  ) {
    eligibility = 'unknown';
    blockers.push({ code: 'unknown', message: 'GitHub could not confirm every merge requirement.' });
  }
  const canMerge = eligibility === 'ready';
  const canOverride =
    !canMerge &&
    state === 'open' &&
    !pr.isDraft &&
    mergeable !== 'conflicting' &&
    methods.length > 0;
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state,
    isDraft: pr.isDraft,
    headRef: pr.headRefName,
    baseRef: pr.baseRefName,
    headSha: pr.headRefOid,
    mergeable,
    reviewDecision,
    checks,
    methods,
    defaultMethod,
    eligibility,
    blockers,
    canMerge,
    canOverride,
  };
}
