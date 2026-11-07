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

type MergeCheck = z.infer<typeof mergeCheckSchema>;
type MergePr = z.infer<typeof mergePrSchema>;
type MergePolicy = z.infer<typeof repoMergePolicySchema>;
type MergeEligibility = {
  eligibility: ForgePrMergeState['eligibility'];
  blockers: ForgePrMergeState['blockers'];
};
type MergeEligibilityInput = {
  state: ForgePrMergeState['state'];
  isDraft: boolean;
  mergeable: ForgePrMergeState['mergeable'];
  mergeStateStatus: string | null | undefined;
  checks: ForgePrCheck[];
  reviewDecision: ForgePrMergeState['reviewDecision'];
  requirements: GithubMergeRequirements;
  methods: ForgeMergeMethod[];
};

function mergeCheckState(check: MergeCheck): ForgePrCheck['state'] {
  const value = (check.conclusion || check.state || check.status || '').toUpperCase();
  if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(value)) return 'passing';
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'CANCELLED'].includes(value)) return 'failing';
  if (['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', 'WAITING', 'REQUESTED'].includes(value)) return 'pending';
  return 'unknown';
}

function mergePrLifecycleState(pr: MergePr): ForgePrMergeState['state'] {
  return pr.state.toUpperCase() === 'MERGED' ? 'merged' : pr.state.toUpperCase() === 'CLOSED' ? 'closed' : 'open';
}

function mergePrMergeable(pr: MergePr): ForgePrMergeState['mergeable'] {
  return pr.mergeable?.toUpperCase() === 'MERGEABLE'
    ? 'mergeable'
    : pr.mergeable?.toUpperCase() === 'CONFLICTING'
      ? 'conflicting'
      : 'unknown';
}

function mergePrReviewDecision(
  pr: MergePr,
  requirements: GithubMergeRequirements,
): ForgePrMergeState['reviewDecision'] {
  return pr.reviewDecision?.toUpperCase() === 'APPROVED'
    ? 'approved'
    : pr.reviewDecision?.toUpperCase() === 'CHANGES_REQUESTED'
      ? 'changes-requested'
      : pr.reviewDecision?.toUpperCase() === 'REVIEW_REQUIRED'
        ? 'review-required'
        : !pr.reviewDecision?.trim() && requirements.readable && requirements.requiredApprovingReviews === 0
          ? 'not-required'
          : 'unknown';
}

function mergePrCheckRow(check: MergeCheck, requirements: GithubMergeRequirements): ForgePrCheck {
  const name = check.name ?? check.context ?? 'Check';
  const url = check.detailsUrl ?? check.targetUrl;
  return {
    name,
    state: mergeCheckState(check),
    required: requirements.readable ? requirements.requiredChecks.includes(name) : null,
    ...(url?.startsWith('https://') || url?.startsWith('http://') ? { url } : {}),
  };
}

function mergePrChecks(pr: MergePr, requirements: GithubMergeRequirements): ForgePrCheck[] {
  const checks: ForgePrCheck[] = (pr.statusCheckRollup ?? []).map((check) => mergePrCheckRow(check, requirements));
  if (requirements.readable) {
    for (const name of requirements.requiredChecks) {
      if (!checks.some((check) => check.name === name)) checks.push({ name, state: 'pending', required: true });
    }
  }
  return checks;
}

function mergeMethodAllowed(requirements: GithubMergeRequirements, method: ForgeMergeMethod): boolean {
  return requirements.allowedMergeMethods?.includes(method) ?? true;
}

function mergePrMethods(
  policy: MergePolicy,
  requirements: GithubMergeRequirements,
): { methods: ForgeMergeMethod[]; defaultMethod: ForgePrMergeState['defaultMethod'] } {
  const methods: ForgeMergeMethod[] = [];
  if (policy.allow_squash_merge && mergeMethodAllowed(requirements, 'squash')) methods.push('squash');
  if (policy.allow_merge_commit && mergeMethodAllowed(requirements, 'merge')) methods.push('merge');
  if (policy.allow_rebase_merge && mergeMethodAllowed(requirements, 'rebase')) methods.push('rebase');
  const defaultMethod =
    policy.squash_merge_commit_title && methods.includes('squash')
      ? 'squash'
      : policy.merge_commit_title && methods.includes('merge')
        ? 'merge'
        : methods[0] ?? null;
  return { methods, defaultMethod };
}

