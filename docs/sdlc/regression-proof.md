# Regression proof recipes

[AGENTS.md § Changing a mechanism](../../AGENTS.md#regression-proof) says when a
regression test needs proof that it fails without the fix. This page holds the
recipes. Each keeps the task's tracked files in place, so Squeal never runs a
swapped version, and none uses the shared git stash stack.

## Source fix

For a **source fix**, run the new regression test against the old source in a
disposable worktree. From the repo root, replace the example commit and paths:

```bash
proof_base=<pre-fix-commit>
proof_repo=$(git rev-parse --show-toplevel)
proof_dir=$(mktemp -d "${TMPDIR:-/tmp}/cezar-red-proof.XXXXXX")
git worktree add --detach "$proof_dir/tree" "$proof_base"
(cd "$proof_dir/tree" && pnpm install --frozen-lockfile)
# Copy the current regression test, plus any new test helpers/fixtures it needs.

cp packages/cezar/src/path/to/regression.test.ts \
  "$proof_dir/tree/packages/cezar/src/path/to/regression.test.ts"
(cd "$proof_dir/tree" && npm test -- --passWithNoTests=false packages/cezar/src/path/to/regression.test.ts)
# Inspect the failure: it must show the reported defect, not a broken import/setup.

# Copy only the fixed source files into the scratch tree; keep the same test.

cp packages/cezar/src/path/to/source.ts \
  "$proof_dir/tree/packages/cezar/src/path/to/source.ts"
(cd "$proof_dir/tree" && npm test -- --passWithNoTests=false packages/cezar/src/path/to/regression.test.ts)
# After saving the evidence, clean up even if setup or a test failed.

git -C "$proof_repo" worktree remove --force "$proof_dir/tree"
rmdir "$proof_dir"
```

Create destination directories for new test paths as needed. Keep the package's
setup and environment; a scratch worktree needs its own dependency installation,
not a symlink to another checkout's workspace packages. Do not start Squeal in
this disposable tree. Run the fixed test in the task worktree too (through Squeal
when it is validating) so the proof does not replace normal verification.

## Mutant report instead of the scratch worktree

The **Mutation report** comment on a pull request can stand in for the **source fix** recipe above,
and for no other recipe. The job
([`mutation-report.yml`](../../.github/workflows/mutation-report.yml)) makes small edits to the lines
the pull request changes, called mutants, and runs the package's own unit tests against each one. A
mutant that makes a test fail is **killed**. It is advisory: it never blocks a merge, and it posts one
comment that each push updates.

A mutant that restores the behavior from before the fix can only be killed by a test the pull request
adds or changes, because every older test passed against the pre-fix code on `main`. A killed
mutant of that kind is the red proof, found by the job and not by hand.

The report stands in for the recipe when all of these hold:

1. The comment names the commit you pushed, and the package that holds the fix shows no `Skipped`,
   `Stopped` or `Failed` line. A package is skipped above the limits in
   [`mutants-scope.cjs`](../../.github/scripts/mutants-scope.cjs), and when no test file of the
   package imports the changed files.
2. The fix and the regression test are in the same package. The job runs only that package's tests.
3. No mutant on the lines of the fix survived or was left `Not covered`. Each one that remains is
   named in the PR body with the reason it does not change behavior.
4. The collapsed list of killed mutants holds one on a line of the fix that restores the old
   behavior: a guard's condition replaced by its old value, the guarded block emptied, or the new
   operator swapped back. A `Timed out` mutant does not count, because a hang is not a failing test.

Cite the comment in the PR body: the commit, then the file, line and mutator of the killed mutant.

The report does **not** stand in when the fix is outside `packages/*/src` (scripts, workflows,
configuration, documents), when the change only deletes code or only edits a module-level constant
(the job skips static mutants), when the change is test-only or removes a hidden dependency, when the
test pins timing or load, or when no pull request exists yet. Use the matching recipe then. To run
the job by hand, do it in a scratch worktree where Squeal does not run, because Stryker edits files in
place: `STRYKER_PROJECT=<package> pnpm exec stryker run --mutate 'packages/<package>/src/<file>.ts:<from>-<to>'`.

## Test-only change that removes a hidden dependency

A **test-only change that removes a hidden dependency** needs this proof even
when no failure has been observed. This includes dependence on a catalog, a host
setting or a default the test did not write. Run the old test with that dependency
absent and confirm it fails for that reason, then run the fixed test under the
same conditions and confirm it passes. Cite the evidence in the PR body, in the
[E2E form](../../packages/web/e2e/README.md#the-rules-the-ratchet-enforces); for
non-browser tests, cite the runner output instead of a bundle.

## Test-only fix

For a **test-only fix**, reproduce the old test's defect under the same conditions
as the fixed test. There is no source fix to remove. Keep both versions out of the
watched test paths: create an ignored scratch copy with `git show`, then select it
with an explicit scratch Vitest config. For a server test, from the repo root:

```bash
proof_base=<pre-fix-commit>
mkdir -p .ai/qa
proof_dir=$(mktemp -d .ai/qa/red-proof.XXXXXX)
git check-ignore "$proof_dir/before.test.ts"
git show "$proof_base:packages/cezar/src/path/to/test.test.ts" > "$proof_dir/before.test.ts"
```

In that directory, write `vitest.config.ts` with this content:

```typescript
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import server from '../../../packages/cezar/vitest.config.ts'

export default defineConfig({
  ...server,
  root: fileURLToPath(new URL('../../../packages/cezar/', import.meta.url)),
  test: {
    ...server.test,
    include: [fileURLToPath(new URL('./before.test.ts', import.meta.url))],
    passWithNoTests: false,
  },
})
```

Adapt the package config for other workspaces. In the scratch test, adjust relative
imports and fixture paths to their original absolute locations; account for uses
of `import.meta.url` and colocated mocks too. Preserve the assertions and the
reproduction conditions. Run `npm test -- --config "$proof_dir/vitest.config.ts"`.
Inspect the failure, then replace only the scratch test with the fixed version,
apply the same path adjustments, and run the same command for green. A load-related
failure needs its original load or a controlled reproduction; an unrelated import
error, empty test selection or ordinary passing run is not red proof. Scratch tests
outside a package root can lose `console.log` output; use assertion failures and
captured runner output as evidence, not the presence or absence of a log line.
Remove the scratch test and config after saving the evidence (`rm -r "$proof_dir"`).

These recipes leave the task's tracked source and test files in place, so Squeal
never runs a temporarily swapped version. Ignoring a scratch file alone does not
exclude it from a test runner: keep it outside the package's test include patterns
and use the explicit scratch config only for the manual proof.
