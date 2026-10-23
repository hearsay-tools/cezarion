---
name: check-code-quality
description: Check changed JavaScript and TypeScript functions for complexity and CRAP before opening a pull request. Fix small problems and file inherited refactors as code quality issues.
---

# Check code quality

Run this check after implementation and before opening a PR. Repeat it after a
source or test change that can affect the result. Use the scripts bundled beside
this file; resolve `<skill>` to this directory's absolute path.

## 1. Select changed functions

Resolve the PR's target branch from the task or repository bindings. Fetch its
remote ref, then run from the target repository root:

```sh
node <skill>/scripts/changed-functions.mjs --base <target-ref>
```

The report pins a merge-base and includes committed, staged, unstaged and
untracked JS/TS changes. It lists changed functions and their baseline complexity.
Use its `base` SHA for every baseline comparison. Keep tests and bundled scripts
in scope. Deleted functions need no current score. Record unsupported changed
languages as outside this tool's scope.

Done when every changed function has a file and source position. A failed scan
is an incomplete check. An empty list completes the check for supported code.

## 2. Measure current code

Run once per listed file, then use the listed function names and source positions
to select its results:

```sh
node <skill>/scripts/metrics.mjs <file> --json
```

Use a current Istanbul report with `--coverage <coverage-final.json>`. When
coverage is missing, stale or unmatched, collect fresh coverage for the relevant
tests. Passing tests alone supply no coverage. With Vitest, use repeatable
`--test <test-file>` and, for a multi-project config, `--project <unit-project>`.
Select only the needed unit projects. A coverage run has a ten-minute bound and
uses the target project's installed Vitest and coverage provider. Follow the
repository's test instructions; a coverage run is a distinct measurement even
when background validation already passed.

If setup or coverage fails, read [tool.md](references/tool.md). Report any
unavailable CRAP score as incomplete. Complexity can still be assessed.

Done when every selected function has current complexity and CRAP, or a stated
measurement blocker. CRAP uses function body line coverage, as identified in the
report. Check the source hashes against the scan; rescan after a source change.

## 3. Resolve scores above the limits

Use `thresholds` from the scan report. Flag a function when either score is
**strictly greater** than its limit. Equality passes. For each flagged function,
read its diff and baseline source, then choose an action:

| Finding | Action |
| --- | --- |
| A small change can bring it within the limits | Make the change and verify behavior. Remeasure. |
| This task introduced or worsened the problem | Fix it in this task. If a larger design decision is needed, report the blocker before opening the PR. |
| The problem existed before this task, and a fix needs a larger refactor | File or reuse a code quality issue as described below. Keep the PR focused. |

A small change stays within the function or an immediate helper, preserves its
contract and needs no new architecture. Prefer simpler control flow and useful
missing tests. Keep decisions visible; moving all of them to a new helper to
lower one score does not resolve the problem.

Baseline complexity alone cannot prove inherited CRAP. Compare the changed
branches and tests too. When CRAP attribution is uncertain, measure baseline
coverage with the same relevant tests in a disposable checkout of the pinned
SHA. Keep baseline and current reports separate. An uncertain origin remains an
unresolved finding; it does not qualify for an inherited-refactor issue.

For each inherited larger refactor, read [issues.md](references/issues.md).
Filing that issue, including creating its label, is part of this check. A filing
failure remains a blocker with its prepared issue text and exact error.

Done when every flagged function has verified scores within the limits, a
linked inherited-refactor issue, or a stated blocker. Any blocker means the
pre-PR check is incomplete.

## 4. Report before opening the PR

Include the pinned baseline, checked file/function count, and a compact table:
`file:function | complexity | body line coverage | CRAP | action/issue`.
Include coverage commands and any measurement limits. Open the PR only when the
check is complete. Keep the report in the PR's validation section, with issue
links for deferred refactors. These issues are follow-up work; use `Refs`, rather
than a closing keyword, when linking them from the current PR.
