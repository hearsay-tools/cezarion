# Complete worker delegation inputs, results, and lifecycle

Date: 2026-09-08
Issue: https://github.com/wjarka/cezar/issues/116
Status: Architecture approved; detailed spec awaiting owner review.

## Approved direction

Extend the owned-worker implementation landed by #138 (`252d530e`) for #111.
Keep its CLI, delegation service, scoped credentials, ordinary runs, scheduler,
owned workspaces, and event models. Do not add another delegation service.

The owner clarified the completion rule: a parent must resolve outstanding
workers before entering review. It can wait and inspect their outcomes, or
explicitly stop workers whose work is no longer needed and await termination.
Review-ready workers have finished executing; their work is neither approved nor
merged. Apply the same gate before successful `done`, including when the review
gate is disabled. Failure/cancellation still stops unfinished direct workers.

Alternatives considered: a separate results/wait service would duplicate durable
lifecycle ownership; allowing review with active workers makes readiness
premature; implicitly killing workers on success discards work without intent.

## Scope and defaults

One generation of isolated workers, explicit input transfer, backend/model
selection, typed collection, one/any/all waits, completion gating, and cleanup.
No correlated conversations, descendants, peers, shared workspaces, automatic
conversation cloning, dirty parent snapshots, automatic merging, or hard process
isolation. Those remain outside #116.

Preserve `CEZ_DELEGATION=1` opt-in and its default-off behavior. Add no required
configuration, dependency, daemon, or new environment knob. Existing limits of
32 accepted workers per parent and 1–1800 second waits (default 600) remain.
Existing commands retain their behavior unless this spec explicitly refines it.

## Inputs and accepted execution identity

Extend spawn with optional `context`, `backend`, and `model`. Keep required task,
committed baseline, and request ID. The CLI exposes corresponding flags and a
context-file option that reads an explicitly named local UTF-8 document into the
bounded context text; it never sends that local path as though it exists in the
worker. Bound the combined task/context text to 100,000 characters.

Context consists of selected text and optional typed artifact references, rather
than a copied conversation or arbitrary environment. Allow at most 32 references:
repository-relative files at the pinned baseline, or attachments already owned by
the parent run. Reject traversal, redirected/symlink escapes, missing files, and
references to unrelated runs. Repository references resolve in the worker's own
worktree; parent attachments are copied into worker-owned storage before agent
execution. Bound copied inputs to 8 MiB total. Store source identity and resolved
worker locations; copies remain inputs even if the parent later deletes its
original. No URL fetches or arbitrary filesystem-copy interface.

Resolve omitted backend to the active parent's effective backend. With the same
backend, omitted model/account/effort inherit the parent's accepted settings.
With a different backend, resolve that backend's existing project/default account
and model defaults; do not forward another provider's model, account, or effort.
Validate explicit model choices through existing model/profile rules and reject
conflicting locks or unsupported selections. An unknown provider or unavailable
accepted identity is an explicit error, never a silent fallback.

Freeze resolved identity and execution grants at acceptance using the existing
private identity record. Explicit empty grants stay empty; backend switching
cannot elevate accepted permissions. Backend limitations remain documented.
Do not accept arbitrary profile paths, credentials, environment, or permission
overrides. Preserve accepted identity on queued execution, Continue, and recovery.

Hash all normalized caller inputs for spawn replay, before inherited defaults are
resolved. Preserve legacy task/baseline-only receipt hashes for old requests.
Changing context/backend/model under the same request ID is a payload conflict.
Inspect exposes selected backend/model and input locations without private account
paths or credentials. Failed input materialization prevents agent start and
produces an explicit failed outcome with any available evidence.

## Results and collection

Add `collect <worker-id>` to the existing service/CLI. Define every wire and
persisted shape in `packages/contract`, infer types, and use chained validated
routes. Map collection to existing inspect authority so old roots are not silently
denied by newly missing operation grants. Wait cancellation likewise uses wait
authority. New roots and persisted roots follow the same policy.

