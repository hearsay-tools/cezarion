# Keyboard focus diagnosis for hearsay-tools/cezarion#1510

Parent approved diagnosis on 2026-10-27 (request `11e06d27-e37b-49c7-9a21-cb53d6f6de23`).

Proof base: `323019f26155f0c7593117b18b6b0fc3f0bfa111` (fresh origin/main when creating the issue branch; original task HEAD was e53bef4e9997e4dde9794f08b09c62900fb82eed).

Owned paths: `packages/web/e2e/session-footer.e2e.ts`, this plan, and ignored `.ai/qa/1510-focus/` proof files.

1. Preserve the current test in an ignored scratch copy, adjust import paths, and record focus events plus activeElement before/after the real Tab and removal of the start span.
2. Probe with two bounded busy loops on CPU 1. Escalate to full-spec context and historical source at `9d41b6faa` if needed. Read the trace rather than inferring a failed Tab from the final boolean.
3. Send the exact repair and matching failure to the parent before editing the tracked spec. Only an existing product readiness signal is in scope. No direct target focus, retries, sleeps, weakened assertions, shared helper or product edits.
4. Prove old failure and fixed pass with the same application build, instrumentation, and load. Retain every assertion. Require ten consecutive one-CPU acceptance passes and current targeted Squeal validation.
5. Open a draft PR targeting main only when evidence supports the repair; fix attributable CI/review findings. Do not enable auto-merge or close the issue without the matching proof.

The historical test re-queries the first button after Tab. Current code retains the original node and waits for history readiness. These are separate explanations to investigate, not proof that the historical failure is fixed.

## Evidence-based scope decision

On 2026-10-27 the parent approved completion through evidence for the existing fix
(request `24fe5fb7-0305-4c13-bfe4-a2be456fe767`), provided the work isolates retention
and readiness, checks the original affected product, runs ten current uninstrumented
loaded passes, and preserves unresolved cases. The original product reproduced
the all-false selector mismatch in 5/5 probes; current test on that same build
passed 5/5. No executable test statement needs a new repair.

Final tracked scope adds `.ai/specs/2026-10-27-1510-keyboard-focus-proof.md` and
updates only provenance comments in the owned spec. The report records all attempts,
the exact revisions and limitations. A later parent-approved boundary investigation reproduced the clear-true/focus-false
case on the original build. The identical 250 ms response-delay comparison failed
2/3 original attempts (one non-reproduction) and passed 3/3 fixed attempts. Parent
approved a closing reference once this paired proof and the ten acceptance runs
passed (request `ab4927f9-f7cd-48b8-98be-83570cc2e4f6`). The report retains the
missing-original-traces limitation and every setup miss. No new executable repair
is needed; parent review and exact-head CI remain the merge gate.
