# Footer keyboard focus proof — hearsay-tools/cezarion#1510

## Finding

The reproduced `focused: false` failure checks a different button from the one
that received Tab. History prepends an older page between positioning the
keyboard start and sampling the result. A fresh `querySelector` then names the
first button on that older page. Tab still moves from the start span to the
original button, which stays connected and focused.

This report records a matching reproduction on the original affected application,
not only a replay against today's application. It adds evidence for existing test
repairs. No executable test statement or product behavior changes in this PR.

## Pinned revisions

| Role | Commit |
| --- | --- |
| Original affected product and test (`proof_base`) | `9d41b6faaf03cf8ad7583f8d556f00e73032c7ac` |
| Node retention repair, PR hearsay-tools/cezarion#1507 | `94fe24997d051fae20aaa2ee5ae2c57959b5d892` |
| History readiness repair, PR hearsay-tools/cezarion#1568 | `928bf1aeaf3ce06b835c3c7b2324e1d20d3dd78e` |
| Current product and fixed test used for this proof | `323019f26155f0c7593117b18b6b0fc3f0bfa111` |

The issue was opened at 2026-10-23 11:09:30 UTC. Node retention landed in main
at 12:06:45 UTC that day. Both the issue's main commit and its named fork PR
hearsay-tools/cezarion#1497 heads (`08b2d61cb` and `01db29ffc`) still re-query the
button. An older triage note incorrectly treated retention as preceding this
issue's evidence. `git show <commit>:packages/web/e2e/session-footer.e2e.ts`
settles that chronology.

## Controlled method

All probes run on logical CPU 1 with exactly two owned busy loops. Every process
has a 180-second outer timeout and a five-second kill grace. Builds finish before
load starts. The original checkout has its own frozen-lockfile dependency install,
E2E build, descriptor and fixture server. No Squeal daemon runs there. Current
manual probes run inside `squeal hold`, which restores validation on exit.

The scratch config imports the package's browser config and selects exactly the
ignored scratch test. The scratch copy changes import/artifact paths and adds
read-only diagnostics: a WeakMap assigns node identities; capture listeners record
focusin/focusout/keydown/keyup; samples record active, retained and freshly selected
nodes before/after Tab and after removing the start span. A `finally` block writes
the trace after the unchanged assertion. Historical variants retain an extra node
reference for diagnostics only; their assertion still reads the fresh selector.

Instrumentation adds command round trips and can change race frequency. Both sides
of each comparison use the same instrumentation. The final acceptance uses the
tracked, uninstrumented test. There is one real Tab in every case, no target focus,
no assertion retry, no success matcher, and no altered expected outcome.

## Results

| Product | Test variant | Result |
| --- | --- | --- |
| Current | Current with trace | 3/3 passed |
| Current | Original with trace | 1/3 failed with all three fields false; 2/3 passed |
| Current | Original plus retained-node assertion only | 3/3 passed |
| Current | Original plus existing history readiness setup only | 3/3 passed |
| Original | Original with trace | 5/5 failed with all three fields false |
| Original | Current with trace | 5/5 passed |
| Original | Full original spec with trace | 1/3 failed at the all-false keyboard assertion; 2/3 passed all eight tests |
| Current | Current uninstrumented, consecutive CPU 1 runs | 10/10 passed |
| Original | Original with 250 ms older-response delay | 2/3 failed with clear/hit true and focused false; 1/3 passed without requesting an older page |
| Original | Current with the same 250 ms delay | 3/3 passed; each observed the delay and page 2 before Tab |

The retention-only variant changes only the node read by the final expression.
Two of its three traces show a prepend and distinct retained/selected nodes at
the final sample; both pass. The readiness-only variant copies the existing
explicit history load and completion wait, removes the two wheel triggers, and
keeps the original fresh-selector assertion. It does not copy node retention or
the current start-focus wait. These controls distinguish the two repairs; they
do not claim that retention alone fixes every layout race.

## Original-build trace

The first original-build failure has this sequence (page `performance.now()`):

| Time, ms | Observation |
| --- | --- |
| 6525 | Setup ends on the start span; target is node 2, `git log --oneline -36`; page 1 |
| 6643 | Before Tab: start remains focused; page 1 is busy |
| 7177 | Tab keydown: page 2 has loaded; fresh selector names node 4, `git log --oneline -11` |
| 7180 | Focusin reaches node 2 |
| 7284 | After Tab: node 2 remains active and connected |
| 7320 | Removing the start span leaves node 2 focused |
| 7882 | After the failing assertion: node 2 is still focused; selector still names node 4 |

Every original-build failing trace ends with these distinct nodes and the original
node focused. The assertion is exactly:

```text
AssertionError: expected { clear: false, focused: false, …(1) } to deeply equal { focused: true, clear: true, …(1) }
```

The full failure-bundle leaf is
`.ai/qa/failures/before.test.ts/scrolls-a-keyboard-focused-transcript-control-above-the-desktop-footer-1/`.
Each run's bundle is copied before the next run clears it. The first original
`probe.json` identifies `Rangit log --oneline -36` as the active element;
`trace.json` proves that the final selector names `Rangit log --oneline -11`.

## Reproduction and durable evidence

