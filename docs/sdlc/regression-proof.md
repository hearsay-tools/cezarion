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

## Test-only change that removes a hidden dependency

A **test-only change that removes a hidden dependency** needs this proof even
when no failure has been observed. This includes dependence on a catalog, a host
setting or a default the test did not write. Run the old test with that dependency
absent and confirm it fails for that reason, then run the fixed test under the
same conditions and confirm it passes. Cite the evidence in a comment at the
changed test site, using the [E2E provenance form](../../packages/web/e2e/README.md#the-rules-the-ratchet-enforces):
the reproduction command and conditions, and both before/after counts with their
totals. For browser failures, include the full failure-bundle leaf path and a
durable citation as that form requires; for non-browser tests, cite the captured
runner output instead.

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
