# Review

The coordinator's review is the campaign's quality gate. When the epic 2051
Phase 2 coordinator skipped the diff reads, it rewrote 8 refactor squash
subjects on main as feat. With the reads, every rebased patch matched the
reviewed one.

## Commit review

For each commit, as it lands:

- The changed names match the issue's list. Each extra helper or constant has a
  reason.
- Moved bodies are verbatim. Read the removed and the added hunk of at least two
  bodies side by side, and every non-verbatim hunk in full, comments included.
- Every removed doc-comment line reappears at the code's new home (grep it).
- Every seam the issue names still exists: delegators, getters, calls routed
  through the facade.
- A dropped promise (`void x()`) still gets an `async` wrapper, so a rejection
  keeps reaching Node's unhandled-rejection path.
- No new blank-line padding, no wrong length pin, no missing direct import.

Send all findings for one commit as one `cez message request`.

## Standard answers

Workers ask about every helper and constant the issue does not name. These
answers held across epic 2051:

- A constant the facade still reads: pass it as a constructor value.
- A helper local to the facade: pass it as a host callback.
- A private constant only the moved code reads: move it.
- A pure helper that several modules need: move it to the lowest module that
  all of them import.
- A member a test calls, spies on or reaches unbound from the prototype: keep a
  delegator on the facade (find the callers with grep).
- A module-namespace `vi.spyOn` is process-wide: keep a per-instance facade seam
  when a fixture stubs one instance.
- A length pin: `FILE_LENGTH_UPDATE=1` only lowers pins; after a rebase, start
  from main's pin.

## Merge gate

Run every item on the exact head `H` of PR `P` before the merge:

1. **Files:** `gh pr diff P --name-only` lists only the issue's files, the
   length baseline and the test files the issue names.
2. **Scope:** the changed names match the issue's list; every extra has a reason
   in the body. No new export beyond what the issue names (compare the export
   lists of `H` and main).
3. **Seams:** every seam the issue names exists at `H` (grep).
4. **Behavior:** the commit review holds for every commit up to `H`. Each
   non-verbatim hunk has your written approval and an order table in the body.
5. **Rebase:** after a rebase, the patch equals the reviewed patch, except the
   baseline and import lines (diff the two diffs).
6. **CI:** every required check passes on `H`. A red called a flake names its
   tracking issue.
7. **Review:** the automated review ran on `H` and 0 threads are open. A
   `needs-qa` label also needs `qa-approved`.
8. **Owner paths:** `node .ai/skills/auto-merge/check.mjs --title "<title>"`
   shows no "gate or test harness" reason and the diff leaves `AGENTS.md`
   alone, or the owner approved the merge. Add an owner-approved label such as
   `baseline-growth` before the worker's first push; `classify-pr` reads live
   labels.
9. **Body:** it has every section of the worker brief, and its Verification
   claim (verbatim or risky) matches the diff.
10. **Main:** main CI is green, or it fails only in "Publish npm snapshot".

Required checks are not strict. A green PR that `git merge-tree` shows clean
against current main, with no semantic overlap, merges without a rebase.
