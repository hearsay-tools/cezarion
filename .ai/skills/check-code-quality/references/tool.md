# Bundled tool

These scripts remain for requested code statistics, compatibility and the existing
CI complexity gate. They are not the local pre-PR gate or a fallback for it.
For pre-PR work, use [Before a PR](pre-pr.md), which requires Squeal.

The skill owns the parser, CLI and change scanner in `scripts/`. Copy the whole
skill directory to reuse them. They require Node 24.15 or newer. The changed-function
check also requires Git; individual measurements work outside a Git repository.

Dependencies resolve from the skill or an ancestor's `node_modules`.
If a bundled dependency is absent, install the bundled manifest:

```sh
npm install --prefix <skill> --ignore-scripts --no-audit --no-fund
```

## Tests

Each bundled script's tests sit beside it in `scripts/`, named
`<script>.test.mjs` for the script they cover most. `quality-check.test.mjs`
covers `check.mjs` and the modules it drives. A change to a bundled script
updates its tests in the same change. The tests use `node:test` and need only
the bundled dependencies, plus Vitest for the Vitest collection tests. Run them
from the skill or any directory:

```sh
node --test <skill>/scripts/*.test.mjs
```

## Complete check

`scripts/check.mjs --help` lists the command's flags and exit codes. The command
collects coverage for all changed files in one bounded test run, merges Node
process coverage when needed, measures changed functions, checks hashes and emits
the verdict. `--output report.md` saves Markdown plus `report.json`. JSON stdout
is available with `--json`; test output goes to stderr. Temporary coverage is
removed on success and failure. Reports preserve source hashes and commands.

For Vitest, the target project needs Vitest and its matching
`@vitest/coverage-v8` installed through its package manager; a missing package
stops the check with an install instruction. The collector runs
`scripts/vitest-coverage.mjs` in a child process, which starts Vitest through its
Node API with the project's own configuration. Select every project that runs a
selected test in a multi-project repository. Vitest always excludes its
`test.include` globs from coverage; the runner removes only those globs, so
changed test functions are measured, and `coverage.include` still limits the
report to the changed files. Test files end in `.test`, `.spec` or `.e2e` and a
JavaScript or TypeScript extension.

The Vitest collector also measures Node child processes that the selected tests
start, such as a runner mock that a test runs as the runner's native binary. It
adds `NODE_V8_COVERAGE` to each project's `test.env`. Vitest copies that
environment into its workers after they start, so the workers record nothing,
and every Node process a test spawns inherits the variable. The collector captures generated code with a local, in-process inspector session.
It opens no network listener. It archives selected code and inline source maps
under the temporary raw directory before a child can remove emitted files.
Mapped source contents must exactly match the current selected files. The existing
Istanbul converter maps generated ranges back to their original source positions.
Node groups support TypeScript through `imports: ["tsx"]`; legacy Node setup
imports remain available through `--node-import`.

Vitest worker preloads capture selected sources before test modules load. Native
modules loaded through `createRequire` use that archived code and its actual
whole-script range, rather than a later Vite transform. Missing, stale or
ambiguous native snapshots fail collection. This does not enable a second V8
counter stream in workers; Vitest still owns their counters.

For transformed code, Vite's generated named-import binding adapters can map
to invalid positions on the first source line. The collector removes only
top-level adapters whose generated AST and original named import prove the
binding and module. It replaces that conversion text with whitespace, keeping
all other offsets and function counters. Original source nodes and the metrics
location checks remain intact.

Transformed coverage requires an inline map with embedded source contents.
Missing, stale or ambiguous code snapshots and maps cannot complete measurement.
The collector does not guess source paths, use current files as generated code,
or supply zero counts for missing functions. Native Node type stripping without
an inline map is incomplete; use the existing tsx loader instead.

These child processes remain outside measurement:

- Non-Node processes, and children that discard `NODE_V8_COVERAGE`.
- Transformed children that clear loader options without explicitly archiving
  their generated code through `source-snapshots.mjs` before cleanup.
- Processes ended by a signal before coverage is flushed. The collector adds
  no signal handlers. A controlled fixture can call `node:v8`'s `takeCoverage()`
  and acknowledge an explicit IPC flush request before its test sends a signal.

The helper `recordGeneratedSource(url, code)` synchronously archives selected
sources only when both `NODE_V8_COVERAGE` and `raw/quality-inputs.json` exist.
The manifest is an array of selected absolute source paths.
`measurementEnabled()` reports that same condition; ordinary fixtures stay
map-free. The helper has no runtime dependency beyond Node.

```sh
node <skill>/scripts/check.mjs --base origin/main --runner vitest \
  --test src/example.test.ts --project unit --output quality.md
node <skill>/scripts/check.mjs --base origin/main --runner node \
  --test scripts/example.test.mjs --node-import scripts/test-setup.mjs --output quality.md
node <skill>/scripts/check.mjs --base origin/main \
  --coverage coverage/coverage-final.json --output quality.md
```

