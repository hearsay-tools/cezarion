# Before a PR

Run after implementation and repeat after a source or test change that can affect
the result. Resolve `<skill>` to the skill directory, then follow all steps below.

## 1. Run the bundled check

Resolve the PR's target branch from the task or repository bindings. Fetch its
remote ref. Select the relevant tests and their runner from the repository's
test instructions. Run from the target repository root:

```sh
node <skill>/scripts/check.mjs --base <target-ref> \
  --runner <vitest|node> --test <test-file> --output <report.md>
```

Repeat `--test` for multiple files. With Vitest, select needed unit projects
using repeatable `--project`. With Node, pass repository setup modules through
repeatable `--node-import`. For an existing current Istanbul report, replace
runner and test options with `--coverage <coverage-final.json>`.

The command pins a merge-base, scans committed, staged, unstaged and untracked
JS/TS changes, collects coverage once, matches changed functions and checks source
hashes. It writes Markdown and JSON reports with scores, baseline complexity,
source hashes and the reproduction command. Tests and bundled scripts stay in
scope. Use its `base` SHA for every baseline comparison. Record unsupported
changed languages as outside this tool's scope.

| Exit | Meaning | Next action |
| --- | --- | --- |
| 0 | Every changed function passes, or there are no supported changed functions | Report the result |
| 1 | At least one function exceeds a limit | Resolve every finding below |
| 2 | Measurement is incomplete, including failed tests or missing coverage | Fix setup or coverage; rerun |

A coverage run is a distinct measurement even when background validation passed.
For dependencies, runner limits or a collection failure, read
[tool.md](tool.md). Use the bundled command for collection, matching,
verdicts and reports; keep that work in the tool instead of temporary scripts.

Done when the command produced a complete report, or a stated measurement blocker.

## 2. Resolve scores above the limits

Use `thresholds` from the generated report. Flag a function when either score is
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

For each inherited larger refactor, read [issues.md](issues.md).
Filing that issue, including creating its label, is part of this check. A filing
failure remains a blocker with its prepared issue text and exact error.

Rerun the same command after source or test changes. Done when every flagged
function has verified scores within the limits, a linked inherited-refactor
issue, or a stated blocker. Any blocker means the
pre-PR check is incomplete.

## 3. Report before opening the PR

Link the generated report from the PR's validation section. State its verdict,
checked function count and any measurement limits. For exit 1, add an action and
issue link for every deferred finding; open the PR only when all findings qualify
for the inherited-refactor exception above. Exit 2 blocks opening the PR.
These issues are follow-up work; use `Refs`, rather than a closing keyword,
when linking them from the current PR.
