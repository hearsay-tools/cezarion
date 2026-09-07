# Owned workers in isolated worktrees

Date: 2026-09-06
Issue: https://github.com/wjarka/cezar/issues/111
Status: Complete written spec approved by the owner on 2026-09-06.

## Goal and scope

A parent agent can spawn, inspect, steer, stop, destroy, and read diffs for
workers through a bundled CLI. Workers are ordinary Cezar runs, use the existing
scheduler and event streams, and own isolated Git worktrees.

Stage 1 supports one generation and parent-to-worker steering. Worker terminal
outcomes are lifecycle notifications, not conversational replies. No recursive
delegation, peer messaging, shared workspaces, dirty snapshots, automatic merge,
or automatic review acceptance. Issues #112–#115 own subsequent stages.

## Decisions approved in conversation

- Architectural design track, with a written spec and implementation plan.
- CLI-first over one shared delegation service; defer an MCP adapter.
- Explicit `CEZ_DELEGATION=1` opt-in, automatic per-session provisioning,
  server-derived caller identity, persistent ownership and effective permissions.
- Explicit committed baseline, pinned when spawn is accepted; parent HEAD is
  supported without copying or autosaving dirty parent edits.
- Durable nonblocking wait registration, slot release on parent yield, terminal
  outcome/deadline wake through the scheduler, restart reconciliation.
- Separate agent steering from human answers; stop unfinished workers when their
  parent terminates; verified, retryable destruction retaining history.
- Existing cockpit views and live streams; full acceptance and backend parity
  coverage, browser checks, and all repository verification commands.

## Architecture and boundaries

### One policy owner

Add a focused delegation service under `packages/cezar/src/delegation/`.
It authenticates a scoped caller, checks persisted relationships and permissions,
and coordinates RunManager and owned-workspace operations. CLI and HTTP adapters
validate transport inputs but contain no independent ownership policy.

Keep lifecycle accounting in RunManager, persistence in RunStore, Git operations
in focused Git helpers, and credential handling outside public run records.
Avoid adding a second scheduler or letting routes manipulate manager registries.

New wire shapes live in `packages/contract`, with inferred TypeScript types.
Routes are chained Hono builders with body/param/query validation middleware.
All routes use `/api/v1`; inventory the new surface in
`BACKWARD_COMPATIBILITY.md`. Preserve request-origin protection and do not widen
CORS. The API client re-exports the contract; service runtime must not import the
private api-client package.

### Transport and automatic provisioning

`cez worker` is a thin JSON CLI. Parse its subcommand before the existing global
argument parser so worker flags do not become invalid cockpit flags. It must use
the running installation's bundled entry point, not assume an unrelated `cez`
binary on PATH is the right version.

Provide a loopback-only, in-process delegation HTTP listener while opt-in is on.
It serves only the delegation route family and shares the running managers and
service; it is not another daemon or a second cockpit. An OS-assigned port keeps
it invisible to the user. This same transport works for cockpit and headless
`cez run`; the headless path must not discover or control another cockpit's runs.
Shutdown closes the listener and revokes its credentials. Failure to provision
leaves ordinary runs working and reports delegation unavailable; it must never
advertise tools that cannot work.

The controller passes the endpoint and a cryptographically random session token
to the appropriate child process, plus instructions with the absolute bundled
CLI invocation. Use internal `CEZ_DELEGATION_URL` and `CEZ_DELEGATION_TOKEN`
variables; document them as generated, not user-authored settings. URLs may only
address the assigned loopback listener. Reject redirects; never forward a token
to a different endpoint. Do not put tokens in argv, URLs, prompts, run JSON,
transcripts, errors, or event streams.

Credential lookup maps to project, run, and session generation. A caller-supplied
run/parent/project identity never establishes authority. Revoke on session end,
rotate on continuation/restart, and explicitly strip parent delegation variables
when constructing any worker environment. Each launched session gets only its
own credential. Centralize provisioning for both execute and runContinuation.

`CEZ_DELEGATION` defaults off. Disabling it rejects new agent operations and
omits provisioning, but does not disable reconciliation or human cleanup of
already persisted worker relationships. No optional state needs a user-authored
file or migration to boot.

### Trust boundary