Collection defaults to a ten-minute bound (600000 ms). `--coverage-timeout <ms>`
changes that bound for the whole collection child process, for both runners;
for example, `--coverage-timeout 900000` allows fifteen minutes. It requires
`--test` and accepts positive safe whole milliseconds, at most 9007199254740991;
zero does not disable the bound. A timeout produces exit 2, names the effective
limit and explains how to raise it. Temporary coverage is removed on failure;
`--coverage <coverage-final.json>` requires a current Istanbul report collected
separately (this repository's CI publishes one: see Coverage from CI below). Failed tests produce exit 2 and no accepted verdict. `--test-timeout <ms>` sets the per-test timeout of the coverage run.
With Vitest it replaces the `testTimeout` of every selected project; hook
timeouts keep their configured values. With Node it passes `--test-timeout` to
`node --test`. Use it when tests time out under host load but pass alone. Missing, stale or unmatched function coverage remains incomplete. A
source edit, new changed function or HEAD change during measurement also produces
exit 2. The tool checks source hashes and rescans against the pinned baseline.
Changed test functions stay in scope. A file missing from the report, such as a
test that no selected `--project` runs, or one a project's own `coverage.exclude`
removes, produces exit 2 and names the missing file; passing source scores alone
cannot complete that check.
An external Istanbul report has an mtime check but no source-provenance proof;
collect fresh coverage when its provenance is uncertain.

### Explicit collection groups

Use repeatable `--collection` arguments when the changed files need different
runners, loaders or working directories. Each argument is a JSON object or a
path to a JSON manifest containing one object. The strict shape is:

```json
{"runner":"node","tests":["test/unit/example.test.ts"],"imports":["tsx"],"cwd":"packages/cezar"}
```

`runner` (`node` or `vitest`) and the nonempty `tests` array are required.
`imports`, `projects` and `cwd` are optional. Unknown fields are errors.
`imports` accepts Node setup files or installed modules such as `tsx`; it is
valid only for Node. `projects` selects Vitest project names and is valid only
for Vitest. Both optional arrays may be empty. All array entries must be
nonempty strings.

`cwd` defaults to the command's working directory and resolves relative to it.
Test and setup-file paths resolve from the group's `cwd`. A manifest path
resolves from the command's working directory; its location does not change
these path rules. Every test must name an existing test file. Assign each real
test file to exactly one group; duplicate paths and symlink aliases are errors.

```sh
node <skill>/scripts/check.mjs --base origin/main \
  --collection '{"runner":"node","tests":["test/unit/example.test.ts"],"imports":["tsx"],"cwd":"packages/cezar"}' \
  --collection '{"runner":"vitest","tests":["packages/web/src/example.test.tsx"],"projects":["web"]}' \
  --output quality.md
```

Groups run once each. Their Istanbul reports merge before the check measures
the complete changed-function inventory. The global `--test-timeout` and
`--coverage-timeout` flags apply to each group. Do not combine `--collection`
with `--coverage`, `--runner`, `--test`, `--project` or `--node-import`.

## Individual measurements

Run commands from the target repository root. The standalone CLI selects the
project's default Vitest projects unless `--project` selects specific ones.

```sh
node <skill>/scripts/metrics.mjs src/example.ts --function choose --json
node <skill>/scripts/metrics.mjs src/example.ts --line 42 --json
node <skill>/scripts/metrics.mjs src/example.ts --line 42 --column 7 --json
node <skill>/scripts/metrics.mjs src/example.ts --coverage coverage/coverage-final.json --json
node <skill>/scripts/metrics.mjs src/example.ts --test src/example.test.ts --project unit --json
```

Complexity uses ESLint's classic convention. The CRAP formula is
`C² × (1 − coverage)³ + C`, using executable function body line coverage. This is
a line-coverage variant of the original basis-path metric. Missing coverage
produces `crap: null`. Reports must describe the exact current source; an mtime
check rejects older reports but cannot prove their provenance.

The change scanner compares function source, excluding nested bodies from the
parent. Comments and whitespace inside a function count as edits. Renamed or
moved functions may appear as added. Duplicate identities can have an unknown
baseline. Inspect the diff and baseline for these cases before deciding origin.

## Curried arrows and transformed coverage

The matcher first uses exact function-body positions. For any expression-bodied
arrow, including cast object literals and returned arrows, it can also use an
exact Istanbul declaration endpoint: the parsed arrow's start plus one column, with the same body end line. This handles
source maps that move a returned arrow's body start into its parent's parameter
list. Each coverage entry can belong to only one function. Names, entry order
and nearby positions cannot resolve ambiguous matches.

Called and uncalled curried stages keep separate counters. The directly
returned arrow's span is excluded from its parent's statement attribution,
including mapped statements in the returned arrow's signature. A parent with
no independent statements uses its own call counter for 100% or 0% coverage.
The returned function keeps its body statements. CRAP is unchanged; a missing
counter does not mean the function was uncalled.

Some transforms lose both exact anchors, including the middle stage of a
multiline three-stage arrow in the tested Vitest V8 transform. Missing or
ambiguous matches still produce unavailable coverage, null CRAP and exit 2;
the report points here. Regenerating the same source map may repeat the failure.
Rewrite the unmatched expression-bodied arrow with a block body and an explicit
`return`, then collect fresh coverage with the same `--test` and `--project` flags:

```ts
// Before
const set = (key: string, value: string) => (current: URLSearchParams) => {
  current.set(key, value);
  return current;
};

// Explicit outer body gives the collector a separate body anchor.
function set(key: string, value: string) {
  return (current: URLSearchParams) => {
    current.set(key, value);
    return current;
  };
}
```

For a longer chain, give each unmatched stage its own explicit body. This is a
mapping workaround, not a coverage exemption; every changed stage must still
have a coverage result.

## Legacy collection recipes

Resolve the PR's target branch from the task or repository bindings. Fetch its
remote ref. Select the relevant tests and their runner from the repository's
test instructions. Run from the target repository root:

```sh
node <skill>/scripts/check.mjs --base <target-ref> \
  --runner <vitest|node> --test <test-file> --output <report.md>
```

Select relevant import-graph tests and pass every changed test file with runtime
functions, including type-focused tests and browser specs. Type-only imports do
not exempt runtime `describe` or `it` callbacks from measurement; compile-time
assertions still require the repository's typecheck. To find tests importing a
changed testkit, replace the placeholder with its basename and inspect matches:

```sh
rg -l -F '<testkit basename>' packages --glob '*.test.ts'
```

Repeat `--test` for multiple files. With Vitest, select every project that runs
a selected test using repeatable `--project`: a unit test file needs its unit
project, a `*.e2e.ts` browser spec needs its browser project. Browser specs run and are
measured through that project; passing them does not ask the check to skip them. Vitest uses the
repository's own configuration, setup files, aliases and environment. With Node,
pass repository setup modules through repeatable `--node-import`. For an existing
current Istanbul report, replace runner and test options with
`--coverage <coverage-final.json>`.

CI still publishes Vitest coverage for the head you push. For an explicit
legacy measurement request, that artifact can avoid a separate collection: see [Coverage from CI](#coverage-from-ci) below.

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
  --test packages/web/src/routes/new-task-composer.test.tsx \
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
    --test packages/web/src/routes/new-task-composer.test.tsx \
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

#### Coverage from CI

CI's required `Vitest shard N/8` jobs collect V8 coverage during their single test run
on eligible pull requests and dispatches. The optional `Merge Vitest coverage` job uploads one artifact for the head:
`vitest-coverage-<head SHA>`, holding `coverage-final.json` (paths relative to the
repository root, test files included) and `provenance.json`. It runs on every pull request
and on a dispatch of `ci.yml`, and report publication is not a required check. This saves a local coverage
run, which took about 10 minutes at high load on hearsay-tools/cezarion#1772.

1. Get the run for the exact head you have checked out, with a clean tree:

   ```sh
   head=$(git rev-parse HEAD)
   # After the PR exists:
   gh run list --workflow ci.yml --event pull_request_target --commit "$head" --json databaseId,status,conclusion
   # Before a PR exists: push the branch and dispatch CI on it, once per head.
   gh workflow run ci.yml --ref <branch>
   gh run list --workflow ci.yml --event workflow_dispatch --branch <branch> --commit "$head" --json databaseId,status
   ```

   No run for the head means CI has not seen it: push it, or dispatch.

2. Wait for the `Merge Vitest coverage` job (about 10 to 15 minutes after the push). The
   artifact exists as soon as that job ends, before the rest of the run does:

   ```sh
   gh run view <run-id> --json jobs --jq '.jobs[] | select(.name == "Merge Vitest coverage") | .status + " " + (.conclusion // "")'
   ```

3. Download it and run the check against it. `--coverage` replaces `--runner` and `--test`:

   ```sh
   gh run download <run-id> -n "vitest-coverage-$head" -D .ai/qa/<issue>/coverage
   node .ai/skills/check-code-quality/scripts/check.mjs --base origin/main \
     --coverage .ai/qa/<issue>/coverage/coverage-final.json --output .ai/qa/<issue>/code-quality.md
   ```

Limits, each with its fix:

- The report is for the pushed head. A pull request run tests `refs/pull/<N>/merge`, not the
  head itself, so bring the branch up to date with `origin/main` and push before you rely on
  it. A local edit after the push needs a new push and a new artifact: the tool matches
  functions by position, and `provenance.json` names the tested ref and the head SHA.
- A pull request that only changes docs or infrastructure runs no coverage job. Neither does
  the merge queue or a push to `main`.
- Only Vitest's four unit projects are covered. Node `node:test` files and mock child
  processes are not (hearsay-tools/cezarion#1711, hearsay-tools/cezarion#1696). Exit 2 names a
  file the report lacks: collect that coverage with `--runner` and `--test` as above.
- When a shard or the merge failed, no artifact exists. The `Merge Vitest coverage` job stays
  green and shows a warning annotation and a summary line that name the missing shard or the
  failed step. Use the local `--test` run then.

A coverage run is a distinct measurement even when background validation passed.
For dependencies, runner limits or a collection failure, read
[tool.md](tool.md). Use the bundled command for collection, matching,
verdicts and reports; keep that work in the tool instead of temporary scripts.

Done when the command produced a complete report, or a stated measurement blocker.
