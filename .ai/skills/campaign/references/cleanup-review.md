# Cleanup review

The coordinator's review is the campaign's scope gate. When the Phase 2
coordinator of hearsay-tools/cezarion#2051 skipped the diff reads, it rewrote 8 refactor squash
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
answers held across hearsay-tools/cezarion#2051:

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

## Scope acceptance

At the current head, confirm only the issue's files, named test files and
necessary length baseline changed. Compare changed names and exports with the
approved list; record a reason for each extra. Grep every required seam at that
head. Every non-verbatim hunk needs your written approval and an order table in
the body. The Verification claim (verbatim or risky) must match the diff.

Done when every commit through the head satisfies this review and each finding
is resolved. Record that head and evidence for the campaign's landing step.