A collected result contains worker identity, observation/revision identity,
status, bounded summary evidence, execution selection, pinned baseline SHA,
observed HEAD commit when available, owned branch/worktree references, change
references, and artifact descriptors. Distinguish running, review-ready, completed,
failed, cancelled, and destroyed in the result projection without changing ordinary
run-status vocabulary. Queued/waiting workers project as still in progress with
their exact run status retained. Destruction must not overwrite the prior execution
outcome; expose both cleanup state and last execution outcome.

Summary evidence comes from persisted assistant output, with source/sequence and
truncation, bounded to 4,000 characters. On failure/interruption include the
recorded error and mark partial output. Tool output is not a successful summary.
If no assistant summary exists, return an explicit unavailable-summary field;
never fabricate success or use an empty string to imply available output.

Use typed availability for summary, commits, diff, and artifacts: available,
unavailable, or deleted, with bounded reason codes/details. A failed artifact read
does not hide an otherwise useful result. A collected diff is a bounded snapshot
using existing task-attribution helpers and truncation limits; a live worktree's
HEAD/diff is an observation, not a promise that execution has stopped. Mark such
results partial. Bound artifacts to 32 descriptors and report truncation.

Persist the latest collected result per worker under its parent before returning
success. Store bounded diff snapshots in parent-owned result files, referenced by
the parent record; avoid large diffs in `runs.json`. Writes are atomic and secret
redaction applies before persistence. Collection remains readable after restart
and after safe child-record deletion using the parent's durable ownership receipt.
An absent child without that evidence is unavailable/denied, never an inferred
worker. Do not let repeated collection regress a newer stored revision.

An authorized Continue creates a new execution revision and invalidates readiness
based on an older result. Preserve already collected evidence as historical; only
the latest revision can satisfy the parent's completion gate. Keep storage bounded
by retaining the latest result plus bounded previous outcome metadata, rather than
an unlimited archive of diff copies.

## One lifecycle wait mechanism

Extend existing registration with mode `one`, `any`, or `all`; default `any`
preserves shipped calls. `one` requires exactly one worker. `all` wakes only when
every selected worker has an inspectable settled outcome, or a finite deadline or
explicit cancellation ends the wait. Review-ready, completed, failed, cancelled,
and destroyed are wake outcomes; a stopping process is not proven settled merely
because the public status already says cancelled.

Persist mode, selected execution revisions, deadline, collected observations, and
settlement reason (`outcome`, `timeout`, `cancelled`) with the existing wait/wake
receipt. Old records lacking mode read as `any`. Keep each settlement reason
stable across replay. Completion-before-registration is handled by reconciling
current durable state immediately after registration. Observe revisions again
before publication so Continue cannot satisfy a new wait with an obsolete result.

Registration returns immediately. The parent can finish independent work in its
current turn, then park at a safe turn boundary and release capacity. Outcomes and
one deadline timer drive wake-up through existing scheduler admission. Recheck
after registering listeners/intent and at parking; no polling or second scheduler.
Keep human questions authoritative: worker outcomes do not answer a pending ask.

Add `cancel-wait <wait-id>` scoped to the parent's current or retained settled
wait. Cancellation is idempotent and only cancels waiting, never workers. A stale
ID cannot cancel a later wait. Timeout/cancellation reports partial outcomes and
unresolved workers, and neither destroys work. Persist a bounded last-wait receipt
so retries can read the result after active wait state is withdrawn.

State exits: registered -> parked or wake-pending; parked -> wake-pending on the
mode condition/deadline/cancellation; wake-pending -> scheduler admission ->
delivered receipt -> retirement. Parent terminal exit retires the wait and cancels
unfinished children. Shutdown preserves intent; restart reconciles outcomes and
receipts before ordinary recovery. Replayed events must not enqueue a second turn.

## Parent readiness and terminal lifecycle