This is cooperative local-agent supervision, not process isolation. Unrestricted
same-user agents may access the filesystem, other process environments, and
legacy human-facing APIs. Scoped credentials prevent forgery and unrelated-run
access through delegation interfaces; they do not turn the whole host into a
sandbox. Do not claim that tool allowlists are uniformly enforced by backends.
Existing human controls retain their authority, subject to destruction safety
and pending-human-answer preservation.

## Persistent model

Add optional validated delegation metadata to ordinary runs. Missing metadata
means legacy behavior; invalid ownership metadata never grants permissions or
authorizes deletion. Keep public schemas and store schemas aligned.

The model records:

- Relationship: parent run ID for workers, scoped to the same project.
- Effective delegation permissions: resolved operation set. Eligible roots may
  operate on owned workers; workers have no spawn or peer-control permission.
- Execution settings: the resolved runner/model/account and existing execution
  permission settings used for the worker, distinct from delegation permissions.
- Workspace reference: owner run ID, kind `owned-isolated`, managed resource ID,
  canonical creation path, original owned branch, and pinned baseline SHA.
  Execution cwd is a separate field and never proves workspace ownership.
- Wait: unique wait ID, selected worker IDs, deadline, lifecycle phase
  (registered, parked, wake-pending), and durable outcome/delivery receipts.
- Destruction: requested timestamp, phase, last bounded error, and resources
  still requiring cleanup. A completed tombstone retains run history.
- Inactive-root Finish intent: optional `finishRequestedAt`, atomically persisted before
  accepting explicit human Finish and retained until normal review/done settlement
  checkpoints terminal status and steps. Pending intent blocks new execution/input
  authority (including monitoring wakes) but retains inspection/stop/cleanup and
  retries after restart. Explicit cancellation atomically retires superseded Finish
  intent; recovery repairs cancelled-plus-intent records without changing cancellation
  or treating pending human questions as answered.
- Spawn receipt: parent-scoped request ID and resulting worker ID, so retrying a
  lost response cannot create another worker.

Persist ownership and spawn receipt before enqueueing a worker. Persist wait,
wake, and destruction intent before their external side effects. Add an explicit
durable store operation where a debounced save is insufficient. Do not create a
second writable copy of run lifecycle state in the delegation service.

Malformed or missing ownership is a denial, not a reason to reinterpret the run
as an eligible root. Preserve this distinction during parse/recovery.

## CLI operations

Commands return bounded JSON results; failures use stable typed error codes and
nonzero exits. No interactive prompts or implicit targeting of the current cwd.
The service rechecks ownership for every targeted operation, including reads.

| Command | Behavior |
| --- | --- |
| `spawn --baseline parent-head|<ref> --request-id <id> <task>` | Resolve and pin commit, persist ownership, enqueue ordinary isolated run; return worker ID and SHA. |
| `inspect <worker-id>` | Return status, step/activity, baseline, relationship, wait/cleanup state and bounded latest outcome; never credentials. |
| `steer <worker-id> <text>` | Persist attributed agent input and return delivered/queued or explicit rejection. |
| `stop <worker-id>` | Idempotently request cancellation; distinguish stopping from terminated. |
| `destroy <worker-id>` | Persist destruction intent, cancel, await bounded termination/cleanup, report complete or incomplete with remaining resources. |
| `diff <worker-id>` | Return bounded worker-attributed changes using the existing task diff resolver and its truncation reporting. |
| `wait <worker-id>... [--timeout-seconds <n>]` | Register wait and return immediately with instructions to end the parent turn. |

Stage-one spawn uses the bundled ordinary quick-task workflow and inherits the
parent's resolved runner/model/account and execution settings. It does not accept
arbitrary environment, filesystem paths, permission elevation, or workspace modes.
Review gates and ordinary workflow execution remain intact. The existing
review gate remains opt-in (`CEZ_REVIEW_GATE=1`); worker delegation does not
change its default or accept a review automatically.

