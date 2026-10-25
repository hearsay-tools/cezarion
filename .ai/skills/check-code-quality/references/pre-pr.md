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

Repeat `--test` for multiple files. With Vitest, select every project that runs
a selected test using repeatable `--project`: a unit test file needs its unit
project, a `*.e2e.ts` browser spec needs its browser project. Vitest uses the
repository's own configuration, setup files, aliases and environment. With Node,
pass repository setup modules through repeatable `--node-import`. For an existing
current Istanbul report, replace runner and test options with
`--coverage <coverage-final.json>`.

A change with no changed JS or TS file (`.js`, `.jsx`, `.ts`, `.tsx`, or their
`.cjs`, `.mjs`, `.cts` and `.mts` forms) measures nothing, so it needs no
`--runner` or `--test`:

```sh
node <skill>/scripts/check.mjs --base <target-ref> --output <report.md>
```

It reports `Checked 0/0 changed functions` and exits 0.

In this repository, a change with cockpit source, unit tests and browser specs
takes one command. The `e2e` project's own global setup boots the test
environment:

```sh
node .ai/skills/check-code-quality/scripts/check.mjs --base origin/main \
  --project web --project e2e \
  --test packages/web/src/routes/new-task.test.tsx \
  --test packages/web/e2e/completion-controls.e2e.ts \
  --output .ai/qa/<issue>/code-quality.md
```

When Squeal is validating this worktree, it can hold the test-environment lease
needed by the `e2e` coverage measurement. The check then exits 2 with
`timed out waiting for test environment held by pid N (node squeal.mjs daemon …)`.
This coverage measurement is separate from Squeal's ordinary test results.
For this measurement only, stop this worktree's daemon and start it again even
when the check fails. From the repository root, wrap the command above as follows
(replace `<issue>` before running):

```sh
(
  set -e
  test -d "$PWD"
  squeal stop "$PWD"
  restore_validation() {
    measurement_status=$?
    trap - EXIT
    if ! squeal start "$PWD"; then
      if ! node --input-type=module - "$PWD" "$(command -v squeal)" <<'NODE'
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';

const root = realpathSync(process.argv[2]);
const launcher = process.argv[3];
// bound: allow 30 extra seconds for the seconds-late startup observed under
// host load in hearsay-tools/squeal#94; this is not a startup-time guarantee.
const deadline = performance.now() + 30000;
process.exitCode = 1;
while (performance.now() < deadline) {
  const probe = spawnSync(launcher, ['status', '--json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: Math.max(1, Math.min(5000, Math.ceil(deadline - performance.now()))),
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    // Test failures can make status nonzero; only daemon liveness matters here.
    const status = JSON.parse(probe.stdout);
    if (!probe.error && performance.now() < deadline && status.available === true &&
        status.worktreeRoot === root && status.daemon?.state === 'alive') {
      process.exitCode = 0;
      break;
    }
  } catch {
    // Missing or malformed status does not confirm that validation is restored.
  }
  await setTimeout(Math.max(0, Math.min(1000, deadline - performance.now())));
}
NODE
      then
        echo "Squeal restart failed after the status wait; restore validation with squeal start in this worktree" >&2
        if [ "$measurement_status" -eq 0 ]; then measurement_status=1; fi
      fi
    fi
    exit "$measurement_status"
  }
  trap restore_validation EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  node .ai/skills/check-code-quality/scripts/check.mjs --base origin/main \
    --project web --project e2e \
    --test packages/web/src/routes/new-task.test.tsx \
    --test packages/web/e2e/completion-controls.e2e.ts \
    --output .ai/qa/<issue>/code-quality.md
)
```

