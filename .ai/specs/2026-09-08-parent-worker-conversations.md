# Parent and worker conversations — accepted design

Issue: https://github.com/hearsay-tools/cezarion/issues/112

Status: accepted by the user on 2026-09-08.

## Foundation and approach

#111 and #116 are closed through merged PRs #138 and #151. The existing
DelegationService supplies scoped commands; RunManager owns durable agent-input
delivery, worker waits, scheduler admission, and recovery. AgentSession already
provides sendAgentMessage with separate asynchronous transport acknowledgement.
The cockpit renders agent-input independently of human messages.

Extend that foundation with a shared conversation protocol and request selections
in the existing wait machinery. Keep the existing CEZ_DELEGATION opt-in and its
default unchanged. No new environment variables, process, scheduler, or provider
protocol. Parent/worker messaging does not grant spawn or peer-control authority.

Alternatives considered:

- Deriving requests from transcript text avoids a new durable shape but cannot
  safely correlate retries or recover obligations. Reject.
- A separate mailbox service isolates messaging but duplicates delivery,
  capacity admission, and restart logic. Reject.
- Structured conversation state integrated with existing delivery and waits
  preserves established guarantees. Recommended.

## Protocol and authority

Define envelopes and results with Zod in packages/contract. Every envelope has
caller-supplied message UUID, authenticated sender run ID, recipient run ID,
kind (request, progress, follow-up, reply), text, and creation time. Follow-ups
and replies reference the original request UUID. Sender identity comes from the
session credential, never a caller-controlled attribution field.

Expose send, follow-up, reply, conversation inspection, request cancellation,
and request selections for wait through the existing delegation service and CLI.
Preserve existing steer and worker-lifecycle wait commands and their defaults.
Accept only direct parent/owned-worker pairs in the same project. Workers can
communicate with their parent without receiving root management permissions;
parent-originated sends use existing steer authority. Wait authority for workers
is restricted to their own conversation requests. Unrelated, invalid, deleted,
and wrong-project relationships grant no authority.

One request creates one reply obligation. Progress and follow-ups create none.
Only its recipient may explicitly reply. Reusing an ID with the same normalized
payload returns its existing receipt; changed payload is a conflict. A second
reply cannot replace an already settled request. Late replies remain observable
as late and cannot change the recorded outcome.

Separate acceptance, delivery checkpoint, and request settlement in results.
Neither command acceptance nor provider acknowledgement means semantic reply,
worker completion, review approval, or integration.

## Durable state and delivery

Keep the authoritative conversation ledger under the owning parent in existing
run persistence, retaining both directions and stable operation receipts. Commit
message acceptance, request obligation, and recipient queue insertion atomically
through the run store before returning acceptance. Event streams are projections
for observation, not authority to enqueue turns. Reconcile missing projections
using stable message/event identities after restart.

Use bounded message text (the existing 100,000-character input ceiling), retain
the existing 32-undelivered-input cap per recipient, and cap a family's retained
conversation ledger at 1,024 messages and 32 open requests. Reject excess with an
explicit capacity error; never evict obligations or deduplication receipts.
Apply existing secret redaction before storage and display.

Extend AgentInput with optional structured attribution/correlation while retaining
legacy records. Send through sendAgentMessage only, at safe boundaries. Pending
native or portable human questions remain intact. Human input keeps priority.
Queued/starting runs consume the durable input through the same path as fresh
and continued sessions. Preserve generation checks that reject stale callbacks.

A positive transport acknowledgement checkpoints delivery; checkpointed inputs
are never resubmitted merely because SSE history replays. Disk and provider
execution are not transactional: a crash after provider acceptance but before
checkpoint may replay the same identified input, as documented today. Request
and reply idempotency still prevent extra obligations or repeated settlement.
Do not claim exactly-once provider execution.

## Request outcomes and terminal recipients

Requests have a finite deadline, using the existing 1–1,800 second range and
600-second default. The first durable settlement wins: explicit reply,
completed-without-reply, failed, cancelled, destroyed, timed-out, or sender-closed.
Explicit request cancellation is idempotent and never stops either agent.

Review readiness remains visible but does not settle an unanswered request as
reply or completion. A later normal completion settles completed-without-reply;
failure/cancellation and proven destruction have their own outcomes. Lifecycle
proof requirements from #116 remain intact; sending a signal is not termination.

New delivery to review/completed/failed/cancelled recipients returns an explicit
continuation-required outcome and starts no execution. These messages are durable rejection receipts: they create no queued input, deadline,
or reply obligation. The same message ID retains that rejection on retry. Human-authorized
Continue must occur before a new message ID can be accepted and execute. Destruction is non-resumable. Replies
received after settlement are recorded as late without waking a terminal sender.
Parent terminal exit settles pending requests and preserves existing child
cancellation/cleanup behavior; review alone remains distinct from terminal exit.

## One wait mechanism, both directions

Extend the existing persisted wait selection to support request IDs for both
parent and worker. Preserve lifecycle wait compatibility and one/any/all modes.
Only the request sender may wait on its requests. Keep one active wait per run,
with multiple selected requests allowed. Read durable outcomes immediately on
registration so replies arriving before wait registration satisfy it.

Use the existing transitions: registered -> parked at a safe turn boundary;
registered/parked -> wake-pending on selected outcomes, cancellation, or deadline;
wake-pending -> scheduler admission -> acknowledged checkpoint -> retirement.
Both roles release capacity while parked and acquire it before executing again.
Pending human questions defer delivery. Selected terminal outcomes, explicit
cancellation, and the finite deadline are wake sources; monitoring nudges are
disabled during the wait. No polling or automatic re-wait.

Reconcile on conversation changes, lifecycle changes, restart, registration,
and parking. A request to a parked agent can admit a conversation turn through
the same scheduler, preserving outstanding request obligations and reporting why
its wait was interrupted. This prevents both sides waiting from blocking an
incoming question. Never run a resumed turn without capacity. Test maxParallel=1.

Generalize role checks only where wait/delivery behavior requires it. Keep root
readiness, result collection, family cleanup, and child management root-specific.
Audit both turn-end handlers and every ActiveRun construction site.

## Cockpit and validation

Render sender/recipient links, message kind, request correlation, delivery status,
and explicit request outcomes within existing task threads and relationship views.
Use the current loading, empty, error, and offline surfaces. No artwork is needed.
Preserve keyboard navigation, reduced motion, narrow-screen wrapping, and 44px
interactive targets; verify light/dark at 360x640 and desktop widths.

Add failing behavioral tests before implementation for bidirectional ask/reply,
progress/follow-up, conflicts/retries, early and concurrent replies, multiple
outstanding requests, request/wait deadlines, request cancellation, parked
recipient admission, parent closure, normal completion without reply, review,
late delivery, and authorized continuation. Exercise restart before delivery,
after acknowledgement, and across checkpoint failure. Extend the two-worker
integration scenario and all four backend parity cases for attribution and
pending human questions. Preserve existing lifecycle/delivery regression guards.

Use chained routes with validation middleware and both-direction contract parity;
update CLI help, README, AGENT_PROTOCOL.md, and API inventories. Run the binding
commands: npm run typecheck, npm test, npm run test:unit, npm run build,
npm run test:package. Record actual browser observations for UI changes.

After approval, write the implementation plan, implement and verify, commit/push,
merge freshly fetched origin/main and reverify if changed, open a draft PR closing
#112, move its board card to In review, and monitor CI/review through pr-checks.
No automatic ready-for-review or merge.
