# Measure requested code

Measure the requested scope and report the result. This path gathers stats;
code changes, GitHub issues and PR work require a request for that work.
Squeal supplies the numbers. Under Codex, replace `squeal` with the absolute
launcher named in the session's SQUEAL message.

## 1. Select the scope

Use the named file or function. Resolve a function name to its defining file.
For a module spanning several files, list the source files within the requested
module, or name its directory. Keep the scope in the result.

Done when the paths and any function name identify the requested code.

## 2. Get the stats

Run from the repository root:

```sh
squeal code <path>... --json
```

The command lists every function in those files or directories, with
`qualifiedName`, `line`, `complexity` and `decisions` (the decision points by
kind). With coverage on, each function also has `coverage.crap`: an `outcome`
and a `value`, or a `reason` when the outcome is `pending` or `unknown`. Select
the requested function by `qualifiedName` and `line`. Drop `--json` for one
line per function.

The numbers come from this worktree's Squeal daemon. CRAP reads `pending` until
every test file that loads the file has run with coverage. When the user asked
for CRAP and it stays `pending`, wait for it with `squeal status --wait 60000`
and run the command again. A file that only a child process runs, or that
`coverage.exclude` lists, has complexity and no CRAP; [Before a PR](pre-pr.md)
says why.

For a complete, fresh measurement of the functions a branch changed, use the
one-shot gate: `squeal code --base origin/main <path>... --json`. It runs the
tests that load those files with coverage and needs no daemon.

Done when every requested function has a complexity score and either a CRAP
score or its exact reason. Missing CRAP is a measurement limit here; it is an
incomplete gate only in the pre-PR path.

## 3. Report and finish

Show `file:function | complexity | CRAP`. For a larger module, lead with the
file/function count and highest scores, then the relevant rows. State
unavailable CRAP and its reason explicitly.

Identify values strictly above the policy limits of complexity 20 or CRAP 30;
equality is within the limits. Scores above a limit are observations in this
path. End with the stats unless the user also requested fixes or issue filing.

Done when the user has the requested stats, the measured scope and any limits.
