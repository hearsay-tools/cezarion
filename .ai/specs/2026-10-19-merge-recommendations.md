# Recommendation-only PR merge trial

The owner approved a passive trial: assess PRs, maintain one comment per PR and
one shared GitHub issue, with no manual labeling exercise. Nothing merges,
approves reviews, resolves threads, changes labels or enables automations.

The initial policy admits ordinary factual Markdown documentation corrections
and additive tests preserving approved behavior. A PR has one purpose, at most
five changed files and 150 additions plus deletions in total. Tests and generated
content count. Runtime changes, refactors, dependencies, CI/coverage settings,
agent instructions and policy changes require human review. File allowlists are
necessary, never sufficient: two independent assessments must establish semantic
scope, existing intent and evidence for every changed file.

Deterministic gates require the complete pinned diff, regular files, no renames
or deletions, current required checks from their configured GitHub Apps, resolved
review threads, a mergeable non-draft same-repository PR into the default branch,
and an unchanged head/base before publication. Unknown evidence cannot recommend.
The trusted scripts and skill come from a default-branch ancestor, never the PR
under assessment. The publisher recomputes gates; model output cannot waive them.

An isolated scheduled task scans at most 25 open PRs every six hours. A fresh
assessor session reads eligible snapshots; a fresh challenger session receives
only positive candidates, without the assessor's rationale. Both emit validated
JSON. The final check step alone publishes comments and updates the summary.
The automation is installed paused. It must remain paused until these files land
on the default branch and the owner explicitly requests enablement.

Every comment states its head/base, policy version, deterministic rule results,
semantic verdicts and summary link. The shared issue retains up to 100 latest PR
records, counts only that retained cohort, shows disagreements and observed PR
states, and clearly identifies incomplete scans. Linked follow-up PRs and reopened
closing issues are warning signals, not proof of error. Merges and model agreement
are never treated as ground truth or automatic promotion criteria.

All GitHub reads and command output have finite bounds; no PR code is executed.
Concurrent local publishers use a common-git-directory lock. Existing comments
and the summary must belong to the authenticated writer and carry exact markers.
GitHub comment/issue writes are not transactional: report partial failure and let
the next scan reconcile from the durable records. No local file is required to
repair state. This is cooperative supervision, not process isolation: ambient
same-user credentials/shell are not restricted by a skill. A future merger needs
separately approved authority and policy; this trial contains no merge operation.

## Verification

Exercise hard limits, disguised policy/verification changes, missing evidence,
stale assessments, check provenance, independent disagreement, forged markers,
idempotent updates, lock cleanup and partial publication with controlled GitHub
responses. Exercise pinned diff collection against real temporary Git repos.
Use Squeal for covered node:test files; do not run a full local suite. Pressure
test the skill before and after authoring with governed cezar workers. Create a
draft PR and leave CI as the full gate. Publish no recommendations on unrelated
PRs before installation; demonstrate a read-only live snapshot and report preview.

## Review corrections

- Resolve the current target branch ref; GitHub PR `base.sha` can be historical.
  Re-read head, live base and readiness after collecting all evidence pages.
- Scheduled evaluators load the skill extracted from the pinned policy commit,
  not the cockpit skill registry. Verify the copied instructions before challenge
  preparation and publication. Keep shared journals operational and rationale-free.
- Reserve new cohort identities in the summary before PR comments. Recover a
  partially published assessment from its authored record even after PR closure.
  GitHub has no atomic read-and-comment transaction; comments identify their exact
  assessed revision, and later scans reconcile changes after the final read.