function mergePrTerminalBlocker(input: MergeEligibilityInput): MergeEligibility | null {
  if (input.state === 'open') return null;
  return {
    eligibility: 'terminal',
    blockers: [{
      code: 'terminal',
      message: input.state === 'merged' ? 'This pull request is merged.' : 'This pull request is closed.',
    }],
  };
}

function mergePrDraftBlocker(input: MergeEligibilityInput): MergeEligibility | null {
  if (!input.isDraft) return null;
  return {
    eligibility: 'blocked',
    blockers: [{ code: 'draft', message: 'Mark the pull request ready for review before merging.' }],
  };
}

function mergePrConflictsBlocker(input: MergeEligibilityInput): MergeEligibility | null {
  if (input.mergeable !== 'conflicting') return null;
  return {
    eligibility: 'blocked',
    blockers: [{ code: 'conflicts', message: 'Conflicts must be resolved before merging.' }],
  };
}

function mergePrChecksFailingBlocker(input: MergeEligibilityInput): MergeEligibility | null {
  if (!input.checks.some((check) => check.state === 'failing')) return null;
  return {
    eligibility: 'blocked',
    blockers: [{ code: 'checks-failing', message: 'One or more checks are failing.' }],
  };
}

function mergePrReviewsBlocker(input: MergeEligibilityInput): MergeEligibility | null {
  if (input.reviewDecision !== 'changes-requested' && input.reviewDecision !== 'review-required') return null;
  return {
    eligibility: 'blocked',
    blockers: [{
      code: 'reviews',
      message: input.reviewDecision === 'changes-requested' ? 'Changes were requested.' : 'A required review is missing.',
    }],
  };
}

function mergePrReviewThreadsBlocker(input: MergeEligibilityInput): MergeEligibility | null {
  if ((input.requirements.unresolvedThreads ?? 0) <= 0) return null;
  return {
    eligibility: 'blocked',
    blockers: [{ code: 'review-threads', message: 'Required review threads must be resolved before merging.' }],
  };
}

function mergePrRulesUnknownBlocker(input: MergeEligibilityInput): MergeEligibility | null {
  if (
    input.reviewDecision !== 'unknown' && input.requirements.readable &&
    !(input.requirements.requiresThreadResolution && input.requirements.unresolvedThreads == null) &&
    !input.checks.some((check) => check.required === true && check.state === 'unknown')
  ) return null;
  return {
    eligibility: 'unknown',
    blockers: [{
      code: 'rules-unknown',
      message: 'GitHub could not confirm review and branch-protection requirements.',
    }],
  };
}

function mergePrPendingBlocker(input: MergeEligibilityInput): MergeEligibility | null {
  if (!input.checks.some((check) => check.state === 'pending') && input.mergeStateStatus?.toUpperCase() !== 'UNSTABLE') {
    return null;
  }
  return {
    eligibility: 'pending',
    blockers: [{ code: 'pending', message: 'Checks or GitHub mergeability are still pending.' }],
  };
}

function mergePrUnknownBlocker(input: MergeEligibilityInput): MergeEligibility | null {
  // GitHub's aggregate still enforces other rules and required check provider identities.
  if (
    input.mergeable === 'mergeable' &&
    ['CLEAN', 'HAS_HOOKS'].includes(input.mergeStateStatus?.toUpperCase() ?? '') &&
    input.methods.length > 0
  ) return null;
  return {
    eligibility: 'unknown',
    blockers: [{ code: 'unknown', message: 'GitHub could not confirm every merge requirement.' }],
  };
}

function mergePrEligibility(input: MergeEligibilityInput): MergeEligibility {
  return mergePrTerminalBlocker(input)
    ?? mergePrDraftBlocker(input)
    ?? mergePrConflictsBlocker(input)
    ?? mergePrChecksFailingBlocker(input)
    ?? mergePrReviewsBlocker(input)
    ?? mergePrReviewThreadsBlocker(input)
    ?? mergePrRulesUnknownBlocker(input)
    ?? mergePrPendingBlocker(input)
    ?? mergePrUnknownBlocker(input)
    ?? { eligibility: 'ready', blockers: [] };
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
  const state = mergePrLifecycleState(pr);
  const mergeable = mergePrMergeable(pr);
  const reviewDecision = mergePrReviewDecision(pr, requirements);
  const checks = mergePrChecks(pr, requirements);
  const { methods, defaultMethod } = mergePrMethods(policy, requirements);
  const { eligibility, blockers } = mergePrEligibility({
    state,
    isDraft: pr.isDraft,
    mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    checks,
    reviewDecision,
    requirements,
    methods,
  });
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
