# Before a PR

Use Squeal's one-shot changed-function gate. This local-first rollout replaces
both daemon snapshot inspection and the bundled pre-PR fallback. CI and requested
code statistics still use their existing paths until the remaining work in
[hearsay-tools/squeal#167](https://github.com/hearsay-tools/squeal/issues/167) ships.
CI passing does not replace this local check.

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
limits or add exclusions to get a pass. If the base policy differs, report the
mismatch before claiming this repository's check passed.

Collection has one 600-second default budget across the selected runners. The
one-shot option `--timeout 900` sets a fifteen-minute budget, in **seconds**.
It differs from the legacy collector's millisecond timeout flags. Use a larger
budget only when needed to complete the selected evidence. Preserve configured
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
- `verdict` is `pass`; every reported function is `pass`, with known complexity
  and CRAP within the limits. `counts.skipped` and `counts.incomplete` are zero.
  Skipped functions are not passing functions, even when Squeal exits 0.
- Each function has matching `loaders.expected` and `loaders.measured` sets.
  A CRAP upper bound from partial loader coverage does not supply complete
  evidence, even when the function state is `pass`.
- `uncounted` is empty and `budget.timedOut` is false. Every selected test file completed and no selected test
  failed: inspect `runs`, including `notFinished` and `failed`. Missing, stale,
  unknown, partial or unsupported required evidence cannot pass.

A report with no changed supported functions may pass, for example for a
Markdown-only change. State the zero count; it is not a test-suite pass.
Preserve useful measured rows on an incomplete run and state the exact gaps.
No mapped test means unknown, not a fabricated zero-coverage measurement.
Compile-only runtime callbacks, browser-only paths and child-process-only code
can expose unsupported evidence in this release; do not exempt them by hand.

## 3. Resolve findings

Read each changed function and its tests. Fix violations within the approved
scope, then collect a fresh report. If the fix needs a larger design, report the
blocker before opening the PR. Keep decisions visible rather than moving them
to a helper merely to lower one score.

Squeal 0.1.423 does not implement inherited-refactor deferrals or owner-approved
exceptions. A baseline comparison, linked issue, manual bound or CI growth
approval cannot turn a local violation into a pass. Name the blocker and wait
for the supported exception path or resolve the finding. Do not fall back to
the bundled checker or combine partial results from different engines.

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
Do not call it a bundled-check pass or a daemon measurement. Only complete
passing evidence permits the PR to open. CI and independent review remain
separate gates. Keep hearsay-tools/cezarion#3096 open for the remaining migration.