Implementation refinement approved during Task 7 review: acceptance writes a
private concrete execution-identity record before publication/enqueue. Supported
Claude/Codex homes remain bound across registry deletion/repointing; OpenCode/pi
remain default-only. Claude native state-file layout is preserved without adding
an override, while explicit/named relocated homes retain their override layout.
Missing/malformed private evidence, unavailable homes, conflicting model locks,
or incompatible native environment layout explicitly refuse execution/Continue.
Unshipped intermediate owned records without this evidence are not migrated.
The internal primitive has an explicit compatibility marker; service acceptance
always supplies concrete identity, including an independently validated private
snapshot of effective tool and Bash grants. Explicit empty lists remain empty;
deliberately absent grants remain absent. Public workflow-definition salvage
cannot broaden accepted permissions on queued execution, recovery or Continue.
Missing/malformed private grants refuse execution rather than fall back to
ordinary defaults. No credentials or configuration contents are
snapshotted, and inspection/history/stop/verified cleanup remain available.

Use fixed service limits rather than new configuration: at most 32 accepted
worker creations per parent, including destroyed workers; bound task/steering
payloads by the existing run-input limits. Spawn receipts do not consume another
creation. Persisted counts survive restart. These are cost/abuse bounds, not a
recursive-delegation feature.

Errors distinguish unavailable transport, unauthenticated caller, denied scope,
invalid input/baseline, incompatible run state, capacity limit, unavailable diff,
and incomplete cleanup. Unrelated/nonexistent worker lookup should not reveal
other runs to a credentialed caller.

## Committed baseline and worktree ownership

The baseline argument is required. `parent-head` reads HEAD in the parent's
server-known execution directory. Other refs resolve in the same Git repository.
Verify a commit with safe argument handling and persist its full object ID before
queueing. Resolve once: later parent commits or ref movement do not change it.

Dirty parent edits are excluded and not modified. Spawn does not invoke
`autosaveCommit`; existing independent parent autosave behavior is unchanged.
A non-Git parent or unresolved baseline is an error, not in-place execution.

Provision through managed worktree creation using the pinned SHA. Worktree
failure ends the worker before any agent starts. Restart may reuse only the
persisted resource whose ownership can be verified; it must not claim an
unrelated existing branch or directory. Original branch ownership is retained
separately if an agent changes the checked-out branch.

Use `resolveTaskDiffBase` with the worker's pinned baseline, original branch and
start timestamp. Do not reinvent diff anchoring. Missing/reclaimed resources
produce explicit unavailability, not an empty successful diff.

## Wait and wake state machine

Waiting is not generic `CEZ:MONITORING`. No polling command holds the parent's
shell open while waiting for a queued child.

1. `wait` checks ownership, nonempty unique worker set, parent session eligibility,
   and absence of a pending human question or another outstanding wait.
2. Persist wait intent and deadline, then return. Default timeout is 600 seconds;
   accepted values are 1–1800 seconds. Wait ends on the first selected worker
   terminal outcome, returning the selected workers' current statuses.
3. At the parent's turn boundary, park it as a worker wait and release its slot.
   Reconcile already-terminal workers at registration and again at park, so a
   completion in either gap cannot be lost. Worker waits take precedence over
   generic monitoring/autonomous nudges, but never consume or dismiss an ask.
4. Persist a wake receipt on selected-worker `review`, `done`, `failed`, or
   `cancelled`, or when the deadline expires. `review` means execution completed
   pending review, not permission to merge. Event notifications are typed and
   linked to worker IDs; do not infer completion from assistant prose.
5. Queue the parent wake for scheduler admission. Parked parents consume no
   active slot; wake delivery reacquires capacity and honors project/workspace
   and resource gates. Do not use the ordinary immediate-resume exemption to
   oversubscribe capacity for synthetic worker wakes.
6. Deliver attributed lifecycle context at a safe turn boundary, consume the
   wait receipt, and clear the wait. No automatic re-wait. The parent chooses
   what to do next. Timeout does not cancel children.

Accepted waits also hold nonfinal agent steps (agent→agent and agent→check).
All four runners check an internal auto-end veto at timer execution; the manager
holds the exact current session until admitted wake delivery and its reply turn.
An actual session close before wait completion fails that step rather than
advancing the workflow with a stale capacity exemption. Ordinary no-wait steps
retain automatic completion.

Durable wait deadlines also expire registered intents whose parent never yields;
they must not silently remove an executing parent's capacity accounting. Deliver
the resulting wake context at a safe boundary. A human message withdraws the
wait and resumes through existing human control semantics. A pending human ask
keeps synthetic input queued until the question is answered.