Centralize the readiness predicate and use it from successful settlement, both
turn-end handlers, explicit Finish, and recovery. Find every `ActiveRun`
construction site and use the shared initialization path for new state.

An agent's completion attempt with queued/running/waiting workers is deferred.
Persist a completion gate using the same finite wait-all mechanism, release its
slot at the safe boundary, and wake the parent to inspect outcomes. Do not
publish `review`/`done` and do not automatically finish on wake. Collected outcomes
from the latest worker revisions are required before a subsequent completion
attempt may succeed. Collection records observation, not proof of integration;
the parent remains responsible for deciding how failed/partial work affects its
task and declaring completion honestly.

If workers are settled but results uncollected, give the parent one explicit
completion-blocked response identifying required collection. Do not manufacture
success. Repeated premature completion cannot spin an unbounded autonomous loop:
allow one automatic 600-second completion wait per completion attempt cycle.
After its timeout, or a second completion attempt that still has unresolved or
uncollected outcomes, retain an attention state without another automatic wake;
human input or a valid explicit wait/collection-and-completion action can proceed.

A worker waiting on a human question is outstanding. On timeout the parent gets
an unresolved outcome and must wait again deliberately or explicitly stop it.
Explicit stop requires termination evidence before readiness. Never destroy a
worktree as a side effect of this gate.

Human Finish with unresolved workers is rejected visibly before closing the
parent session or accepting durable Finish intent. It must explain that workers
must finish or be stopped and collected first; preserve pending human questions.
Keep existing HTTP response contracts unless a new typed error is necessary, in
which case update all consumers and parity tests together. No force-finish knob.

Review itself is not a terminal cancellation trigger. Recovery of an old parent
already in review does not cancel its children merely because of that state;
new successful transitions enforce the readiness gate. A child continuation that
would make a reviewing parent inconsistent requires the parent to be continued
first. Existing human authorization performs Continue; steering, stale events,
and worker wake-ups cannot reopen stopped sessions.

Parent failure/cancellation stops outstanding direct workers and awaits/proves
termination through existing bounded lifecycle machinery. Preserve completed and
review artifacts. Failed termination stays explicitly unresolved and retryable;
never claim the process ended because a signal was sent. Keep #111's private
process evidence, no-materialization proof, escalation, and cleanup locks intact.

## Integration, destruction, and deletion

Use existing Git commands to inspect and deliberately cherry-pick or merge worker
commits into the parent before cleanup. No merge service or automatic approval.
Integration conflicts remain conflicts until explicitly resolved or aborted;
collection never labels a commit integrated merely because it was returned.

Before destruction removes resources, persist a final obtainable result snapshot
on the parent. A snapshot may honestly contain unavailable fields. Failure to
persist that snapshot prevents destructive cleanup. Reuse the existing verified,
serialized, retryable destruction procedure and retain ownership receipts until
all resources are proven cleaned.

| Resource | Destroy | Explicit child-record deletion after complete destroy |
| --- | --- | --- |
| Parent-collected summary/outcome/diff snapshot | Retained | Retained |
| Owned worktree and uncommitted files | Removed after termination/ownership proof | Already removed |
| Owned branch ref | Removed after ownership proof | Already removed |
| Worker run history/handoff/attachments/input copies | Retained for inspection | Removed through owned cleanup paths |
| Commit SHA in result | Historical identifier retained; Git object reachability not guaranteed | Same |
| Commits integrated into parent | Retained by parent's refs | Retained |

Return explicit deleted artifact/ref descriptors and remaining-resource errors.
A retained path string never means retained bytes. Revalidate availability on
collection; never promise a deleted branch or garbage-collected object is usable.
General artifact bytes are not automatically archived on the parent. The bounded
collected diff and summary are the guaranteed retained payloads.

