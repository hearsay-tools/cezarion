# Reclassify branches before atomic deletion

Branch cleanup uses one server classifier and reclassifies at delete time. Active and
non-task branches are protected. Merged or empty task branches can be removed in bulk;
not-landed or orphan work requires one branch and its typed name. The classifier is policy,
not a promise that every permitted deletion preserves unlanded commits.

## Consequences

Hold the worktree mutation lock and task cleanup claims while checking current checkout
and owned-receipt protection. Each ref transaction verifies both base and tip against the
classification snapshot. If an empty branch depends on another ref retaining its commits,
that ref must be outside the deletion request; two requested branches cannot vouch for each
other and both disappear.

Forge failure degrades classification to ancestry evidence with unknown PR state. The browser
renders that result and cannot grant itself a safer classification.

## Considered Options

- **Trust the earlier client verdict.** Rejected because checkout, base, branch tip and ownership can change before deletion.
- **Verify only the deleted tip.** Rejected because a base reset can invalidate the conclusion that work is already retained.

Implementation: [repo-branches.ts](../../packages/cezar/src/server/repo-branches.ts).

Coverage: [repo-branches.test.ts](../../packages/cezar/src/server/repo-branches.test.ts).