On restart, reconcile waits before the current generic waiting-run success
settlement. Recover child runs through existing scheduling; rebuild deadlines
from timestamps, reconcile terminal outcomes, and enqueue eligible parent
continuations. Initialization is shared by execute and runContinuation. Rotate
credentials before resumed sessions receive delegation access.

Wake IDs prevent duplicate queue entries and repeated outcome bookkeeping. Crash
recovery may redeliver the same identified context if the process died between
backend delivery and receipt persistence; never promise transactional exactly-once
model execution. Never silently lose an undelivered outcome.

Parent cancellation, failure, or terminal success revokes its session credential,
clears its wait, and requests cancellation of all unfinished workers. Preserve
artifacts. A controller shutdown/restart is not parent terminal success and must
not cascade-cancel recoverable work. Workers needing human input remain visible
and retain their ask; the parent's bounded wait may expire normally.

Task 5 review ruling: ordinary parked delegated roots remain `waiting` across
restart even after their children finish. Inactive roots retain explicit human
Continue (actual answer content required for an ask) and Finish through the normal
review gate. Finish acknowledges only after durable intent; failure to compute the
diff or checkpoint settlement retains visible retryable intent, never an answer
receipt or permission to delete artifacts. Persisted human-answer continuations
interrupted before their first boundary recover through capacity admission; an
unresumable ask stays waiting rather than becoming terminal failure.


## Steering and human questions

Introduce an explicit non-human delivery seam shared by all runners; a boolean
that only suppresses `user-message` recording is insufficient. Preserve source
(parent agent versus lifecycle notification) in queued messages and transcript
events. Do not expand agent-originated text as a human slash-skill command.

Manager-level pending-ask state covers native asks and portable CEZ:ASK markers.
Runner-level safeguards ensure non-human delivery cannot resolve native pending
questions. While an ask is pending, persist steering as queued and return that
status. After a real human answer, deliver it at the next supported safe boundary.
If a backend lacks native mid-turn steer, queue to the next turn rather than
interrupting the ask or pretending delivery succeeded.

Cover queued, starting, active, parked, and continuation sessions. Terminal or
destroying workers reject new steering rather than secretly reopening them.
Restart preserves attribution and undelivered input. Bound queues and reject
excess input explicitly. Human answers and existing ordinary-run behavior remain
unchanged on all four backends.

The controller-approved 2026-09-07 review refinement makes transport reservation
and acceptance explicit: the internal synchronous `sendAgentMessage` returns
false or a Promise. A Promise reserves the submission; `deliveredAt` is committed
only after positive transport ACK, with rejection retaining the same input id.
Codex/OpenCode/Pi use their RPC/HTTP acceptance response; Claude's available
boundary is the stdin write callback, not model execution. Accepted commands that
subsequently fail at the provider remain distinct from rejected submissions.
Pending ACK counts against the 32 undelivered cap, excludes duplicate admission,
and merges into the current queue. Human priority and public wire shapes remain
unchanged. Explicit stop/disposal/replacement revoke callback authority; delivery
bookkeeping settles before execution proof. Wake reservation acquires capacity,
ACK plus checkpoint retires the wait, and a completed wake/DONE/nonfinal step
resumes completion after ACK without inventing a later turn.

## Stop, destruction, and retention

Cancellation requested is not proof of process termination. Add a manager
termination barrier covering queued, dequeue/startup gaps, workflow checks and
agent sessions. Wait for runner result/process termination and finalization, not
`ChildProcess.killed`, a status label, or `interrupt()` return alone.

Destroy is serialized per worker and durable:

1. Verify parent and recorded resource ownership; persist destruction intent.
2. Block new launches, continuations, steering and rematerialization for that run,
   including human-facing execution paths, while allowing human inspection.
3. Remove queued work or request cancellation. Wait up to 30 seconds for proven
   termination. Unknown termination after restart is incomplete cleanup, not a
   license to kill a potentially reused PID or delete a live workspace.
4. Verify canonical managed path, Git registration, original branch ownership,
   and absence of another user's checkout before deletion. Preserve moved,
   symlink-replaced, repurposed, or otherwise ambiguous resources.
