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
JavaScript or TypeScript extension. For Node,
the skill bundles the V8 merger and Istanbul converter; no Vitest dependency is
needed. Node collection supports untransformed JavaScript. For transformed
TypeScript/JSX or another runner, collect Istanbul coverage through that runner
and supply `--coverage`. The tool downloads no test dependencies.

```sh
node <skill>/scripts/check.mjs --base origin/main --runner vitest \
  --test src/example.test.ts --project unit --output quality.md
node <skill>/scripts/check.mjs --base origin/main --runner node \
  --test scripts/example.test.mjs --node-import scripts/test-setup.mjs --output quality.md
node <skill>/scripts/check.mjs --base origin/main \
  --coverage coverage/coverage-final.json --output quality.md
```

Collection has a ten-minute bound. Failed tests produce exit 2 and no accepted
verdict. `--test-timeout <ms>` sets the per-test timeout of the coverage run.
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

## Individual measurements

Run commands from the target repository root. The standalone CLI selects the
project's default Vitest projects unless `--project` selects specific ones.

```sh
node <skill>/scripts/metrics.mjs src/example.ts --function choose --json
node <skill>/scripts/metrics.mjs src/example.ts --line 42 --json
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

The matcher first uses exact function-body positions. For an arrow whose body
is another arrow, it can also use an exact Istanbul declaration endpoint: the
parsed arrow's start plus one column, with the same body end line. This handles
source maps that move a returned arrow's body start into its parent's parameter
list. Each coverage entry can belong to only one function. Names, entry order
and nearby positions cannot resolve ambiguous matches.

Called outer stages and uncalled returned stages keep separate call counters.
The directly returned arrow's entire span is excluded from its parent's
statement attribution, including mapped statements that drift into the returned
arrow's signature. That parent has no independent body statements, so its own
call counter determines 100% or 0%. The returned function keeps its own body
statements, and the CRAP formula is unchanged. An absent counter is not evidence that a function was uncalled.

Some transforms lose both exact anchors, including the middle stage of a
multiline three-stage arrow in the tested Vitest V8 transform. Missing or
ambiguous matches still produce unavailable coverage, null CRAP and exit 2;
the report points here. Regenerating the same source map may repeat the failure.
Rewrite the affected stage as a block-bodied function that returns the next
arrow, then collect fresh coverage with the same `--test` and `--project` flags:

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