Relax worker-record deletion only after complete destruction, proven process
termination, durable parent result/ownership evidence, and no unresolved cleanup.
Update parent retention/deletion checks to understand safely deleted child receipts;
the old permanent tombstone was load-bearing for those checks. Atomic metadata
checkpoints precede file removal, and interrupted deletion resumes idempotently.
An absent/malformed parent cannot authorize child deletion. Ordinary legacy run
deletion behavior remains unchanged.

## Backend provisioning and guidance

Use the existing bundled absolute CLI invocation and per-session credentials on
start, Continue, and recovery for Claude, Codex, OpenCode, and pi. Check both
streaming and non-streaming paths. Mixed-backend workers receive their own
identity and credentials, never the parent's delegation environment.

Per-run guidance prefers cezar workers, explains inputs/results/waits and the
readiness gate, and states native workers are not tracked by cezar. Add a shared
runner-spec restriction intent interpreted inside each backend adapter. Suppress
native delegation only through verified backend-supported per-run flags/config;
do not rewrite global harness configuration or broaden existing grants. Verify
actual supported controls before coding each mapping. Unsupported restrictions
must have explicit documented parity exemptions and tests; guidance alone must
never be described as enforcement. Same-user unrestricted shell remains outside
hard enforcement. With delegation disabled, ordinary tools/settings are unchanged.

## UI, contracts, documentation, and tests

Reuse existing relationship/transcript/error surfaces; no new worker dashboard
or imagery. Any touched UI must cover loading/empty/error/offline states, keyboard
access, reduced motion, approximately 360px width and 44px targets. Record actual
viewport/theme checks, not intended QA. Contract changes update CLI parsing,
server middleware/chained routes, API inventory, both-direction contract parity,
and typed-body checks together. Document defaults, CLI use, artifact retention,
and native-tool limitations in README and AGENT_PROTOCOL.md. Update `.env.example`
if any existing environment contract wording changes.

Behavioral tests precede implementation. Demonstrate each regression test fails
without its fix, retaining independent guards for behavior that should not change.

| Requirement | Verification |
| --- | --- |
| Inputs/defaults/identity | Same- and mixed-backend spawn, explicit context, input materialization errors, model locks, replay conflicts, queued/Continue/recovery identity |
| Collection | Successful/partial/missing summary, commits/diff/artifacts, bounded output, secret redaction, stale revisions, restart and post-deletion readability |
| Waits | One/any/all, early/concurrent outcomes, finite timeout, cancel retry, stale cancel, stop before termination, reconnect/replay and maxParallel=1 fairness |
| Readiness | Both turn-end paths, gate-off done, review, explicit Finish, timeout, pending human ask, latest-revision collection, old review recovery |
| Lifecycle | Parent failure/cancellation, late completion/input, authorized Continue, slow termination, review not cancelling workers |
| Cleanup | Persist-before-delete failures, retries/restart, branch/worktree ownership, deleted artifacts, child and parent retention predicates |
| Backend parity | Every supported backend on start/Continue/recovery, native suppression or explicit verified exemption, permissions and asks |
| Integration | Parent plus two isolated workers including mixed backend; context, steering, wait-any, collect both, review inspection, real Git integration/conflict, failure/denial, restart and cleanup |

Run the five binding commands in order: `npm run typecheck`, `npm test`,
`npm run test:unit`, `npm run build`, `npm run test:package`. Use focused tests
while implementing; run actual browser checks for any UI behavior changed.
No draft PR opens with failing required verification. Commit and push with
Conventional Commits, merge freshly fetched origin/main and reverify changes,
open a draft PR closing #116, move the board to In review, and run pr-checks to
CI's verdict. Never auto-merge or mark the draft ready.

## Spec self-review

The completion gate preserves a finite wake path and does not change the shipped
review-gate default. Review is distinguished from terminal exit in live and
recovery paths. Collection and cleanup retain evidence before relaxing permanent
worker tombstones. Accepted identity, permissions, revision freshness, and human
asks remain authoritative. No unspecified configuration or second scheduler is
needed. Detailed backend suppression mappings require capability verification
within implementation; unsupported mappings cannot be claimed implemented.
