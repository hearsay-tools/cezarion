# Merge recommendations implementation plan

> **For agentic workers:** Use superpowers:executing-plans for inline implementation.

**Goal:** Ship the approved passive recommendation trial, with a paused automation.
**Architecture:** Pure policy, bounded GitHub/Git collector, deterministic publisher;
two separate agent steps use one repository skill. Durable state lives in one GitHub
issue and authored PR comments. No service or HTTP changes.
**Tech stack:** Node 24 CommonJS scripts, node:test, existing gh and cezar commands.
**Spec:** `.ai/specs/2026-10-19-merge-recommendations.md` (approved chat design).

## Global constraints

- At most five files and 150 additions/deletions; no agent waiver.
- Only ordinary factual Markdown corrections and additive tests initially.
- Complete pinned evidence; current required checks and review state.
- No merges, review approvals, label changes or automatic enablement.
- One comment per PR and one shared issue; no manual calibration workload.
- Work in the existing cezar worktree; dependencies are already installed.

## Review focus

- Small instruction/coverage changes must be excluded despite green CI.
- Changed PR heads/bases must invalidate positive assessments.
- Missing pages, patches, rules or check provenance must fail closed.
- Forged markers and concurrent publishers must not corrupt reporting.
- Repeated runs and partial failures must not inflate cohort counts.

## Task 1: Policy and decision validation

Files: `.github/scripts/merge-recommendation-policy.cjs` and its `.test.cjs`.
Interface: `gate(snapshot)`, `validateAssessment(snapshot, value)`,
`decide(snapshot, assessor, challenger)`, `snapshotKey(snapshot)`.

- [x] Write failing tests for caps, allowed changes, evidence, provenance and stale decisions.
- [x] Observe failures through Squeal, implement gates and validated semantic outputs.
- [x] Require passing focused results and record red/green evidence.

## Task 2: Collection and publication

Files: `.github/scripts/merge-recommendation-github.cjs`,
`.github/scripts/merge-recommendation-report.cjs`,
`.github/scripts/merge-recommendation.cjs` and corresponding tests.
Interfaces: bounded `Gh` adapter; `collectSnapshot`, `readPinnedDiff`;
`publishBatch`, report rendering and retained-cohort state.

- [x] Test complete pinned diffs with real Git and fake only GitHub I/O.
- [x] Test stale publication, untrusted markers, idempotence, partial writes and locking.
- [x] Observe red, implement collector/CLI/publisher, verify green through Squeal.

## Task 3: Skill, automation and rollout

Files: `.ai/skills/recommending-pr-merges/SKILL.md`, the CLI-generated automation definition,
`docs/sdlc/merge-recommendations.md`.

- [x] Run governed baseline pressure scenarios before writing the skill.
- [x] Write the concise skill and six-hour automation with separate assessor/challenger steps.
- [x] Pressure-test with skill; inspect every disagreement and retain evidence.
- [x] Create the shared trial issue, install automation paused, report its next scheduled slot.
- [x] Exercise live read-only collection/report preview; no unrelated PR writes.
- [ ] Commit, obtain governed whole-branch review, fix material findings, and open draft PR.
- [ ] Collect/destroy owned workers, check affected Squeal results and CI state, update handoff.

Ruling: the user's “Go ahead” approves the design and implementation; no additional
plan-approval round. Inline execution keeps the shared interfaces in one context;
governed workers provide skill pressure tests and final independent review.

Ruling: generate the automation definition from the CLI instead of keeping a second
tracked JSON definition. It is installed paused as 4a63adfe-d4bc-452c-a357-9882eefd1c81.
Summary: hearsay-tools/cezarion#1302. No next run is armed while paused; its slots are
00:00, 06:00, 12:00 and 18:00 in the cockpit time zone.

Verification: focused Squeal verdict at revision 15 passes all four new suites.
The size-limit test failed with both caps removed (revision 14), then passed after
restoring them (revision 15). Attribute-pinning and push-during-comment-pagination
tests also observed red before their fixes. Nine live PR reports previewed with no
GitHub PR writes; policy explicitly untrusted before installation. No full local
suite run; 78 slow files were not current.
