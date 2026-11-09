# Post-first-ready provider proof for queue admission

Owner decision: three-minute settle window, 2026-11-09. Subject: hearsay-tools/cezarion#3046.

The first ready transition on hearsay-tools/cezarion#3050 and
hearsay-tools/cezarion#3031 preceded a new same-head CodeRabbit execution.
Queue entry raced that execution. A pending provider review correctly returned
the PR to draft, and queue admission then refused the draft. Later ready
transitions did not start a new execution in the observed cases.

The existing guarantee remains: only current-head native CI, trusted provider
admission, resolved threads, valid queue membership and effective rules permit
queue admission. Readiness still demotes a head when its fresh proof fails.
The new prerequisite bounds the interval in which a first-ready event can start
a new provider execution before queue admission.

Use the newest trusted current-head execution. If it started strictly after
first ready, require its successful completion. Otherwise refuse admission while
`now - firstReady < POST_READY_SETTLE_MS`, then use existing current-head
admission. The named constant is three minutes. Observed restarts took 33–40 s
on hearsay-tools/cezarion#3050 and hearsay-tools/cezarion#3031; no restart appeared
8+ minutes after first ready on hearsay-tools/cezarion#3066. CodeRabbit provides
no signal that it will not re-review. The owner explicitly approved this bound;
it cannot prevent a provider execution starting after the window closes.

The first event applies across later ready transitions and new heads. An open,
non-draft PR with no ready event was opened ready and uses existing current-head
admission without a cutoff. Malformed or unreadable proof blocks admission.
Trusted no-files, release-stamps and upstream-ledger exceptions remain unchanged.

| Case | Before | After |
| --- | --- | --- |
| First ready less than three minutes ago, only earlier successful review | Could admit | Refuse: provider re-review settle window open, with deadline |
| First ready at least three minutes ago, no newer execution, older success | Could admit | Existing current-head admission decides |
| First ready, new provider execution pending, even after three minutes | Refuse | Refuse: provider review pending after first ready |
| Newest post-first-ready execution failed | Refuse | Refuse; window expiry does not override failure |
| First ready, new provider execution succeeds, native CI green, threads resolved | Admit | Admit |
| Later ready, same current-head post-first-ready success | Admit | Admit without waiting for another review |
| New head after first ready, reviewed on push | Admit if all proof passes | Admit if all proof passes |
| Never-ready draft | Refuse | Refuse |
| Opened ready, same-repo or fork, no ready event | Current-head admission | Same current-head admission; no cutoff |
| Malformed or unreadable first-ready proof for actual review | No ordering check | Refuse |
| Trusted no-files, release-stamps or upstream-ledger exception | Existing exception policy | Same exception policy |
| New push, required failure, unresolved thread | Refuse or demote | Same behavior |

The shared queue reader is `.github/scripts/queue-coderabbit-admission.cjs`.
Queue admission calls it; `.ai/skills/land-pr/SKILL.md` requires the same proof
before enqueueing. The general CodeRabbit reader and readiness retain their
existing admission rules. Its added provider-start timestamp carries the exact
check evidence already protected by its stable reread.
