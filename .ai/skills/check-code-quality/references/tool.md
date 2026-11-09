# Bundled tool

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
separately (this repository's CI publishes one: see pre-pr.md, Coverage from CI). Failed tests produce exit 2 and no accepted verdict. `--test-timeout <ms>` sets the per-test timeout of the coverage run.
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
