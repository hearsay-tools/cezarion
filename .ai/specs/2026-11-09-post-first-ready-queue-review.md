# Post-first-ready provider proof for queue admission

Owner decision: wait for post-ready review, 2026-11-09. Subject: hearsay-tools/cezarion#3046.

The first ready transition on hearsay-tools/cezarion#3050 and
hearsay-tools/cezarion#3031 preceded a new same-head CodeRabbit execution.
Queue entry raced that execution. A pending provider review correctly returned
the PR to draft, and queue admission then refused the draft. Later ready
transitions did not start a new execution in the observed cases.

The existing guarantee remains: only current-head native CI, trusted provider
admission, resolved threads, valid queue membership and effective rules permit
queue admission. Readiness still demotes a head when its fresh proof fails.
The new prerequisite prevents the initial historical green provider check from
being enough to queue before the first post-ready review.

For actual provider review evidence, the newest trusted current-head check must
start strictly after the PR's first-ever ready event and complete successfully.
The first event applies across later ready transitions and new heads. An open,
non-draft PR with no ready event was opened ready, has no cutoff, and uses
existing current-head admission alone. Malformed or unreadable proof blocks
admission. The existing verified no-files,
release-stamps and upstream-ledger exceptions remain unchanged.

| Case | Before | After |
| --- | --- | --- |
| First ready, only earlier successful provider check | Could admit | Refuse: provider review pending after first ready |
| First ready, new provider execution pending | Refuse | Refuse |
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
