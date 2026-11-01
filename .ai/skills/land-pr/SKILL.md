---
name: land-pr
description: Land a reviewed pull request or check its landing gate. Use for one PR or from a campaign to verify the current head, merge authority, CI and review before merging or waiting for the owner.
---

# Land a pull request

Take a reviewed PR to an observed merge, or return the exact blocker. Calling
this skill supplies no merge authority. The caller owns implementation,
substantive review and acceptance of the integrated result.

## 1. Establish the input

Read the PR, current head `H`, base branch and approved scope. Require the
reviewed head, review findings and verification evidence from the caller. For a
standalone request without that review, perform the repo's code-review workflow
first. Establish merge authority from the user's instructions; absent permission,
prepare the gate and hand it to the owner.
When asked only to check readiness, return the gate result without merging,
even when a separate merge grant exists. Report pending checks without opening
a wait unless the caller asked for monitoring.

For automatic eligibility, use [auto-merge](../auto-merge/SKILL.md). It owns
that policy. A campaign's explicit owner-merge control keeps the owner gate;
its broader merge grant does not make an otherwise ineligible PR auto-eligible.

Done when the PR, approved scope, reviewed head and authority are known. A
missing input returns a named blocker to the caller.

## 2. Check the gate at H

Fetch `origin`. Inspect the PR's commits, full diff, checks and review state.
Each item must hold at the same current head:

1. **Scope:** files, names and exports match the approved plan. Every addition
   to scope is justified and approved. The caller's work-type review covers
   every commit through `H`, with findings resolved.
2. **Freshness:** `H` equals the reviewed head. After a rebase, compare the old
   and new patches. Cleanup may retain its review for unchanged bodies with
   only understood import/baseline adjustments, after reading those adjustments;
   record the review at the new head. Semantic edits need renewed review and
   affected verification. Even an unchanged patch needs a base-compatibility check.
3. **Dependencies:** the caller's required integrated prerequisites hold on
   fetched main. Inspect semantic overlap as well as textual conflicts.
4. **CI:** every required check passes on `H`; an absent or pending required
   result is not a pass. Read failures before classifying them. A flake needs
   its tracking issue and still needs a passing required check.
5. **Review and QA:** the required automated review check passes on `H` under
   [the repo's review policy](../../../docs/sdlc/ci.md#ci-verification).
   Accept an intentional skipped review only with the trusted classification
   and documented exemption that allow it; a missing or failed review is no
   exemption. A caller requiring actual model execution still needs that
   evidence. Zero threads remain open, and `needs-qa` has `qa-approved` when
   present. Follow the repo's review-round rules for new heads and pushback.
6. **Owner paths:** run `node .ai/skills/auto-merge/check.mjs --title '<title>'`
   against the PR's committed head in its checkout (quote the actual title with
   `shellQuote`). A "gate or test harness" result or an `AGENTS.md` edit needs
   explicit owner approval even within a campaign merge grant. Apply any
   stricter repo or user rule too. A nonqualifying result alone neither grants
   nor removes explicit manual merge authority.
7. **Body:** the delivery workflow's required sections and command/result
   evidence match the diff. Use closing keywords only for fully completed
   issues; partial work references the issue without closing it. Add any
   owner-approved gate labels before the first push that needs them.
8. **Main:** main CI passes. A failure confined to Publish npm snapshot does
   not block a code merge; other failures wait for the named repair task.

Required checks here are not strict about an advancing base. Use
`git merge-tree origin/main H` with the actual head ref to check conflicts.
A clean result and no semantic overlap allow landing without a rebase.
A conflict or invalidated contract returns to the implementation owner.

Done when every item holds at `H`, with any owner approval recorded. Return
`ready` for a check-only request, `blocked` with the failed item and next action,
or `awaiting-checks` with the pending results. For a check-only request, open a
PR wait only when the caller also asked for monitoring; a landing request
includes waiting for its required checks. A changed head invalidates the gate.

## 3. Merge or wait

`pr-readiness.yml` owns draft state. Let it mark the PR ready; do not run
`gh pr ready`. When the gate holds but owner action is required, send the
owner the PR, `H`, gate evidence and the specific missing approval. Register
a PR merge wait, or use `cezar_ask` when an explicit decision is needed.

With authority and a ready PR, re-read the head and state immediately before
merging. Keep the PR title as the squash subject:

```bash
gh pr merge <P> --squash --match-head-commit <H>
```

A rejected merge returns its reason; do not broaden permissions or bypass a
rule. On a head change, return to review. On pending checks, use the wait rule
in step 2; a check-only request has already returned its gate result there.
Observe GitHub's merged state and resulting commit; command acceptance or
green checks alone do not establish a merge.

Done when the result records PR, reviewed head, merged head, merge SHA and
issue status. Otherwise return `awaiting-owner`, `awaiting-checks`, `blocked`,
or `closed-unmerged`, with the head, reason and next actor. The caller records
the result and verifies integrated acceptance before closing its work.
