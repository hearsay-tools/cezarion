import { z } from 'zod';

/** Internal discovery result, shared by the panel and the fresh merge preflight. */
const requirementsSchema = z.object({
  readable: z.boolean(),
  requiredChecks: z.array(z.string()),
  requiredApprovingReviews: z.number().int().nonnegative().nullable().optional(),
  requiresThreadResolution: z.boolean().optional(),
  unresolvedThreads: z.number().int().nonnegative().nullable().optional(),
  allowedMergeMethods: z.array(z.enum(['merge', 'squash', 'rebase'])).optional(),
});
export type GithubMergeRequirements = z.infer<typeof requirementsSchema>;

const ruleSchema = z.object({ type: z.string(), parameters: z.unknown().optional() });
const reviewRuleSchema = z.object({
  required_approving_review_count: z.number().int().nonnegative(),
  require_code_owner_review: z.boolean(),
  require_last_push_approval: z.boolean(),
  required_review_thread_resolution: z.boolean(),
  required_reviewers: z.array(z.object({ minimum_approvals: z.number().int().nonnegative() })).optional(),
  allowed_merge_methods: z.array(z.enum(['merge', 'squash', 'rebase'])).optional(),
});
const checkRuleSchema = z.object({
  required_status_checks: z.array(z.object({ context: z.string().min(1) })),
});
const branchSchema = z.object({
  protected: z.boolean(),
  protection: z.object({ enabled: z.boolean() }).optional(),
});
const protectionSchema = z.object({
  required_status_checks: z.object({
    contexts: z.array(z.string().min(1)).optional(),
    checks: z.array(z.object({ context: z.string().min(1) })).optional(),
  }).refine((value) => value.contexts !== undefined || value.checks !== undefined).nullish(),
  required_pull_request_reviews: z.object({
    required_approving_review_count: z.number().int().nonnegative(),
    require_code_owner_reviews: z.boolean(),
    require_last_push_approval: z.boolean(),
  }).nullish(),
  required_conversation_resolution: z.object({ enabled: z.boolean() }),
});
const threadsPageSchema = z.object({
  data: z.object({ repository: z.object({ pullRequest: z.object({ reviewThreads: z.object({
    nodes: z.array(z.object({ isResolved: z.boolean() })),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  }) }) }) }),
  // GraphQL can return partial data together with errors; it is not confirmation.
  errors: z.array(z.unknown()).max(0).optional(),
});
type GithubRunner = (args: string[]) => Promise<string>;

/** A capped/incomplete read stays unknown; outdated threads still require resolution. */
async function unresolvedThreads(run: GithubRunner, owner: string, repo: string, number: number): Promise<number | null> {
  const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String) {
    repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
      reviewThreads(first:100,after:$cursor) {
        nodes { isResolved } pageInfo { hasNextPage endCursor }
      }
    } }
  }`;
  let cursor: string | null = null;
  const seen = new Set<string>();
  try {
    for (let page = 0; page < 10; page++) {
      const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `repo=${repo}`, '-F', `number=${number}`];
      if (cursor !== null) args.push('-f', `cursor=${cursor}`);
      const { nodes, pageInfo } = threadsPageSchema.parse(JSON.parse(await run(args))).data.repository.pullRequest.reviewThreads;
      const open = nodes.filter((thread) => !thread.isResolved).length;
      if (open > 0) return open;
      if (!pageInfo.hasNextPage) return 0;
      if (!pageInfo.endCursor || seen.has(pageInfo.endCursor)) return null;
      cursor = pageInfo.endCursor;
      seen.add(cursor);
    }
  } catch { /* Read failures do not establish resolution. */ }
  return null;
}

export async function fetchGithubMergeRequirements(
  run: GithubRunner,
  owner: string,
  repo: string,
  branch: string,
  number: number,
): Promise<GithubMergeRequirements> {
  const unknown: GithubMergeRequirements = { readable: false, requiredChecks: [] };
  const base = `repos/${owner}/${repo}`;
  const branchPath = `${base}/branches/${encodeURIComponent(branch)}`;
  try {
    const [rulesOut, branchOut] = await Promise.all([
      run(['api', `${base}/rules/branches/${encodeURIComponent(branch)}?per_page=100`, '--paginate', '--slurp']),
      run(['api', branchPath]).catch(() => null),
    ]);
    // Keep all pages, including an explicitly empty rules list. A failed rules read
    // never falls back to assuming legacy protection is the complete policy.
    const rules = z.array(z.array(ruleSchema)).min(1).parse(JSON.parse(rulesOut)).flat();
    const branchState = branchOut === null ? null : branchSchema.parse(JSON.parse(branchOut));
    const legacyAbsent = branchState !== null && (
      branchState.protection?.enabled === false ||
      (!branchState.protected && branchState.protection?.enabled !== true)
    );
    // A protection-endpoint 404 can hide permissions. Only the branch's readable
    // legacy-disabled/unprotected metadata confirms absence, never that 404 alone.
    const legacy = legacyAbsent ? null : protectionSchema.parse(JSON.parse(await run(['api', `${branchPath}/protection`])));
    const checks = new Set<string>();
    let approvals = 0;
    let resolveThreads = false;
    let methods: NonNullable<GithubMergeRequirements['allowedMergeMethods']> = ['merge', 'squash', 'rebase'];
    for (const rule of rules) {
      if (rule.type === 'required_status_checks') {
        for (const check of checkRuleSchema.parse(rule.parameters).required_status_checks) checks.add(check.context);
      } else if (rule.type === 'pull_request') {
        const review = reviewRuleSchema.parse(rule.parameters);
        approvals = Math.max(approvals, review.required_approving_review_count,
          review.require_code_owner_review || review.require_last_push_approval || review.required_reviewers?.some((group) => group.minimum_approvals > 0) ? 1 : 0);
        resolveThreads ||= review.required_review_thread_resolution;
        const allowed = review.allowed_merge_methods;
        if (allowed) methods = methods.filter((method) => allowed.includes(method));
      }
    }
    if (legacy) {
      for (const context of legacy.required_status_checks?.contexts ?? []) checks.add(context);
      for (const check of legacy.required_status_checks?.checks ?? []) checks.add(check.context);
      const review = legacy.required_pull_request_reviews;
      if (review) approvals = Math.max(approvals, review.required_approving_review_count,
        review.require_code_owner_reviews || review.require_last_push_approval ? 1 : 0);
      resolveThreads ||= legacy.required_conversation_resolution.enabled;
    }
    return {
      readable: true,
      requiredChecks: [...checks],
      requiredApprovingReviews: approvals,
      requiresThreadResolution: resolveThreads,
      unresolvedThreads: resolveThreads ? await unresolvedThreads(run, owner, repo, number) : 0,
      allowedMergeMethods: methods,
    };
  } catch {
    return unknown;
  }
}
