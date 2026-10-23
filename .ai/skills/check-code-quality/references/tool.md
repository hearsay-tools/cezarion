# Bundled tool

The skill owns the parser, CLI and change scanner in `scripts/`. Copy the whole
skill directory to reuse them. They require Node 24.15 or newer and Git.

The parser resolves from the skill's dependencies or an ancestor's `node_modules`.
If `@babel/parser` is absent, install the bundled manifest:

```sh
npm install --prefix <skill> --ignore-scripts --no-audit --no-fund
```

For fresh coverage, the target project needs Vitest and its matching
`@vitest/coverage-v8` version installed through that project's package manager.
Use its existing test configuration. The tool downloads no test dependencies.
For another test runner, collect an Istanbul `coverage-final.json` through that
runner and pass `--coverage`.

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
check rejects older reports but cannot prove their provenance. Collect fresh
coverage when provenance is uncertain.

The change scanner compares function source, excluding nested bodies from the
parent. Comments and whitespace inside a function count as edits. Renamed or
moved functions may appear as added. Duplicate identities can have an unknown
baseline. Inspect the diff and baseline for these cases before deciding origin.