5. Remove the verified owned worktree with checked Git results; verify directory
   and registration absence. Do not follow the legacy unchecked recursive-rm
   fallback. Delete only the original owned branch when it is still verifiably
   owned and not checked out elsewhere; never infer ownership from cwd alone.
6. Persist complete or incomplete state and remaining resource details. Repeated
   calls join or retry the same operation. Already absent verified resources
   count as cleaned. Preserve run records and NDJSON events.

Execution admission requires a valid private queued checkpoint or a completed
prior generation. Only the manager that owns an exact deferred starting
generation can admit it without rotation. Missing/malformed evidence or an
unowned starting generation refuses queued recovery and Continue; no subsequent
execution may overwrite unknown termination evidence to authorize destruction.
History, stop and explicit verified-cleanup attempts remain reachable.

Each Git/process operation has a bounded timeout. A failed cleanup never gets a
success response just because cancellation was sent. Partial cleanup survives
restart and permits a later retry; no autonomous destructive retry after a
restart without a new request.

Existing retention/orphan sweeps must respect worker ownership and destruction
state. Exclude owned worker worktrees from ordinary best-effort retention and
unowned deletion paths; worker cleanup uses the verified path. Human deletion
of a related run must not erase the ownership evidence while owned resources or
live descendants remain. Ordinary unrelated-run retention remains unchanged.

## Cockpit

Add a small relationship component to the shared RunHeader, present on Session,
Changes, Commits, and Files tabs. A worker links to its parent. A parent lists
workers with status and links. Existing task lists identify worker rows without
changing normal grouping or requiring a separate dashboard.

Use project-scoped links and current run cache/SSE. Relationship lookup must not
assume the first page or currently filtered run list contains every worker.
Use a bounded complete relationship response (maximum 32 workers) when needed;
human read routes expose no session credentials and follow normal API contracts.
Updates and reconnect reconciliation reuse current event infrastructure, with
no new browser socket or polling timer.

Keep known parent/worker IDs visible during loading, offline and request failure;
provide retry and distinguish unavailable/deleted records from an empty worker
list. Show waiting-on-workers and cleanup-incomplete context without calling them
human questions or completed cleanup. Agent steering is labeled as agent input,
not as a human answer, in transcripts.

Task 8's approved index refinement adds only optional delegation role and root
wait phase to the existing slim workspace run index. Its actual producer and
live palette constructor project the same fields, so global Tasks and the
palette use the same parked-only attention decision as project lists. Receipts,
workspace references and private execution identity stay out of that projection.
A visible human question takes priority over worker-wait presentation. The
compact current-history producer retains the latest valid unanswered ask, and
the header/dock derive attention from that current context rather than paginated
historical cards. Full-replay fallback uses its authoritative current events through
the same scan; only views without history retain legacy attention inference.
Manager delivery, compact context and cockpit attention share
one pure acknowledgement reducer and the existing strict question schemas:
only a matching successful `human-input-delivered` receipt retires that ask.
Queued/refused human attempts, agent input and lifecycle events do not. Historical
transcript rendering retains its existing compatibility behavior.

No artwork is needed for operational links/statuses; deliberate no-art decision.
Use existing status and motion tokens, no new animation. Check keyboard focus,
accessible names, at least 44px touch targets, wrapping at 360×640, light/dark
and reduced-motion settings. Hidden mobile metadata must not leave hidden links
in the accessibility tree. Ordinary runs render as before.

## Implementation surfaces

- `packages/contract`: optional public metadata, delegation request/response,
  relationship and attributed event schemas.
- `packages/cezar/src/delegation/`: service, credential registry, route builder,
  in-process transport and CLI adapter; focused units, no duplicate scheduler.
- `packages/cezar/src/index.ts`, server/project context wiring: lifecycle-owned
  transport, early worker CLI parsing, boot and lazy-project provisioning.
- `packages/cezar/src/runs/store.ts`: durable metadata/receipts and atomic
  transitions; related retention/rematerialization and human deletion guards.
- `packages/cezar/src/workflows/run.ts`: wait/wake admission, termination barrier,
  restart reconciliation and shared fresh/continuation provisioning.
- `packages/cezar/src/core/agent-runner.ts` and every runner: non-human delivery,
  backend-specific safe mapping only behind the seam; update protocol/parity.
