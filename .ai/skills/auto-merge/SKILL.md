---
name: auto-merge
description: Auto-merge for pull requests into `main`. Use when opening a pull request, and after each push, CI result, review round or draft/ready change on one you opened with the `auto-merge` label.
---

# Auto-merge

The owner runs `main` on the dev channel for a while before each release, so a
merge reaches dev within minutes and the owner meets it there before users do. A
pull request that passes this decision merges on its own once its required checks
pass. Every other pull request waits for the owner, as before.

## Decide

Commit everything, then run from the repository root:

```bash
git fetch origin main
node .ai/skills/auto-merge/check.mjs --title "<PR title>"
```

The script checks the title type, the size (at most 10 files and 400 lines) and
the never-lists of paths and diff content. Its constants are the rules. Then
confirm the rules the script cannot see:

- The owner has not paused auto-merge:
  `gh api repos/hearsay-tools/cezarion --jq .allow_auto_merge` prints `true`.
- You are opening this PR in this task, from a branch of
  `hearsay-tools/cezarion`, into `main`.
- The user did not ask to review the PR before it merges.
- Every issue the PR closes (`Closes #N`, `Fixes #N`) is complete with this PR.
  When part of an issue stays open or moved elsewhere, write `Refs #N`.
- Every instruction an agent session reads keeps its wording: prompt strings,
  tool descriptions and guidance text, wherever they live (for example in
  `workflows/run.ts` and `workflows/waits.ts`). The script covers only the files
  that are mostly prompt text.

**Done when** the script prints `QUALIFIES` and every rule above holds: read
[`.ai/skills/auto-merge/references/open.md`](references/open.md) and open the PR
as it says. A rule you are unsure of does not hold. On any other outcome, open the
PR the usual way, without the label; this skill is then finished.

## Labeled PRs

After each push, CI result, review round and draft/ready change on a PR you opened
with the `auto-merge` label, read
[`.ai/skills/auto-merge/references/follow.md`](references/follow.md) and act on it.