The published Cezar snapshot is `1510-focus-evidence.zip` (3,347,804 bytes),
artifact `3132f538-8de8-41a2-9396-3dc5f40b154d` in task
`711410a2-cd20-4a16-8ca9-2d0261905ac4`. Its SHA-256 is
`d1ecd4d2c5ebd5ef58514ba71ffe14c32ccccd966ef26cc9068c385536f70484`.
Its cockpit route is
`/p/cezar/tasks/711410a2-cd20-4a16-8ca9-2d0261905ac4/files?artifact=3132f538-8de8-41a2-9396-3dc5f40b154d`.
The snapshot survives disposable-checkout cleanup; its lifetime follows task history.
 Web typecheck passed. The code-quality
check passed 1/1 changed functions (complexity 1, CRAP 1, body coverage 100%);
its full current footer spec passed all eight tests. Squeal reported current
passing footer and wait-discipline results at revision 13. No full-suite local
pass is claimed.

The evidence bundle includes `prepare.py`, the scratch configuration, exact
source snapshots, bounded runner scripts, logs, traces, copied failure bundles,
build hashes and process cleanup checks. `prepare.py <revision>` reads the pinned
tracked test with `git show`, adjusts paths and adds the same diagnostics.

From an independently installed and bootstrapped checkout, the single probe is:

```sh
python3 .ai/qa/1510-focus/prepare.py 9d41b6faaf03cf8ad7583f8d556f00e73032c7ac
timeout --kill-after=5s 180s taskset -c 1 bash .ai/qa/1510-focus/run-one.sh -t 'scrolls a keyboard-focused'
```

For fixed proof, select `323019f26155f0c7593117b18b6b0fc3f0bfa111` in the same
checkout with the same product build. The readiness and retention controls are
fully specified in `isolate.sh`. All attempts are counted; failures are not
retried to turn a red test result green.

## Second signature and completion boundary

The originating transcript survives at
`/home/agent/projects/cezar/.ai/cezar/runs/ce3eddd2-7a9b-457e-85c1-09a16deb9ecb.ndjson.br`.
Sequence 800 records Squeal run `428f0c95-e278-436d-a977-ef0e3547cfce`, revision 18,
head `08b2d61cb`, at 2026-10-23 09:30:50.971 UTC. Its exact result is
`clear: true, focused: false, hit: true`. Sequence 914 records the same tuple in
the original-main comparison. The referenced Squeal run directory and original
task/disposable checkouts no longer exist. Sequence 897's diagnostic sample had
all three expected booleans true; its extra diagnostic fields caused its own
`toEqual` failure, so it is not focus-failure evidence.

Three full-spec original-build probes preserve the preceding viewport, activity
and draft cases. One fails with the all-false selector mismatch; two pass all
eight tests. The following ignored boundary probe reproduces the other tuple.

The probe holds the actual older-history response in a browser fetch wrapper and
releases it before Tab, on keydown, after Tab, or after removing the start span.
It observes page completion before the original settled assertion. The response
body, application code, expected result and real Tab are unchanged.

| Response released | Counts | Original assertion result |
| --- | --- | --- |
| Before Tab; page completion observed before Tab | 2/2 failed | `focused:false, clear:false, hit:false` |
| On Tab keydown | 2/2 failed | `focused:false, clear:true, hit:true` |
| After Tab | 2/2 failed | `focused:false, clear:true, hit:true` |
| After removing the start span | 2/2 failed | `focused:false, clear:true, hit:true` |

A preceding diagnostic after-Tab probe also reproduced the clear-true tuple (1/1).
Its trace holds the response at 3865 ms, records Tab focusin on original node 2 at
3921 ms, and releases the response at 3974 ms. Page 2 is present by 4336 ms.
After the failing assertion, node 2 remains active and connected at y=8419.14.
The fresh selector names node 4 at y=317.17–356.67, between header bottom 186 and
footer top 488. This is why clear and hit are true while focused is false.

Three earlier boundary setup attempts never observed a held response; a fourth was interrupted when that batch was stopped. They
reached no assertion and are excluded from the table. They remain in the archive.
The successful diagnostic and all eight matrix probes use a sampled gate state
(`waitForValue`) and record the held response before proceeding. These misses
do not establish a fault in the original predicate: the original wheel-driven
setup can finish without requesting an older page, as the delayed proof shows.

A final matched proof uses the same bounded 250 ms older-history response delay
in the original and current scratch tests on the same original application build.
It adds no history-completion wait to the original test, and preserves every
original assertion. Two of three original attempts fail with the exact
clear-true/focus-false/hit-true tuple. The other passes without issuing an older
history request, so it exercises no delayed response. All three fixed attempts
observe the delay, complete page 2 before Tab, and pass. The fixed before-Tab
samples occur at 4383, 4326 and 4430 ms; each reports two retained pages.

## Limits

Both reported boolean tuples now have matching reproductions on the original
application. They occur on different sides of history completion, with the same
selector-identity mismatch. The late-page case also moves the truly focused
button below the viewport; node retention alone does not repair that geometry.
The existing history readiness setup prevents that ordering.

The original raw failing traces from 2026-10-23 are unavailable, so this cannot
identify the exact timing of each historical occurrence. The controlled traces
show no dropped Tab. There is no new wait, product change, setting or weakened
assertion. The final paired proof meets the parent-approved completion criterion;
the draft PR may close the issue after parent review and merge.

## Resource and source checks

All 108 recorded burner PIDs were absent after the last proof. Both original and
current application build hashes match the manifests captured before the later
probes. The original fixture environment was stopped through `test-env-down.sh`.
The disposable checkout is removed only after publishing the evidence snapshot.

All ten acceptance processes verified the same source SHA-256 before and after
their run. The final spec differs only in full-line comments. Removing only
empty lines and full-line `//` comments from the accepted and final files leaves
identical source, including the browser expressions and every assertion.