- Git/worktree helpers: pinned creation and observable owned cleanup; retain
  existing task-diff resolver.
- Cockpit shared header, task lists and transcript rendering: relationship and
  attributed input display with existing API cache/event infrastructure.
- `.env.example`, README, AGENT_PROTOCOL.md and BACKWARD_COMPATIBILITY.md:
  opt-in/internal env contract, command usage, limits, safety and API inventory.

## Acceptance criteria and verification

| Requirement | Evidence to add |
| --- | --- |
| Full parent lifecycle | Service and packaged-CLI tests exercise spawn, inspect, steer, stop, destroy, diff and wait with ordinary manager runs. |
| Server-derived identity | Invalid/missing/stale tokens, forged identity fields, wrong-project and unrelated-run targets rejected across every agent route; no secrets on public responses/events. |
| One generation/parent-only | Worker credentials cannot spawn or operate on peers; root cannot target another parent's workers; per-parent limits survive destroy/restart. |
| Committed isolation | Parent HEAD and explicit ref pinning, ref movement while queued, dirty edits excluded/unmodified, non-Git/bad ref rejection, creation collision/failure, worker-only diffs. |
| Capacity and wake | maxParallel=1 with queued child; terminal-before-register/park races; failed/cancelled/review workers; deadline; scheduler fairness; parent cancellation; shutdown vs terminal; restart and duplicate wake receipts. |
| Durable safe destroy | Queued/starting/live/parked/terminal paths; slow SIGTERM/kill escalation; repeated/concurrent requests; interrupted cleanup; path/branch ownership mismatch; missing resources; human continuation/deletion and retention races. |
| Human answer separation | All four real runners against offline wire-faithful mocks: native/marker asks, agent steer before/during/after ask, queued restart input, fresh/continuation paths; add harness-parity rows and only genuine wire exemptions. |
| Cockpit/defaults | Scoped navigation, loading/empty/error/offline context, all run tabs, agent attribution, legacy record parsing, no new metadata/transport when off, unavailable provisioning degradation. |

Write behavioral tests before fixes and demonstrate regression tests fail without
the corresponding source change. Keep ordinary-behavior guard tests too. Do not
substitute mock-only happy paths for manager lifecycle and runner parity coverage.

Run in repository order before any commit/PR:

1. `npm run typecheck`
2. `npm test`
3. `npm run test:unit`
4. `npm run build`
5. `npm run test:package`

Use npm for narrowed Vitest runs, never npx. Also run the separate browser smoke
suite and actual viewport/theme/keyboard checks. An e2e `skipped` marker is not a
pass. Record observed UI QA under PR Experience; no intended observations.

## Written-spec self-review

- Ownership, execution location, and delegation versus backend permissions are
  separate; missing/malformed ownership cannot grant authority.
- Registered wait, parked wait and wake-pending each have explicit transitions;
  finite deadlines do not depend on generic monitoring behavior.
- Restart reconciliation runs before waiting-run settlement; fresh and continued
  sessions share provisioning/delivery initialization.
- Destruction checks termination and resources, blocks resurrection, preserves
  history, and cannot fall through best-effort retention deletion.
- Token transport is automatic in both server and headless lifecycles, default
  off, scoped per session and never claims hostile-process isolation.
- No downstream roadmap stages, new dependencies, public auto-merge behavior,
  authored configuration, or unrelated refactors are required.

The owner approved this complete spec, including its transport, command,
finite-limit, persistence and retention details. The implementation plan is
`.ai/specs/2026-09-06-owned-workers-isolated-worktrees-plan.md`; execution follows
the plan's TDD and verification gates.


### Recorded verification outcome (2026-09-07)

The final corrected implementation passed all five ordered local gates and all
eight issue-specific real-browser cases. The full browser aggregate remains
222passed/two failed/six conditional skips; unrelated baseline failures are
tracked separately in [#136](https://github.com/wjarka/cezar/issues/136) and
[#137](https://github.com/wjarka/cezar/issues/137), following the user's instruction
to keep further work scoped to #111. Exact commands, observations, incident
limitations and artifact references are in the adjacent QA report. Publication
and CI are controller-owned and pending.
