# Before a PR

Use Squeal's one-shot changed-function gate. It is the only local quality
check; this skill has no bundled fallback. CI passing does not replace it.

Run it beside the push, as the reviewer round runs: start it on the committed head, push,
and read the report when it finishes. It does not gate the push, and `npm run prepr` does
not run it. It reuses Squeal's stored results at the branch's own content, so a warm
daemon shortens it from about 11 minutes to about 2. An incomplete report still blocks
the PR from merging, and auto-merge waits for it
(hearsay-tools/cezarion#3289).

## 1. Collect the gate report

Resolve and fetch the PR target branch from the repository bindings. Run from
the repository root, without path filters, so the report covers the whole change:

```sh
squeal --version
quality_report=$(mktemp "${TMPDIR:-/tmp}/code-quality.XXXXXXXX") || exit 2
squeal code --base origin/main --json > "$quality_report"
quality_status=$?
printf 'Report: %s; exit: %s\n' "$quality_report" "$quality_status"
```

Replace `origin/main` when the PR targets another branch. Use a report path outside
tracked source inputs. Keep the command's exit status and stderr as evidence;
saving stdout does not turn a failed command into a pass. Under Codex, replace
`squeal` with the absolute launcher named in the session's SQUEAL message.

Squeal 0.1.423 supplies this interface. Record the actual runtime version and
require the supported `squeal-code-gate/1` report. A missing command, unavailable
capability or unknown report format blocks the check. Do not silently install or
upgrade Squeal, or use another calculator as a fallback. A pinned runtime for CI
remains a later Squeal slice; this procedure does not provide one.

The command runs once without an agent session or daemon. It inventories changed
JS/TS functions against the merge base, including test callbacks and nested
functions, and selects tests through Vitest and node:test. Repeatable `--test`
can add relevant test files; it does not excuse missing evidence elsewhere.
Do not substitute per-path daemon reports or a filtered function selection.

The command reads limits and exclusions from the base commit's configuration.
The policy limits are complexity 20 and CRAP 30; equality passes. Do not loosen
limits to get a pass. Change `coverage.exclude` only under the rule in §2. If the
base policy differs, report the mismatch before claiming this repository's check
passed.

Collection has one 600-second default budget across the selected runners. The
one-shot option `--timeout 900` sets a fifteen-minute budget, in **seconds**.
Use a larger budget only when needed to complete the selected evidence. Preserve configured
project timeouts; test failures remain blockers.

This release performs a distinct coverage run; background passing tests do not
replace it. Follow Squeal's installed guidance for resource conflicts. Do not
remove lease locks, create custom collector wrappers or duplicate concurrent
coverage runs. A runner or environment that cannot supply the evidence is a
named blocker, not permission to switch calculators.

## 2. Require complete evidence

Inspect the full report, not only the exit code or a count of known failures:

| Exit | Meaning | Action |
| --- | --- | --- |
| 0 | Squeal's verdict is pass; skipped functions can still be present | Check completeness below |
| 1 | At least one violation; incomplete evidence can coexist | Resolve violations and every evidence gap |
| 3 | Incomplete measurement | Repair the named gap and rerun |
| 2 | Usage or setup error | Fix the command or setup and rerun |
| Other | Interrupted or unexpected failure | Report the failure; no pass |

A local quality pass requires all of the following:

- The report format, runtime and measurement versions are known. Record
  `versions`, `base`, `head` and `budget`, including dirty state and path blob hashes.
- The report covers the full current change against the fetched target. Its
  head, source hashes and policy describe the tree being submitted. An affected
  source, test or policy edit after collection requires fresh evidence.
- `verdict` is `pass`; every reported function is `pass` or `skipped`, with
  known complexity within the limit, and CRAP within the limit for each `pass`.
  `counts.incomplete` is zero. A `skipped` function passes only when its file
  matches `base.policy.coverageExclude` in the report (see below).
- Each `pass` function has matching `loaders.expected` and `loaders.measured` sets.
  A CRAP upper bound from partial loader coverage does not supply complete
  evidence, even when the function state is `pass`.
- `omitted` lists only functions with reason `unchanged` or `moved`: the change
  did not edit their bodies, so they need no evidence.
- `uncounted` is empty and `budget.timedOut` is false. Every selected test file completed and no selected test
  failed: inspect `runs`, including `notFinished` and `failed`. Missing, stale,
  unknown, partial or unsupported required evidence cannot pass.

A report with no changed supported functions may pass, for example for a
Markdown-only change. State the zero count; it is not a test-suite pass.
Preserve useful measured rows on an incomplete run and state the exact gaps.
No mapped test means unknown, not a fabricated zero-coverage measurement.

### Code that only a child process runs

Squeal measures coverage in the test's own process. A file that tests run only
as a separate process, or only as a copy at another path, has no measurable
coverage: its changed functions read `incomplete (no-loader)`, or get a CRAP from
the 0% coverage of the functions only the child or copy calls. The `coverage.exclude`
list in `squeal.config.json` names these files. The gate reads a changed function
in a listed file as `skipped`: it keeps its complexity check, gets no CRAP and
does not block. The list holds:

- each native runner mock in `packages/cezar/scripts/` that tests start only as
  the runner's binary. The list names each mock: the mocks that tests import
  (`mock-controls`, `mock-lifecycle`, `mock-scenario`, `mock-publish`,
  `mock-session-context`, `mock-failure-control`, `mock-delivery-control`) keep
  their CRAP check, so a `mock-*.mjs` glob would be wrong.
- the manual probe scripts, `.ai/scripts/probe-*.ts`, which no test runs.
- `.ai/scripts/test-env-lease.mjs`, whose subcommands tests run only through a
  copy in a fixture checkout, because the script finds the repository root from
  its own location.

A new mock that tests start only as a child process goes into this list in the
same change, by name, so a later edit of it can pass the gate. Any other code
that only a child process runs gets no entry: export its functions and call them
from a test in the test's own process. Do not add an entry to pass one change,
and do not exempt a function by hand.

## 3. Resolve findings

Read each changed function and its tests. Fix violations within the approved
scope, then collect a fresh report. If the fix needs a larger design, report the
blocker before opening the PR. Keep decisions visible rather than moving them
to a helper merely to lower one score.

Squeal 0.1.423 does not implement inherited-refactor deferrals or owner-approved
exceptions. A baseline comparison, linked issue, manual bound or CI growth
approval cannot turn a local violation into a pass. Name the blocker and wait
for the supported exception path or resolve the finding. Do not fall back to
another calculator or combine partial results from different engines.

## 4. Preserve reviewable evidence

In the PR's validation section, state the verdict, passing/expected function
counts, runtime and report versions, pinned base, head or dirty-tree identity,
limits, test completion and any measurement gaps. Include the reproduction
command. A complete report with zero functions needs no coverage claim.

Publish the JSON report with the task's artifact command when available. An
ignored local path is not a reviewable report link. In GitHub, use an absolute
artifact URL only when the cockpit origin is verified and accessible to the
reviewer; never invent an origin or paste a cockpit-relative path under GitHub.
When publication or an accessible origin is unavailable, put the verdict, counts,
versions, base/head identity and each finding with its action in the PR body.

State that the **Squeal one-shot gate** supplied the local quality evidence.
Do not call it a daemon measurement. Only complete
passing evidence permits the PR to merge (auto-merge waits for it); it no longer gates opening it. CI and independent review remain
separate gates. Code that only the packaged CLI suite runs, such as
`scripts/release.mjs`, has no loader in this gate yet (hearsay-tools/squawk#3096).
