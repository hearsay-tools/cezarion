# Measure requested code

Measure the requested scope and report the result. This path gathers stats;
code changes, GitHub issues and PR work require a request for that work.
Resolve `<skill>` to the skill directory's absolute path.

## 1. Select the scope

Use the named file or function. Resolve a function name to its defining file.
For a module spanning several files, list the source files within the requested
module and measure those files. Keep the scope in the result. A source file
outside a Git repository can also be measured; this path needs no base ref.

Done when the files and any function selector identify the requested code.

## 2. Get the stats

Start with the existing source and available coverage:

```sh
node <skill>/scripts/metrics.mjs <file> --json
node <skill>/scripts/metrics.mjs <file> --function <name> --json
node <skill>/scripts/metrics.mjs <file> --line <line> --json
```

Choose the matching command. Use `--line` to disambiguate a repeated function
name. A line alone selects the innermost function on it, so when a nested
function starts on the same line, add `--column <column>` (1-based, where the
function starts) to select the function that starts there. The complexity gate
prints both with every function it names. Add `--breakdown` to list the decision points behind each complexity as
`line kind` rows, for example `1091 LogicalExpression ??`. The rows plus one
equal the complexity, and a nested function's points appear only under that
function. For several files, run one measurement per file. The command reports
complexity immediately and discovers existing Istanbul coverage. It runs no tests
without `--test`. A known current report can be selected with `--coverage <path>`.

Missing, stale or unmatched coverage leaves CRAP unavailable. Report that limit
with the complexity result. If the user explicitly requested fresh coverage or
CRAP that the existing report cannot supply, collect focused coverage following
[Bundled tool](tool.md); the standalone CLI's `--test` option uses Vitest.
Use the repository's test instructions. Keep coverage collection within the
requested scope and state any remaining measurement blocker.

Done when every requested function has a complexity score and either a measured
CRAP score or its exact coverage limit. Missing CRAP is a measurement limit here;
it is an incomplete gate only in the pre-PR path.

## 3. Report and finish

Show `file:function | complexity | body line coverage | CRAP`. For a larger module,
lead with the file/function count and highest scores, then the relevant rows.
State unavailable coverage explicitly. CRAP uses function body line coverage,
the line-coverage variant identified by the tool.

Identify values strictly above the skill's policy limits of complexity 20 or
CRAP 30; equality is within the limits. Scores above a limit are observations in
this path. End with the stats unless the user also requested fixes or issue filing.

Done when the user has the requested stats, the measured scope and any limits.
