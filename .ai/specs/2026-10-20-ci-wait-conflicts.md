# Resolve a CI wait on an observed PR conflict

Proposal for [hearsay-tools/cezarion#1339](https://github.com/hearsay-tools/cezarion/issues/1339). Status: **accepted for implementation in this session on 2026-10-21**. After the design and trade-offs were presented with accept/amend/reject choices, the human instructed this same task to continue autonomously to completion without further confirmation. Implementation follows that instruction; do not relabel to dispatch another task.

## Evidence and eligibility

Investigation on 2026-10-20 against freshly fetched `origin/main` at `9adb3f1d9beda70f61e76d185db385d88196562f` (also this task's starting HEAD):

- Current issue is OPEN, authored by `wjarka`, unassigned, has `friction`, exactly one handling label (`friction-design`) and one recognized category (`friction-semantics`). No comments, assignment or claim events, linked implementation PR, or open PR mentioning the issue were found. The local run store contains only this task as a task about this issue. Automation receipt `45c71fce-b5cb-488c-9d3a-64507ba12962` belongs to this run (`25bebea2-6e4f-492b-81d8-315ce7efa64b`); it is excluded from competing claims. This is a point-in-time check, not a global distributed lock.
- `packages/cezar/src/ci-wait/github.ts`: `resolve` requests only `url,number,headRefOid`; `head` delegates to it. `checks` requests check name/state/link/bucket. Neither requests mergeability.
- `packages/cezar/src/ci-wait/supervisor.ts`: snapshot reads head/checks/head. While `gh pr checks --watch` runs, the 30-second probe reads only head. Check outcomes are decided exclusively from check buckets. `packages/contract/src/ci-wait.ts` admits no conflict outcome or mergeability fields.
- `packages/cezar/src/ci-wait/scheduling.test.ts` already pins pending-watch head probes, missing-check discovery, deadlines, head-change priority and watcher capacity. This verifies a missing supported recipe: a stable head with pending checks and a newly conflicting base has no conflict predicate anywhere on its execution path. It can terminate at deadline, error or cancellation; it cannot report a conflict. No destructive conflict was induced on a live PR.
- The report cites [hearsay-tools/cezarion#1317](https://github.com/hearsay-tools/cezarion/pull/1317) after [hearsay-tools/cezarion#1318](https://github.com/hearsay-tools/cezarion/pull/1318). The current GitHub read of the former is OPEN / MERGEABLE / CLEAN, head `15f00905101fb1c54270ea9f07580213608fe4ed`. This does **not** reproduce or prove the historical timing; that incident remains reporter evidence. The independently verified missing recipe supports a design investigation.

The proposed outcome adds meaning to a wait, so this remains design work even if the issue also has a `bug` label. No approved contract promising conflict detection was found in the current executable contract.

## Load-bearing guarantees

Preserve the fixed registered head identity and before/after head checks: results for a different head must not be attributed to the registered revision. Preserve the default 1,800-second deadline (maximum 7,200), 30-second probes, 60-second check discovery window, bounded transient retries (1/5/15 seconds), ten-second query limits, four concurrent watchers, query semaphore and owned-child termination before releasing capacity. A queued watch keeps its original deadline.

An observation is external evidence, never merge approval or task completion; all reported checks passing still does not prove every expected workflow exists. Unknown metadata must not become a confident conflict. Existing check failure/cancellation/skip/no-check behavior remains useful.

`RunManager.startCiWatch` validates results; `settleWait` retries failed persistence; `resolveWait` uses `commitWait` to save both the resolved wait and lifecycle input before queuing a wake. Keep this crash boundary and wait-ID deduplication. `workflows/waits.ts::waitResultText` already carries the structured result to the model with the approval caveat. Never depend on an `ActiveRun` entry to persist a resolution.

## Accepted behavior

Extend the existing bounded PR metadata query to include GitHub's `mergeable` and `mergeStateStatus`. Use the richer metadata read in place of current head probes, including initial/final snapshot reads and the 30-second probes while the checks watcher is still running. Adding fields to the existing query avoids another recurring process or polling loop. Keep registration receipt identity unchanged; conflict is a result delivered through the normal wait lifecycle after registration.

Add `conflicting` to the shared `ciWaitOutcomeSchema`. Add optional `mergeable` and `mergeStateStatus` fields to `ciWaitResultSchema`, defined and inferred in the contract. `mergeable` accepts MERGEABLE, CONFLICTING, UNKNOWN. Bound `mergeStateStatus` to a sanitized string of at most 64 characters, allowing future GitHub advisory states without giving them new authority. Validate the upstream metadata independently at its boundary; absent or null mergeability is UNKNOWN. A future unrecognized mergeable value also normalizes to UNKNOWN. Wrong JSON types remain malformed data under existing error handling. New observations after a successful metadata read include both fields, normalizing absent/null advisory state to UNKNOWN. Old observations and failures before a metadata read can omit them; absence means unavailable, never MERGEABLE.

Resolution precedence for a completed, valid observation:

1. Existing caller cancellation/deadline authority applies; a result committed earlier is not overwritten.
2. A head differing from the registered head yields `head_changed`, even when also conflicting.
3. Explicit `mergeable: CONFLICTING` at the registered head yields `conflicting`, ahead of passed/failed/no-check outcomes. Retain available checks as context and a bounded diagnostic explaining the PR conflicts with its base.
4. Otherwise apply existing check outcomes, discovery and retry rules. UNKNOWN never resolves **because of mergeability**: it can still accompany a normal passed, failed, no_checks, deadline or error result. `DIRTY`, `BLOCKED`, `BEHIND`, or contradictory advisory state alone does not trigger a conflict wake.

Metadata from the final snapshot read controls attribution; a stale earlier conflict must not override the final read. During a pending watch a single validated CONFLICTING probe suffices, with the same head in that response; terminate and await the owned watch child before returning. Store the observation timestamp and observed mergeability as evidence of that moment, not a guarantee the conflict persists. Cancellation racing with a query follows the existing cancellation checks. No automatic rebase, merge, push, CI rerun or repeated conflict wake is added. The awakened agent may inspect and act only within the task's existing authority, or ask the human. The outcome itself grants no repair permission.

## Defaults, authority and cost

Conflict detection applies to all explicitly registered CI waits by default, including the deprecated `cezar_wait_for_ci` alias. It has no new env var, opt-in, required config, daemon, credential or permission. It reads only the same PR through existing `gh` authentication and safe argument arrays. No PR content becomes instructions.

There are no additional scheduled queries at steady state; existing head reads carry slightly more metadata. GitHub can do additional mergeability computation, so query latency can change within existing query/deadline bounds. Detection is normally within one 30-second probe plus bounded query/queue delay, not an SLA during GitHub outage. A conflict wake can spend model tokens sooner than a deadline wake; it uses existing wake admission/accounting and never bypasses budgets. No extra recurring model wakes or worker launches.

## Persistence, compatibility and user-visible result

Use the existing result object in both unified and legacy CI wait records and the existing atomic resolution/input commit. No new run status, database table, base-SHA identity, migration or periodic metadata writes. Older stored results remain parseable because metadata fields are optional. Recovery of an open wait fetches current metadata; recovery of a resolved wait delivers its saved result without reclassification. Do not discard a queued conflict if the PR later becomes clean.

A new enum outcome is not backward compatible with old strict readers. A coordinated service/contract/api-client/cockpit release is required; old binaries cannot be promised to parse persisted `conflicting` results after downgrade. Record this limitation in release notes rather than weakening strict validation. Before implementation, search every result consumer, both legacy and unified records, fixtures, UI and exported client schemas; add an exhaustive branch wherever needed. UI and model-facing text must name a merge conflict distinctly from failing CI and retain the observation/approval caveat. No new action button or repair workflow is needed.

## Transitions out

Unified wait states below are the durable states; supervisor queued/watching are activities within an open wait. This proposal adds an outcome, not a new run status.

| State | Trigger | Who or what fires it | Behavior at shipped defaults |
| --- | --- | --- | --- |
| Open CI wait, queued | Slot available | Existing supervisor semaphore | Starts observing under original deadline |
| Open CI wait, queued | Deadline/cancellation | Existing abort/deadline owner | Existing terminal result/cancellation; no fifth watcher |
| Open CI wait, watching | Same-head CONFLICTING | Metadata snapshot or 30-second probe | Stop/await watch child; persist `conflicting` and lifecycle input atomically; queue existing wake |
| Open CI wait, watching | Head changed | Metadata probe/snapshot | Existing `head_changed` result, higher priority than conflict |
| Open CI wait, watching | Terminal checks or discovery expiry | Supervisor | Existing result unless explicit same-head conflict takes priority |
| Open CI wait, watching | UNKNOWN mergeability | GitHub response | No mergeability exit; ordinary check/discovery/deadline exits remain enabled |
| Open CI wait, watching | Retry exhaustion, fatal query failure, deadline | Supervisor | Existing bounded error/deadline resolution |
| Open CI wait | Cancel, Finish, run failure or deletion | Existing lifecycle owner/human | Existing cancellation rules; late watch result cannot resurrect wait |
| Open CI wait, checkpoint unavailable | Resolution write fails | Existing persistence retry | Retain accepted result for retry; no false delivered result; restart may reobserve uncommitted work |
| Open CI wait, no live session after restart | Recovery scans saved wait | RunManager recovery | Reattach observation under original deadline; persist outcome/input without `active.get`; expiry still exits |
| Resolved CI wait, input undelivered | Safe turn boundary or restart recovery | Existing wake scheduler/admission | Deliver saved input once logically by stable wait ID; resume a continuation when no session exists; existing capacity/accounting gates apply |
| Resolved CI wait, input undelivered | Budget/admission prevents continuation | Existing lifecycle gates | Preserve owed input; retain existing human/budget recovery route, no new bypass |
| Delivered wait | Input acknowledged | Existing delivery checkpoint | Terminal history; another wait requires a new explicit registration |
| Cancelled wait | Already cancelled | Existing lifecycle | Terminal history; no automatic exit or resurrection |

During implementation verify these retained transitions against current recovery code and parity tests; do not silently replace a working default with a knob.

## Alternatives and trade-offs

- Keep checks-only semantics and tell agents to query mergeability manually: smallest change, but retains the silent pending-watch gap and adds model polling cost.
- Observe metadata but never resolve: useful context only when something else ends the wait; fails the central pending-watch use case.
- Resolve on `mergeStateStatus: DIRTY` or all non-clean states: catches more blockers but conflates policy/reviews/lag with textual conflicts. Reject for this change.
- Require two conflicting polls: reduces transient-report sensitivity but adds delay and another observation dependency. Recommend one explicit observation, clearly timestamped.
- Replace the checks watcher with broad PR polling: larger operational change that risks existing cleanup, backoff and check discovery guarantees. Extend the existing metadata probe instead.

## Acceptance criteria and verification plan

No product tests are changed for this proposal. On approved implementation:

1. Add deterministic metadata fixtures for MERGEABLE -> CONFLICTING with unchanged head during a pending native gh watch. Assert conflict result before deadline, child reaped, slot released, metadata and head attribution retained. Prove this regression fails without the fix. Cover initial conflict, empty checks, already-passed/failed checks and final-snapshot conflict.
2. Pin UNKNOWN/null/absent/future metadata behavior, advisory-only DIRTY/BLOCKED/BEHIND, contradictory fields, malformed JSON, query retries, errors and output/time bounds. UNKNOWN must not independently resolve or reset the original deadline; normal terminal checks still resolve. Assert query counts and unchanged 30-second cadence.
3. Cover head changing before/after check snapshot and conflict together; `head_changed` wins. Keep existing discovery, queued timeout, cancellation, watcher capacity and retry regression guards.
4. Add exhaustive `RUNNER_IDS` / `HARNESS_ADAPTERS` native-wire parity cells for registration, parked conflict wake, continued/recovered runs and delivery; register cells in parity guard with named executable exemptions only for real wire gaps. Include a no-live-session recovery case and tool-less result delivery. No backend-only injected-event substitute.
5. At the crash boundary read the committed run row: resolved result and lifecycle input must coexist before a wake is visible. Inject write failure, restart before delivery, duplicate completion, cancellation and later PR cleanup; prove owed observation is neither lost nor reclassified. Verify wake admission/accounting and budget boundaries are unchanged.
6. Contract tests accept old results, validate new metadata and outcome and enforce the 32 KiB cap. Check route/client parity and all discriminated/exhaustive UI consumers. Verify visible conflict wording and lack of merge-approval claims. Typecheck affected workspaces and run required build checks.
7. Before a future implementation PR changing run.ts settlement/recovery, require every core/workflows `*-parity.test.ts` suite through Squeal as mandated in AGENTS.md, plus targeted CI supervisor, scheduling, contract, store and workflow suites. Prove relevant regression red/green without clobbering unrelated edits. Report slow-tier coverage accurately. No verification gate is waived here.

The design gate was presented in this session and the subsequent human instruction was to continue autonomously until complete. Implementation and verification continue on the same task.