Under Codex, replace each `squeal` command with the absolute launcher from its
SQUEAL message when it is not on PATH, including the argument to `command -v`.
After a failed start, the wrapper checks status about once per second for at most
30 additional seconds; each probe gets at most five seconds or the remaining
time. It accepts only an available status for this worktree with a live daemon,
independently of test verdicts. A successful start adds no wait. A failed
measurement keeps its exit code, including 130 for INT and 143 for TERM, even
when restoration also fails. The wait observes the daemon already started;
it does not start another daemon or run tests. Remove the extra status wait when
[hearsay-tools/squeal#94](https://github.com/hearsay-tools/squeal/issues/94)
lands and the installed Squeal version includes the startup fix.

If no daemon is validating this worktree,
use the original command without the wrapper. Do not remove the lease lock or
start a duplicate ordinary test run. Remove this workaround when
[hearsay-tools/squeal#78](https://github.com/hearsay-tools/squeal/issues/78)
lands and the installed Squeal version releases the idle browser lease.

Server changes use `--project server`. Root `scripts/*.test.mjs` and
`.github/scripts/*.test.cjs` files use `--runner node` with
`--node-import scripts/test-git-env.mjs`. Do not write a wrapper Vitest
configuration or test entry files: the collector measures changed test
functions itself.

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

A loaded host can make tests time out in the coverage run although each file
passes alone. Add `--test-timeout 30000` to the same command and rerun it. Do
not build a coverage command by hand. The flag sets the per-test timeout for
the coverage run only; a test that fails for another reason still fails.

The whole coverage collection defaults to 600000 ms, independently of
`--test-timeout`. If collection exceeds that limit, rerun the same command with
`--coverage-timeout 900000` (fifteen minutes), or a larger positive safe whole
number of milliseconds. The timeout remains an incomplete check (exit 2).
Alternatively, supply a separately collected current Istanbul report through
`--coverage <coverage-final.json>` instead of `--test`; temporary reports from
the stopped collection are removed.

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

To plan a split along a flagged function's decision points, list them with
`node <skill>/scripts/metrics.mjs <file> --function <name> --breakdown` (add
`--line <line>` for a repeated name). Each `line kind` row is one counted
point, so the rows plus one equal the complexity.

CI runs a looser ratchet on the same functions:
`node <skill>/scripts/complexity-gate.mjs --base <target-ref> --head HEAD` refuses only a
changed function over 20 that is new or more complex than at the merge base. A change that
lowers such a function but leaves it above 20 passes CI, and the gate lists it as a notice.
This check still flags every changed function above a limit, so a clean report here implies
a pass there. A pass there does not imply a clean report here.

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

Make the report available from the PR's validation section. An ignored path such
as `.ai/qa/<issue>/code-quality.md` is not a report link a reviewer can open.

- In a Cezar task, publish the generated report with the session-provided
  task-artifact command: `… artifact publish <report.md>` (or
  `cez artifact publish <report.md>` when `cez` is on PATH). It uses the task's
  `CEZ_ARTIFACTS_DIR` and `CEZ_TASK_ID`. The returned JSON's `link` is a
  root-relative cockpit path. In a GitHub PR, prefix that exact path with the
  verified cockpit origin that reviewers can access; for example, an origin
  `https://cockpit.example` and returned `/p/…/files?artifact=…` form
  `https://cockpit.example/p/…/files?artifact=…`. Use that absolute URL as the
  report link in the validation section. Do not invent an origin or reconstruct
  the artifact path. Pasting the returned `markdown` unchanged into GitHub
  resolves its path under github.com and does not reach the cockpit. This is a
  local snapshot, not a public GitHub attachment. It survives worktree cleanup
  until task history is deleted.
- When the artifact command, task context or a reviewer-accessible cockpit
  origin is unavailable, put the verdict,
  checked function count, measurement limits and every flagged report row in
  the PR's validation section, with each row's action and any applicable issue
  link. This keeps the review evidence available without a cockpit link.

In either case, state the verdict, checked function count and any measurement
limits in the validation section. For exit 1, add an action and issue link for
every deferred finding; open the PR only when all findings qualify for the
inherited-refactor exception above. Exit 2 blocks opening the PR.
These issues are follow-up work; use `Refs`, rather than a closing keyword,
when linking them from the current PR.
