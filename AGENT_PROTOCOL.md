# AGENT_PROTOCOL.md — the cezar agent protocol

cezar runs coding-agent CLIs behind **one backend-agnostic seam** and renders
every backend through **one normalized event vocabulary**. This document is the
operational contract for that seam: what a runner must implement, what it must
emit, how the emissions are tested, and what a *new* runner (e.g. `pi`, PR open-mercato/cezar#387)
has to satisfy to be a first-class backend rather than a second-class one.

It is the concise, load-bearing contract. The deep design record lives in
`.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md` (§7 schema, §7.1 the
per-backend mapping tables) and the spec `.ai/specs/2026-07-14-cockpit-ui-redesign.md`
(§"Normalized agent-event protocol v2", §"Backend parity requirement"). The code
in `packages/cezar/src/core/` cites those two by section; this file cites the code. When the two
disagree, **the code wins** — the golden fixtures and the parity test are
executable, the prose is not.

**Editing runner prose.** Name a runner or backend when its wire matters, but
never count them: write "every runner" or "the runner shards", never a number.
A count goes stale when a runner is added. The guard `protocol and matrix prose
name runners without a counted roster` in `packages/cezar/src/core/harness-parity.test.ts`
refuses a counted roster in this file and in the harness-parity spec and test
files. To run only that guard, from the repository root:

```bash
npm test -- packages/cezar/src/core/harness-parity.test.ts -t "counted roster"
```

The protocol has **two layers that ship together**:

- **v1 `AgentEvent`** — the original flat stream. Persisted in old NDJSON
  recordings and still consumed by `cezar run`'s console renderer. Never
  removed; old recordings must keep replaying forever.
- **v2 `UiEvent`** — the normalized, item-lifecycle protocol the redesigned
  cockpit renders. Emitted **alongside** v1, never replacing it. A mixed NDJSON
  file (v1 + v2 lines) is valid by design.

---

## 1. The runner seam (`packages/cezar/src/core/agent-runner.ts`)

Every backend is one class implementing `AgentRunner`, constructed through the
single factory `createRunner(backend)` in `packages/cezar/src/core/runner-factory.ts`. Nothing
outside `packages/cezar/src/core/` should ever `new` a concrete runner or branch on the backend
id — that is the whole point of the seam.

### Identity

```ts
const RUNNER_IDS = ['claude', 'codex', 'opencode', 'pi', 'cursor', 'omp'] as const;  // the source of truth
type RunnerId     = (typeof RUNNER_IDS)[number];                   // user-selectable
type AgentBackend = RunnerId | 'claude-cli';                       // + legacy id, still parses
```

`RUNNER_IDS` is the tuple every other enumeration derives from — the zod schemas
(config, run store, workflow steps, the API bodies), the server-install
"at least one agent CLI" gate, and the CLI-handoff registry. Re-listing the ids
by hand is how a runner silently goes missing from one seam (open-mercato/cezar#387 review); use
`RUNNER_IDS` / `isRunnerId()` instead.

`claude-cli` is a **legacy** backend id kept so old `runs.json` records and
NDJSON transcripts still parse; `createRunner` maps it onto `claude`. Follow that
precedent — never repurpose or remove a shipped id.

### `AgentRunner`

```ts
interface AgentRunner {
  readonly backend: AgentBackend;
  run(spec: AgentRunSpec, onEvent?: (e: AgentEvent) => void): Promise<AgentRunResult>;
  startSession(spec: AgentRunSpec, onEvent?: (e: AgentEvent) => void, opts?: SessionOptions): AgentSession;
  interrupt(): Promise<void>;
  readonly systemPromptOnResume: 'resent' | 'in-thread'; // required (hearsay-tools/cezarion#790)
  readonly inputDelivery?: InputDelivery; // absent = boundary (hearsay-tools/cezarion#505)
}
interface InputDelivery {
  readonly mode: 'steer' | 'boundary';                 // mid-turn admission, or refused while busy
  readonly consumption: 'observable' | 'unobservable'; // does the wire show the model read it?
  readonly via: string;                                // the native mechanism
}
```

- `run()` is a one-shot convenience; `startSession()` is the real contract.
- `systemPromptOnResume` is required (hearsay-tools/cezarion#790). `resent` means every
  session/process delivers `spec.systemPrompt` again, so Continue must resend a selected
  skill's playbook; `in-thread` means the opening turn prepended it into resumed history,
  so the same-session resume must not. The flag is the caller's dedupe policy for the
  skill prefix, not a statement that in-thread runners ignore `systemPrompt` on resume:
  Codex, Cursor and OpenCode still re-prepend the whole `spec.systemPrompt` (extra prompt +
  handoff) on every resumed opening turn. Per harness, verified live: Claude `--resume`
  keeps the launch `--append-system-prompt` and ignores new flags (resending is harmless,
  `resent` stays the safe declaration; changed extra/delegation/artifact/handoff
  instructions never reach a resumed session); Pi `--session` *replaces* stored prompt
  sections with the new flags (resend required — a resumed skill task lacks the playbook
  unless the caller sends it); OpenCode and Codex/Cursor carry it in the thread. OMP was
  not live-verified (not installed here) and is declared `resent` as the safe value.
- Session-start context (hearsay-tools/cezarion#1584, `docs/context-injection.md`) rides in
  `spec.userPrompt`, never `spec.systemPrompt`: every runner delivers the opening message, so
  it needs no field-support declaration. A resumed Claude session keeps its first launch's
  handoff instruction, so it can still be told to read the file that the prefix now carries.
  claude, pi and omp are `resent`; opencode, codex and cursor are `in-thread`. A backend
  switch with no `sessionId` still sends the skill. OpenCode Continue GETs `/session/{id}`;
  a 404 opens one fresh session with `resumeFallbackSystemPrompt` (the skill-inclusive
  composition Continue omitted from `systemPrompt`). When the continued skill is also
  missing from the registry, that fallback session gets no skill and only the
  lost-session notice is shown.
- Each backend runs as a **persistent process** so multi-turn follow-ups,
  `waiting`, interrupt and resume all work: claude = stream-json over
  stdin/stdout; codex = `codex app-server` JSON-RPC 2.0 (JSONL) over
  stdin/stdout; opencode = `opencode serve` over HTTP + SSE; pi =
  `pi --mode rpc` over JSONL stdin/stdout; omp (Oh My Pi, hearsay-tools/cezarion#595) =
  `omp --mode rpc` over JSONL stdin/stdout, a distinct backend from `pi`
  (`.ai/specs/2026-10-02-omp-runner.md`).

### `AgentSession`

A live session over one spawned process, alive between turns:

```ts
interface AgentSession {
  result: Promise<AgentRunResult>;   // resolves when the process exits
  readonly pid?: number;             // root of the run's process tree (resource telemetry, open-mercato/cezar#348)
  sendMessage(content: ContentBlock[]): boolean;  // human input; false when closed
  sendAgentMessage(content: ContentBlock[], inputIds?: readonly string[], options?: AgentInputOptions): false | Promise<void>; // reserve now, harness acceptance later; `besideQuestion` admits wait results beside a portable CEZ:ASK
  respondPermission?(requestId: string, optionId: string): boolean; // explicit offered native approval choice
  discardQueuedMessages(): void;     // drop mid-turn follow-ups; CEZ:ASK park calls this
  holdsHumanInput(): boolean;        // true while a sendMessage follow-up is held undelivered (hearsay-tools/cezarion#486). Queueing runners drop on discardQueuedMessages and return false; write-through/steer wires report true until the harness settles that line (their discard is a no-op). A drain with no new turn notifies onAgentInputReady so run.ts re-settles.
  end(): void;                       // graceful: end input, SIGTERM→SIGKILL watchdog
  interrupt(): void;                 // hard stop (cancel)
  readonly open: boolean;
}
```

A termination the runner itself caused is **not** an agent failure (open-mercato/cezar#703).
`end()` arms a SIGTERM→SIGKILL watchdog for CLIs that ignore EOF, and
`interrupt()` signals outright; the agent CLIs install their own handlers and
exit `128 + signal`. A runner MUST therefore record that it sent the signal and
settle such an exit on the normal path — `isSignalTerminationExit(exitCode)`
(`packages/cezar/src/core/agent-runner.ts`) plus a `note` — instead of throwing. Throwing makes
a finished run settle as `failed` and a cancelled run settle as `failed` too.

That watchdog MUST gate its SIGKILL escalation on real termination, never on
`ChildProcess.killed` (open-mercato/cezar#844). Node sets `killed` when a signal is *delivered*,
so the watchdog's own SIGTERM flips it while the CLI — which handles the
signal — keeps running, and the escalation written for exactly that case is
skipped. Use `trackChildExit(child)` (`packages/cezar/src/core/agent-runner.ts`),
which seeds from `exitCode`/`signalCode` and listens for `exit`.

Codex startup has one internal 60-second budget, including initialize, thread
start/resume, the opening turn acknowledgement and the first main-thread
`turn/started`. Phase notes identify a stalled boundary. Interactive
`timeoutMs: 0` does not disable startup protection; successful startup removes
it, so model turns and native human questions have no new lifetime cap.
Stop revokes pending RPCs and prevents late replies from starting work, then
sends SIGTERM and escalates to SIGKILL after 10 seconds unless the process has
actually exited. RPC rejection is not termination: `result` still waits for
real exit (or a failed spawn). After exit, inherited stdout gets a bounded
250ms drain; remaining pipe handles are closed. Neither a timeout nor sending
a signal can fabricate an exit or free a still-live session's capacity.

`cez task send` is human input. When `CEZ_TASK_ID` is nonempty, it exits 64 before contacting the cockpit, including with `--resume` or `--notify`. Use `cez message progress <task-id> '<text>' --id <message-UUID> (needs CEZ_DELEGATION=1)` for agent-to-task messaging.

**Non-human input (owned workers, 2026-09-06; immediate delivery, hearsay-tools/cezarion#505).** `sendAgentMessage`
must never resolve a native question or a portable marker ask. False means the caller
still owns the input and must retry later, NEVER fall back to `sendMessage`. A runner
whose `inputDelivery.mode` is `steer` admits it while a turn runs, through the
harness's native mechanism, so the model reads it at its next model step instead of
after the whole turn; a `boundary` runner refuses it until the turn ends. Routine
input never cancels a running tool. Every runner refuses while a native question or
a trailing `CEZ:ASK` is pending, and before its opening prompt exists (Codex until
startup completes, OpenCode until the opening prompt starts), then emits one
readiness hint if it refused. The one exception is `options.besideQuestion`
(hearsay-tools/cezarion#1233): the caller delivers wait results beside a pending
portable `CEZ:ASK`, so the runner skips only that refusal. The input is not the
question's answer, the question stays the caller's, and a native question still refuses. Human input keeps priority: an outstanding human prompt
acknowledgement refuses, then hints once it lands.

`inputIds` name the durable inputs in the submission. A runner reports
`onAgentInputConsumed(ids)` when its wire shows the model received them — never from
a transport acknowledgement — and reports input it accepted but the model will never
read: as `turn-end.unconsumedInputIds` at that turn's end, or as the out-of-turn event
`input-unconsumed` when only a quiet grace window can tell (OpenCode). Input that
opened a turn counts as read when that turn completes.

| Backend | `inputDelivery` | Busy submission | Read when | Unread report |
| --- | --- | --- | --- | --- |
| Claude 2.1.280 | steer, observable | stdin line with `uuid`; argv `--replay-user-messages` | the replay echo with that uuid, or a `result` listing it in `user_message_uuids` | none: a line written after the last model call runs as the CLI's next queued turn |
| Codex 0.155.1 | steer, observable | `turn/steer` with `expectedTurnId` and `clientUserMessageId` | `item/started` `userMessage` whose `clientId` matches — the input entered the thread's history and the next model call reads it (not a sampling timestamp: probes saw it 0.8 s and 26.7 s after the steer, mid-tool); a `turn/start` submission at its turn's completion | `turn-end.unconsumedInputIds`; a steer refused because its turn ended, or acknowledged after it completed, starts a turn with the same client id |
| Pi 0.87.0 | steer, observable | `prompt` with `streamingBehavior: 'steer'` (never `followUp`); session starts with `set_steering_mode: all` (overrides Pi's default `one-at-a-time` — cezar owns the session and `get_state` cannot tell the default from an explicit user setting) | the user `message_start` with the submitted text; a burst of steers in `all` mode all match at the same next step, oldest pending submission first | none: pi runs an acknowledged steer in the turn or as the next prompt |
| OpenCode 1.18.32 (V1) | steer, observable | `prompt_async` while busy; no second turn opens | the first assistant `message.updated` naming the steered user message as `parentID` | `input-unconsumed` after a 2 s quiet idle (anomalyco/opencode#46842 lost wake); a later server run for it opens its own turn |
| Cursor 2026.09.18 | boundary | refused while busy: a second ACP `session/prompt` cancels the running turn | the turn it opens | none |
| OMP 18.4.11 | steer, observable | `prompt` with `streamingBehavior: 'steer'`; session starts with `set_steering_mode: all` | the user `message_start` with the submitted text | none: OMP's settle predicate (`rpc-session-settle.ts`) requires `queuedMessageCount === 0`, so a queued steer is read before the session settles. Source-derived; no live turn was possible (see §4 OMP) |

Probe evidence for this table is in `.ai/specs/2026-09-23-immediate-worker-delivery.md`;
`.ai/scripts/probe-steering.ts` re-runs it against the installed CLIs (paid sessions,
manual only).

RunManager persists an attributed `AgentInput` before calling this seam, retains
it on false or rejection, and records `deliveredAt` only after the returned Promise
resolves — harness acceptance, which on a steer runner can be mid-turn. `consumedAt`
records the read report; an observable acceptance also writes `awaitingRead` until
then. Input the harness reports unread returns to the queue (receipts cleared, order
and identity kept) and is submitted again; accepted-but-unread input counts as queued
work, so DONE, auto-end, the autonomous nudge and parking wait for it. A restart
replays input still `awaitingRead`: delivery is at-least-once and the replayed text
keeps the input ID. The method remains synchronous: false refuses without a write; a Promise
reserves one submission immediately, but is not a delivery receipt. Codex resolves
at the matching turn/start or turn/steer RPC result, OpenCode at successful prompt
HTTP acknowledgement, and Pi and OMP at the matching prompt response id. Claude has no
per-prompt RPC receipt: its write callback proves only successful pipe delivery,
not model execution. A transport rejection remains replayable; a successfully
accepted command followed by a provider failure retains its transport receipt.
OpenCode's provider-error SSE frame may overtake the independent HTTP ACK: the
runner holds v1 failure and subsequent SSE frames until that request settles,
with the teardown grace as an upper bound. An unresponsive ACK is aborted and
remains undelivered; explicit end/interrupt still abort immediately.
Human `sendMessage` keeps its existing synchronous semantics. The `agent-input` event
carries `{input: {id, source: 'agent'|'lifecycle', parentRunId, text, createdAt,
deliveredAt?, conversation?: {senderRunId, recipientRunId, kind, requestId?, relationship?}}}`; it is not a `user-message`, does not resolve an ask card, and
never expands registry slash skills. The queue cap is 32 **undelivered** inputs, including the in-flight reservation.
The manager batches pending conversations in FIFO order into one submission, up to
32 messages and 100,000 formatted characters, as soon as the runner admits input. An individually
valid message may exceed the aggregate limit by its attribution overhead; it is
sent alone, never split. Non-conversation inputs remain barriers. The snapshot
keeps every message ID, sender and request outcome; settled requests are labelled
without reviving them. New arrivals go in the next submission once the in-flight one
is acknowledged. A human answer that opens a new turn carries the held conversation
batch in its own write, after the answer; an answer to a native ask continues the
turn and the held batch steers right behind it.
Only one exact current state/session/batch can be in flight. ACK merges into the
current durable queue, preserving concurrent enqueues; duplicate readiness hints
cannot submit it again. All inputs in the batch receive the same acknowledgement
timestamp in one atomic checkpoint. Synchronous steer reports queued until that checkpoint.
Finish, cancellation, disposal and replacement revoke callback authority; a late
ACK cannot stamp a replacement generation or reopen a stopped run. Pending delivery
bookkeeping settles before execution finalization; it is never process-exit proof.
Fresh, queued, starting, parked and continuation sessions read the same durable
queue. Owned workers with pending asks recover without synthetic answers; only
explicit human-answer Continue can reopen them. Bare Continue cannot consume an ask.
`user-message` remains the legacy transcript of human attempts, including refused
sends; ask recovery instead replays validated `human-input-delivered` checkpoints
with the answered `askSeq`. Live sends checkpoint only on true; continuation opening
answers checkpoint at their first successful, open-session turn boundary (never
a fatal, cancelled or shutdown boundary). A checkpoint for an older
ask cannot clear a newer question; absent checkpoints retain the ask conservatively.
An accepted Finish records `human-ask-closed` (`reason: 'finish'`) with the open
`askSeq`, which retires the question as a checkpoint does without answering it
(hearsay-tools/cezarion#1260). Stop keeps the question for a human to answer.
While that exact opening answer is executing, it does not block registering a
worker or request wait. A newer question still does. Wait refusals explain the
condition and remedy; registration releases capacity only when the turn ends.

Task messages use `cez message request`, `progress`, `follow-up`, `reply`, `conversation`,
`inbox`, `cancel-request`, `wait --request`, `wait --peer` (hearsay-tools/cezarion#1995, § Waits),
and `cancel-wait` over the private delegation routes (hearsay-tools/cezarion#1991). The verb selects the kind; no `--kind` flag is needed.
`conversation <task-id> --before <cursor>` reads older history. `tasks [--all] [--offset <n>]`
lists same-project peer root tasks, excluding the caller and workers, with shared attention
and `accepts` fields, at most 32 per page. Archived peers need `--all`. Workers cannot discover
peers. `accepts: false` names why only the human can continue that peer.

Worker control stays under `cez worker`. `resume <worker-id> '<instruction>' --id <UUID>`
resumes a settled owned worker with a request. Removed worker message verbs, including
`wait --request`, exit 64 and name the message command. `cez message request --resume`
exits 64 and points to worker resume. There are no compatibility aliases.

Parent/worker conversations use the same `sendAgentInput` seam in both directions.
The root's durable conversation ledger is authoritative; `conversation-message`
`{message, delivery, deliveredAt?}` and `request-outcome` `{outcome}` events are replayable projections in
both participants' transcripts, keyed by message/request identity. Agent-input ACK
updates delivery display without creating a second conversation row. Replayed
projections never enqueue input or resolve a human ask. Attribution carries actual
sender and recipient IDs; the legacy `parentRunId` remains the ownership root.

Two root tasks of one project talk the same way (hearsay-tools/cezarion#1990, spec
`2026-10-27-task-communication-protocol` § 2). The relationship resolver in
`delegation/service.ts` admits a `family` pair (a root and its direct owned worker, checked as
before) or a `peer` pair: two root tasks in the caller's project, with different IDs, and no
history deletion pending on either family. A top-level run with no delegation record counts as
a root task; the first message it accepts writes its root record. Everything else is
`denied_scope` with one text. A new `request` or `progress` message lands in its sender's
family ledger, and a `follow-up` or `reply` in the ledger that holds its request, so a peer
request and its reply stay in the requester's ledger and a two-way exchange can use two. Peer
messages and their inputs carry `relationship: 'peer'`; family records leave the field out and
read as `family`. `AgentInput.parentRunId` holds the ledger owner. A new message ID must be
unused in its ledger, in the recipient's inputs and in either run's projections:
`RunStore.commitConversation` checks this in the write that stores the message, so of two peers
that send one ID to one recipient only the first is accepted, and the second gets
`invalid_input` and writes nothing. A peer cannot `--resume` a run, never receives a routed
question, and cannot reply to one. A send to a peer at `review`, `done`, `failed`, `cancelled`
or stopping returns `continuation-required` with "Only its human can continue it.". An open
request to a peer settles `completed-without-reply` as soon as the peer rests at `review`, and
the new outcome `deleted` when the peer's record is deleted. History, request waits and
cancellation need only the caller's own records, so a deleted peer does not block them, and an
inbox batch is checked against the caller's own record: a sender deleted before or after the
reserve leaves the batch whole. History of a peer pair merges both ledgers in `(createdAt, id)`
order and returns the newest 1,024 messages. Every open request holds ledger room for its reply, and each open peer request also holds one of its sender's 32 inbox slots: a new peer request needs a free slot, and its reply always fits; `nextBefore` names the oldest one returned, and
`before` reads the page before it. A peer message that opens a wake turn spends one unit of the
automatic-wake budget; one taken mid-turn, as steering, spends none, and family messages never
do. Past the budget a peer message stays queued and wakes nothing, and the parked run opens
Cezar's `budget` human wait. Rows **U19p** (peer attribution beside a pending question) and
**U19q** (the wake budget) in `workflows/waits-parity-cells.testkit.ts` run on every
`RUNNER_IDS` native wire; `delegation/peer-conversations.test.ts` pins the service rules.
The cockpit thread renders a peer message as a green card with a "Peer" chip, never as a user
message, so it stays apart from the yellow human message and the blue and purple worker cards,
including beside an open question. The card names the peer by title and links its thread. It
reads the peer from the server when the run list does not carry it, and a deleted or unreadable
peer shows "Deleted task" or "Task unavailable" with no link. The `deleted` outcome reads
"Recipient deleted" on the request card. A peer request is never batched with a worker request.
An older cockpit shows a peer message as a worker card with its raw outcome. Older cezar
versions reject peer inputs, peer messages and `deleted` outcomes because their strict schemas
do not know the added fields and outcome (hearsay-tools/cezarion#1993).

Kinds are `request`, `progress`, `follow-up`, and `reply`. A request's message ID is
its obligation ID; follow-ups and replies name `requestId`. Exact message retries
reuse the existing durable input; changed payloads are rejected. Follow-ups and
progress cannot discharge obligations. Explicit reply and completed-without-reply
are distinct outcomes, alongside failed, cancelled, destroyed, timed-out,
sender-closed, and (for a peer) deleted. A first reply after deadline expiry amends `timed-out` to
`replied-late`, retaining its reply ID and observation time. Other settlements
remain unchanged. The amendment emits a separate idempotent outcome projection;
it never reopens a settled wait or request.
Both roles can wait on their own requests: a request wait is a `worker` entry in the run's
wait list (`requestIds`; hearsay-tools/cezarion#1235 phase 3a), and a reply resolves only the
request wait that names it. An incoming message wakes the run with that wait still open and in
the footer, and the turn end parks on it again; unresolved obligations are retained. No message
retires a wait: since hearsay-tools/cezarion#1301 (phase 3b) the completion gate's own wait is a
list `worker` entry too, and the old `reason: 'message'` interruption is gone. A worker
progress message wakes a parent waiting for worker completion without retiring
that wait. After progress delivery the same wait parks again with its original
ID, selected workers and deadline; terminal outcomes still produce one wake.
Harness row **WP1** in `workflows/worker-wait-conversations.test.ts` exercises
repeated progress and one terminal wake through every `RUNNER_IDS` native mock
wire using `HARNESS_ADAPTERS` (hearsay-tools/cezarion#1138). Row **WP2** pins a
resumed request pending after 45 minutes within a one-hour bound and delivery of
a reply after expiry as `replied-late` on those native wires (hearsay-tools/cezarion#1241).

Root completion also checks accepted requests without outcomes (hearsay-tools/cezarion#1996).
The done answer adds `requests_outstanding` and `requests_unanswered` refusal codes.
A first done with sent requests gets a refusal naming each request, recipient and deadline.
The next done parks on a Cezar completion request wait with no wait deadline; each request's
own deadline still settles it. Use `cez message wait --request` or `cez message cancel-request`.
Incoming requests get one refusal to reply or repeat done. Repeating done permits completion;
peer requests settle `completed-without-reply` at done or review. Incoming refusal text lists up to
40 request/sender pairs and gives the omitted count; completion settles every request. Workers keep their existing
completion policy. Human Finish ignores request blockers and settles sent requests `sender-closed`.
If the provider then fails, the failure write retires the accepted Finish intent, including
a root with no peer or conversation. Recovery rewrites an older stored root record only when
its status is `failed` and its delegation still has `finishRequestedAt`: it removes that field
and keeps the failure and other delegation fields. An older cezar reads the repaired record
with the same schema and no stale Finish blocker; it cannot recover the removed intent.
Continue remains available. No schema migration or new stored field is needed.

Messages are bounded to 100,000 characters, 32 undelivered inputs per recipient,
1,024 messages per family, and 32 pending obligations. Requests and waits expire
in 600 seconds by default (1–1,800 seconds accepted). Requests sent with
`cez worker resume` accepts `--timeout-seconds 1–86400` (24 hours maximum); their default
remains 600 seconds. Set the request bound explicitly for a long review round:
a worker wait has its own deadline and does not extend the request. Several waits can be open at once (workers, CI, timers); a message wakes the run and closes none.
Ordinary sends to review/terminal recipients return `not-delivered` with an
actionable `message.instruction`; `continuation-required` means no input was
queued. The CLI exits 1 for these receipts. An active owning parent can explicitly
send a new request with `cez worker resume <worker-id> '<instruction>' --id <UUID>`
(the send route carries `resume: true`). A settled done/review/failed worker is continued through the existing
capacity scheduler with its accepted identity and a new execution revision.
Acceptance atomically records the ledger, input and continuation checkpoint.
Exact retries return the existing receipt without another continuation; retrying
a rejected ID with changed flags is a conflict, so a corrected send needs a new ID.
The opening instruction is attributed agent input, never a human answer. It is
delivered when its turn starts; retiring the opening replay prompt still waits for
the first successful open-session turn boundary. Later input steers the opening
turn instead of waiting for it. The cockpit distinguishes that confirmation from normal
transport ACK time and from the later event projection timestamp.
Stopped/destroyed workers cannot be resumed by messages; workers cannot resume
their parent. Parent review and genuine human questions still require a human.
Only a human can answer an outstanding human ask, with one exception (hearsay-tools/cezarion#505): a
worker's question (native or `CEZ:ASK`) is routed to its parent as a conversation
request carrying the question (`worker-question-routed`), and the parent's `reply`
to it answers the ask through the same seam a human answer uses, recording
`human-input-delivered` with `source: 'parent'`. Progress and follow-ups never
answer it. When the parent cannot answer (not live, no `steer` grant, at capacity,
or later settled), the worker records `worker-question-fallback` and the human
answers as before; until then human input on the worker is refused. Durable queue
insertion is atomic with acceptance, while provider acceptance and the local ACK
checkpoint retain the documented crash ambiguity below.

Already accepted input precedes automatic `CEZ:DONE` closure at a safe boundary,
not explicit Finish, cancellation, destruction or fatal failure. Empty queues
preserve ordinary completion. A completed turn with an outstanding ACK retains its
DONE intent; acknowledgement rechecks that exact idle
boundary, without requiring a phantom turn. Worker-wake reservation acquires real
capacity immediately, while only positive ACK plus checkpoint retires the durable
wait. A wake turn completed before ACK does not become running again at ACK. A temporary refusal during a late OpenCode HTTP ack
keeps accepted input queued even when the completed turn declares DONE. Rejected
OpenCode agent-input POSTs emit a fatal error before any synthetic turn boundary,
stop further delivery, and fail the run. Opening POST failure is also fatal before
its synthetic boundary, reported once; human follow-up rejection stays nonfatal.
Disk and stdin are not transactional: a failed
post-acknowledgement checkpoint interrupts the invocation and reports a persistence failure,
retaining the same input ID. Recovery may replay that identified context (at-least-once,
not exactly-once delivery); it must never silently drop it or claim success.

`SessionOptions`:

- `autoEndAfterFirstTurn?` — single-turn behavior for a headless one-shot
  `run()`. `RunManager` never sets it: every workflow agent step, the last and
  the earlier ones, controls `end()` itself and completes only on an accepted
  done (hearsay-tools/cezarion#1620).
- `shouldAutoEnd?: () => boolean` — internal synchronous veto checked when the
  auto-end timer executes, including waits accepted after it was armed. False
  holds that auto-end; a later turn may auto-end normally. `RunManager` sets no
  auto-end, so it passes no veto. Explicit end/interrupt and provider
  failures keep their existing semantics; a timer is never termination proof.
- `onAgentInputConsumed?: (inputIds) => void` — the model received these inputs
  (hearsay-tools/cezarion#505). At most once per ID; never from a transport acknowledgement.
- `onAgentInputReady?: () => void` — optional in-process retry hint, NOT delivery
  acknowledgement or completion. Only a successful late reply/prompt at an idle,
  open session with no queued human prompt emits it. The manager checks current session identity, pending asks,
  lifecycle and reentrant/duplicate drains; stale/disposed sessions are ignored.
- `onUiEvent?: (e: UiEvent) => void` — the **v2 channel**. It receives the
  normalized `UiEvent` stream emitted alongside the v1 `AgentEvent`s passed to
  `onEvent`. A runner that omits `onUiEvent` support degrades to v1-only — but a
  first-class backend MUST wire it (see §8).

### `AgentRunSpec`

The input to a run. Backend-agnostic; each runner translates it to its transport.
Notable fields (full doc-comments in the source):

- `userPrompt` (required), `systemPrompt?`, `images?` (first-message content
  blocks — pasted screenshots), `cwd` (the run dir and the only writable root),
  `model?`, `timeoutMs?`, `env?` (merged over `process.env` — carries
  `CEZ_HANDOFF_FILE` / `CEZ_ARTIFACTS_DIR` / `CEZ_TASK_ID`).
- `toolGrant` / `additionalDirectories?` — tool access. `toolGrant` is required: a `ToolGrant`
  of kind `unset`, `step-default`, `inherited` (a worker's pinned grant) or `explicit`, each with
  an optional `bashAllowlist`. Each runner switches on the kind, so a new kind fails to compile
  until every runner maps it (hearsay-tools/cezarion#1810).
  **Caveat (open-mercato/cezar#430):** the zero-config default (`DEFAULT_ALLOWED_TOOLS`) includes
  unrestricted `Bash`, and Codex/OpenCode do not honor `toolGrant` at all.
  Treat the default `auto` permission mode as full shell access, not a
  sandbox: unmanaged Codex uses `danger-full-access` and keeps the user's approval
  policy (approvals reach Needs you), and OpenCode's own permission config
  governs. cezar answers OpenCode's built-in asks (outside-worktree reads, `.env`
  reads, the repeated-call guard) with a once reply unless the user's config has
  a rule for that permission, and shows any other ask as a cockpit permission
  card (hearsay-tools/cezarion#1266). Configurable restrictive modes are
  specified by `2026-07-17-permission-modes` (open-mercato/cezar#475).
- `restrictNativeDelegation?` — optional per-invocation intent, mapped only inside
  adapters; absent preserves ordinary settings. Governed session provisioning
  supplies it on initial steps, Continue and recovery. See D1 below for precise
  controls and exemptions; this is not a shell sandbox.
- `sessionId?` / `resume?` — stable session id for interactive takeover and for
  `--resume` ("Continue" after a run ends).

**Per-runner support declarations (hearsay-tools/cezarion#284).** Not every field crosses every wire,
and the seam says so in code rather than only in the caveat above: every runner
carries `specSupport: AgentRunSpecSupport` — one entry per `AgentRunSpec` field,
either `{ honored: true, via }` naming the flag, request field or process option
the field becomes, or `{ honored: false, reason }` naming the wire limitation or
the product decision that left it unmapped ("not implemented yet" is never a
reason). `AGENT_RUN_SPEC_FIELDS` is the same field list at runtime, typed as a
full `Record` over `keyof AgentRunSpec`, so adding a field to the spec is a
compile error until every runner declares it, and a new runner class without a
declaration does not compile at all. The constants (`CLAUDE_SPEC_SUPPORT`,
`CODEX_SPEC_SUPPORT`, `OPENCODE_SPEC_SUPPORT`, `PI_SPEC_SUPPORT`, `CURSOR_SPEC_SUPPORT`,
`OMP_SPEC_SUPPORT`, each next to its class) are the source; §7's spec-support rows hold each one against the runner's
real boundary in both directions. As declared at hearsay-tools/cezarion#284, a reading aid only:

| Field | claude | codex | opencode | pi |
| --- | --- | --- | --- | --- |
| `systemPrompt` | `--append-system-prompt` | prepended to the opening input | prepended to the opening prompt | `--append-system-prompt` |
| `userPrompt` | first stdin message | `turn/start` input | `prompt_async` text part | RPC `prompt` message |
| `images` | first stdin message | **dropped** | **dropped** | RPC `prompt` images |
| `cwd` | spawn cwd | spawn cwd, `thread/start` cwd | spawn cwd | spawn cwd |
| `toolGrant` | `--allowedTools`; a `bashAllowlist` as `Bash(<prefix>:*)` | **dropped** | **dropped** | `--tools`, mapped names; a `bashAllowlist` drops `bash` (fail closed) |
| `additionalDirectories` | `--add-dir` | **dropped** | **dropped** | **dropped** |
| `restrictNativeDelegation` | D1 | D1 | D1 | D1 |
| `env` | child env | child env | child env | child env |
| `model` | `--model` | `thread/start` model | `prompt_async` model | `--model` |
| `effort` | `--effort` | `turn/start` effort | `prompt_async` variant | `--thinking` |
| `timeoutMs` | kill switch | kill switch | kill switch | kill switch |
| `sessionId` | `--session-id` / `--resume` | `thread/resume` threadId | **dropped** | `--session-id` / `--session` |
| `resume` | `--resume` | `thread/resume` | **dropped** | `--session` |

`OMP_SPEC_SUPPORT` honors every field (it has no column here): `toolGrant` through `--tools` with
OMP names (or `--no-tools`), `additionalDirectories` through `--add-dir` (Pi drops it), `effort`
through `--thinking`, and `sessionId` only as `--resume <id>`: OMP has no `--session-id`, a fresh
session mints its own id and the runner reads it from `get_state`.

**System prompt channel** — a backend without a dedicated system-prompt input
must deliver `spec.systemPrompt` as a leading block of the opening user message.
Use the shared helper so the mapping is uniform:

```ts
prependSystemPrompt(spec.systemPrompt, spec.userPrompt)
// claude:          --append-system-prompt   (native channel, do NOT prepend)
// codex / opencode: prepended here
```

`ContentBlock` mirrors the Anthropic wire format (`text` | `image` base64) so it
can be written to the claude CLI's stdin verbatim.

---

## 2. v1 `AgentEvent` — the flat stream

The original normalized stream. Still emitted by every runner, still persisted,
still rendered by `cezar run`. **Do not remove or rename a variant** — v1 event
`type` strings are part of the on-disk NDJSON format.

```ts
type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; tool: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; result: string; isError: boolean }
  | { type: 'image'; mediaType: string; data: string }        // base64; run manager re-emits a URL
  | { type: 'token-usage'; tokensUsed: number }
  | { type: 'cost'; usd: number }
  | { type: 'session'; sessionId: string }                    // backend's real session id, once known
  | { type: 'turn-end'; unconsumedInputIds?: readonly string[] } // hearsay-tools/cezarion#505
  | { type: 'input-unconsumed'; inputIds: readonly string[] }    // hearsay-tools/cezarion#505: out-of-turn unread report
  | { type: 'note'; message: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

Every v1 event stays **derivable** from the v2 stream, so a consumer can migrate
one panel at a time. New work should read v2; v1 exists for the console renderer
and old recordings.

### Cezar-owned run metadata events

`provider-auth-required` is not emitted by a backend runner. The server derives it
from an authoritative v1/v2 authentication error, persists a provider id, opaque
incident id, and optional `stepId`, and the cockpit renders recovery guidance. It
does not change backend parity or expose the raw error.

---

## 3. v2 `UiEvent` — the normalized protocol (`packages/cezar/src/core/ui-events.ts`)

Pure vocabulary: no runtime imports, no runner coupling. Mirrored into the
api-client package at `packages/api-client/src/protocol/ui-events.ts`; the mirror is **checked**,
not trusted — `packages/cezar/src/server/api-types.test.ts` asserts type-exactness between the
two, so drift fails `npm run typecheck` (the gate) rather than the UI at runtime.

### Design rules baked in

1. **Item-lifecycle model** (Codex/ACP style): one stable `id` per item with
   `started → delta → updated → completed` phases. Codex and OpenCode are
   natively item-shaped; Claude maps trivially. Every `RUNNER_IDS` backend implements
   this lifecycle through its mapper.
2. **ACP vocabulary** wherever a choice is arbitrary (tool status/kind, plan
   entries, diff shape, stop reasons) — ecosystem alignment.
3. **Per-capability degradation, never per-backend** — see §6.

### The item model (one id-keyed stream for text, reasoning, tools and hooks)

```ts
type UiItem = UiMessageItem | UiReasoningItem | UiToolItem | UiHookItem;
```

- `UiMessageItem` — `kind:'message'`, `role`, `text`, `phase?:'commentary'|'final'`.
- `UiReasoningItem` — `kind:'reasoning'`, `text` (extended thinking / reasoning summary).
- `UiToolItem` — `kind:'tool'`, `name` (backend tool name), `toolKind`, `title`
  (human line computed once — see §5), `status`, `input?`, `output?`, `error?`,
  `diffs?: FileDiff[]`, `locations?`, `exitCode?`, `parentItemId?`.
- `UiHookItem` — `kind:'hook'` (hearsay-tools/cezarion#961), one native hook run:
  `event` (PascalCase: `SessionStart`, `PreToolUse`, `Stop`), `name?` (native label
  when richer, `PreToolUse:Bash`), `source?` (hook definition path), `status`
  (`completed|failed|blocked|cancelled`), `entries: {kind, text}[]` (what the agent
  received: `context|feedback|warning|error|stop`), raw `stdout?`/`stderr?`,
  `exitCode?`, `durationMs?`, `parentItemId?`. Emitted **once**, as `item.completed`,
  and only when visible: `status !== 'completed'` or `entries` is non-empty
  (`hook-items.ts` `isVisibleHookItem`). A silent successful hook, or one printing
  only control JSON (`{"continue":true}`), is never emitted. Hook items are v2-only
  and never touch run state: no turn, park, wake, Needs You, ASK or completion path
  reads them.

`parentItemId` nests subagent work under the tool item that spawned it (claude
`parent_tool_use_id`, opencode `subtask` parts, Codex collaboration receiver
thread ids).

### Enumerations

```ts
type ToolStatus = 'pending' | 'running' | 'completed' | 'failed' | 'declined';
type ToolKind   = 'read'|'edit'|'delete'|'move'|'search'|'execute'|'think'|'fetch'|'task'|'plan'|'other';
type StopReason = 'end_turn'|'max_tokens'|'refusal'|'cancelled'|'timeout'|'error';
type PlanStatus = 'pending' | 'in_progress' | 'completed';
```

Supporting shapes: `PlanEntry` (`content`, `status`, `priority?`, `activeForm?`),
`TokenUsage` (raw `input`/`output`/`cacheRead?`/`cacheWrite?`/`reasoning?`/`total`,
`contextWindow?` — **never pre-weighted**; cost weighting is a presentation
concern), `FileDiff` (`path`, `oldText: string|null` where `null` = newly
created, `newText?`, `unified?`), `ToolLocation`, and the reserved
`PermissionOption`/`PermissionOptionKind`.

### The events

```ts
type UiEvent =
  | UiSessionStartedEvent    // 'session.started'  — sessionId, backend, model?, cwd?, tools?
  | UiSessionEndedEvent      // 'session.ended'    — reason: StopReason (replaces v1 done / fatal error)
  | UiSessionErrorEvent      // 'session.error'    — message, fatal (v1 note + error unified)
  | UiTurnStartedEvent       // 'turn.started'     — turnId
  | UiTurnCompletedEvent     // 'turn.completed'   — turnId, stopReason, usage?, costUsd?
  | UiItemStartedEvent       // 'item.started'     — item (tools usually pending/running)
  | UiItemDeltaEvent         // 'item.delta'       — itemId, field:'text'|'reasoning'|'output', delta
  | UiItemUpdatedEvent       // 'item.updated'     — item (status flips, streamed snapshots)
  | UiItemCompletedEvent     // 'item.completed'   — item (final snapshot, safe to persist)
  | UiPlanUpdatedEvent       // 'plan.updated'     — entries: PlanEntry[] (FULL replacement, ACP semantics)
  | UiPermissionRequestedEvent  // 'permission.requested' — native approval choices
  | UiPermissionResolvedEvent   // 'permission.resolved' — human decision or expiry
  | UiAskRequestedEvent      // 'ask.requested'    — requestId, questions[] (AskUser; the cockpit renders option chips)
  | UiUsageUpdatedEvent      // 'usage.updated'    — usage: TokenUsage, costUsd? (cumulative-for-session)
  | UiImageEvent;            // 'image'            — itemId?, mediaType, data (base64; manager re-emits URL)
```

**AskUser (`ask.requested`, open-mercato/cezar#473, open-mercato/cezar#565).** The portable path remains
backend-neutral: the agent asks a structured
multiple-choice question by ending a turn with a `CEZ:ASK <json>` control marker
(a sibling of `CEZ:DONE` / `CEZ:MONITORING`); the RunManager detects it on the
*assembled* turn text — uniform across `RUNNER_IDS` with no mapper
work — validates the payload (`packages/cezar/src/core/ask.ts`, modeled on Claude Code's
`AskUserQuestion`: 1–4 questions, 2–4 options each, `header` ≤12 chars), emits
  `ask.requested` and parks the run `waiting`. A mid-turn `sendMessage` that a
  backend queued until idle is dropped (`AgentSession.discardQueuedMessages`) so
  that waiter cannot start a new turn after the question. The cockpit renders clickable option
chips; the user's pick (or a free-form reply) rides the normal reply seam
(`POST /api/runs/:id/messages`), and the card resolves client-side when that
message lands (no `ask.resolved` event). Codex additionally bridges its native
`item/tool/requestUserInput` server request onto the same event and routes the
next answer back as the documented JSON-RPC response. Malformed or unsupported
Codex native requests receive an error response rather than hanging the turn.
OpenCode likewise bridges its native `question` tool: the runner discovers the
main session's pending request through `GET /question`, emits `ask.requested`,
and routes the next answer to `POST /question/:id/reply`; malformed question
input emits no ask card and is rejected through `POST /question/:id/reject` so
the native turn cannot remain blocked. If the pending request cannot be found,
the runner terminates the turn instead of hanging. A malformed marker degrades
to plain text — the prose fallback is never made worse. A native `AskUserQuestion`
control-protocol bridge for claude (the `control_request can_use_tool` path) is a
possible future enhancement; the marker is the portable baseline.

`item.completed` carries **snapshots**, not deltas — safe to persist. `item.delta`
carries **appends** to one field of a live item and must not be persisted as a
standalone truth.

---

## 4. Per-backend mapping (summary)

Each backend has a mapper (`packages/cezar/src/core/<backend>-ui-mapper.ts`) turning its wire
transport into `UiEvent`s. The authoritative table is
`agent-event-protocols.md` §7.1; the load-bearing rows:

| v2 event / field | claude (stream-json) | codex (app-server JSON-RPC) | opencode (serve HTTP+SSE) |
|---|---|---|---|
| `session.started` | `system/init` (model, tools, cwd) | `thread/started` / `thread/start` result | `POST /session` response |
| `turn.started` | each stdin user message | `turn/started` | each prompt POST |
| `turn.completed` + `stopReason` | `result` subtype (`success→end_turn`, `error_max_turns→max_tokens`, `error_during_execution→error`) | `turn/completed→end_turn` (failed status or provider error → `error`), `turn/failed→error`, interrupt→`cancelled` | `session.idle→end_turn` (or `error` if a failure `session.error` preceded) |
| message item | `assistant` `text` blocks (deltas via `--include-partial-messages`) | `agentMessage` items | text parts |
| reasoning item | `thinking` blocks | `reasoning` items (+ `textDelta`) | `reasoning` parts |
| tool item | `tool_use`→running, `tool_result`→completed/failed, `permission_denials`→`declined` | `commandExecution`→execute (+`exitCode`, `outputDelta`), `fileChange`→edit (`diffs`), `mcpToolCall`→other, `webSearch`→fetch, collaboration spawn→task | tool parts (state `pending/running/completed/error→failed`, `patch` parts→`diffs`) |
| `item.delta` `output` (live terminal) | *(none — card fills on completion; per-capability degradation)* | `item/commandExecution/outputDelta` | running-state metadata |
| `plan.updated` | `TodoWrite` input | `todoList` / `plan` items | `todowrite` tool |
| `ask.requested` | portable `CEZ:ASK` marker | portable marker + native `item/tool/requestUserInput` | portable marker + native `question` tool (`GET /question`, `POST /question/:id/reply`) |
| hook item | `system/hook_response` (`--include-hook-events` when `--help` lists it; without it only SessionStart/Setup). Entries parsed from JSON stdout: `additionalContext`→context, `systemMessage`→warning, block `reason`/`stopReason`/deny `permissionDecisionReason`→stop, ask reason→feedback; plain stdout→context. Stdout yields entries on exit 0 only (Claude ignores it otherwise; it stays raw output). Exit 2, `decision:block`, `continue:false`, deny→`blocked` | `hook/completed` (`run.entries` verbatim, `sourcePath`→`source`, `stopped`→`cancelled`) | *(none — plugin hooks run in-process)* |
| subagent nesting (`parentItemId`) | `parent_tool_use_id` | collaboration receiver thread id (review mode remains childless) | child-session parts under a `subtask` |
| `usage.updated` | `result.usage` + `total_cost_usd` | `thread/tokenUsage/updated` (no USD) | `message.updated` tokens/cost + `step-finish` |

**Mapper robustness contract.** Inputs come off the wire and may be `null`,
partial or malformed. A mapper **must never throw**: unparseable NDJSON lines are
skipped (`packages/cezar/src/core/ndjson.ts` + the mapper), unknown message/content types
produce **no events**, and malformed entries in a `plan.updated` payload are
filtered out (a non-array plan emits no plan event at all). Mapper state is
**explicit and immutable** — each mapper's map function takes `(frame, state)`
and returns `{ events, state }`, never mutating the passed-in state
(`mapClaudeMessage` / `mapCodexNotification` / `mapOpencodeEvent`, each paired
with a `create<Backend>UiState`; see the claude mapper's "state carries across
messages" tests).

---

<a id="cursor-acp-264"></a>

### Cursor print (hearsay-tools/cezarion#590)

`CursorRunner` selects print for new sessions only after the installed binary
passes a pre-inference check (hearsay-tools/cezarion#1257): its version is a
dated build from `2026.10.01-e373342` or newer, it rejects an invalid native
tool with its `Expected one of:` catalog, and that catalog still lists the core
print tools (`CORE_CURSOR_PRINT_TOOLS`). Every Cursor process cezar starts
passes the hidden `--disable-auto-update` option, so a session never updates
the CLI under itself; a build that rejects the option runs without it. Each
turn launches `agent --disable-auto-update -p --force --trust --output-format
stream-json`; subsequent turns use `--resume` with the exact recorded native
session ID. A mismatch fails the run. Transport identity is persisted with the
native ID and account, so Continue and recovery retain the original transport.
Untagged legacy Cursor sessions use ACP. Unqualified new sessions also fall back
to ACP with a visible note that marketplace plugins are unavailable.

The print invocation supplies the run's Cezar tools through a private temporary
plugin directory and accepts the user's existing Cursor marketplace plugins.
Governed runs pass a strict `--allowed-tools` list: the qualified safe catalog,
narrowed to the entries the installed build still advertises. Native delegation
tools are never in it, and an entry a newer build adds stays denied until a
change adds it to the catalog. The list is computed afresh against each CLI
build before every print session, Continue included. `CEZ:ASK` is parsed by Cezar and remains
answerable; this Cursor build auto-skips native questions from plugins, which
is a visible limitation. Print mode has no child-session transcript or
qualified token usage. Project-local Claude settings do not reliably disable
a user/team marketplace copy, and Cursor may silently lose history under an
otherwise valid ID; Cezar only verifies the returned ID.

Print model admission retains the canonical IDs discovered by the read-only
`cursor/list_available_models` extension (hearsay-tools/cezarion#987). When a
canonical ID is absent from `--list-models`, preflight reads that owning account's
native parameter keys, values and defaults. Explicit effort becomes a complete
`--model` variant selection, such as `grok-4.6[effort=high,fast=true]` or
`gpt-5.4-mini[reasoning=high]`; partial overrides are not qualified for this build.
Other parameters retain advertised defaults. Unknown models, unsupported effort
and incomplete defaults fail before inference. IDs with embedded parameters retain
those selections in the same bracket group; explicit effort replaces the embedded
effort, and other advertised defaults fill missing parameters. Malformed or
duplicate embedded parameters fail before inference. The validated native selection
is kept for every print turn and revalidated under the pinned account on Continue.
Advertised legacy IDs keep their existing variant-selection path. The discovery
child has a finite startup bound and is terminated when selection is cancelled.

### Cursor ACP (hearsay-tools/cezarion#264)

`cursor-acp-runner.ts` launches `agent --force acp` and holds one JSON-RPC stdio
connection across prompts. `initialize` precedes `session/new` or `session/load`;
`session/set_model` preserves the selected model ID. Only the response to the
matching `session/prompt` completes the parent turn. Resume history is suppressed
before the opening prompt, so Continue cannot replay old terminal markers.

`cursor-ui-mapper.ts` maps ACP message/thought chunks, tool calls and updates,
structured diff content, plans, and Cursor todo/task extensions. Child updates
are attributed through `subagent_spawned` metadata and cannot enter parent v1
text. Native `cursor/ask_question` keeps its request ID until a human reply;
nonhuman input never answers it. Option labels map back to the original option
IDs. Free text skips the choice request and follows as a new prompt. Plan
approval displays the plan and asks explicitly. After a human native answer,
a successful markerless `end_turn` resumes once on the same session without a
second human prompt (hearsay-tools/cezarion#383). An already queued human prompt takes precedence;
rejection remains rejection. Pending asks, DONE/MONITORING markers and non-success
stop reasons prevent this automatic resume. The intermediate ACP boundary remains
in v2 turn accounting but emits no v1 idle handoff. Ordinary markerless turns
without a native answer still yield to the human; completion requires `CEZ:DONE`.
Unknown RPC methods receive a
method-not-found error rather than leaving the provider blocked.

Wire evidence: [Cursor ACP documentation](https://cursor.com/docs/cli/acp),
[ACP schema](https://agentclientprotocol.com/protocol/v1/schema), and the installed
Cursor CLI `2026.09.15-d2fe57e` ACP implementation. That build catches provider
errors as an assistant chunk beginning `\n\nError: ` and then returns
`end_turn`; the runner classifies this exact envelope as a sanitized failure.
The local probe confirmed this with a TLS transport rejection.

**Telemetry limitation:** this Cursor build emits no token usage, and its prompt
response contains only `stopReason`. ACP's optional `usage_update` describes
context occupancy, not cumulative token consumption. Cezar reports no invented
usage: the UI usage rows and harness S4 carry named, inverse-asserted wire-gap
exemptions. Other matrix rows remain required. Revisit these exemptions when
Cursor exposes directional token usage; the fixtures document their sources.

Cursor initializes with `_meta.parameterizedModelPicker: true`. It captures session
`configOptions` and `config_option_update` snapshots, then maps generic effort to
an advertised `effort`, `reasoning`, or `reasoning_effort` select value through `session/set_config_option`.
It verifies the returned current value before inference; unsupported effort fails.
`--model` pins the initial model before the ACP session is built. Advertised model
config options are preferred, with opaque IDs and legacy `session/set_model` retained
for compatibility. Read-only `cursor/list_available_models` supplies base models and
parameter options; older CLIs fall back to `--list-models` without guessed effort.
Per-session tool/command allowlists remain unsupported. Additional roots use
`--add-dir`; Cursor's native defaults remain authoritative when no model/effort is pinned.

Verified on Cursor `2026.09.15-d2fe57e`: Sonnet exposes `effort`, GPT-5.4 Mini exposes
`reasoning`, and a live Cezar runner turn with `reasoning=low` completed successfully.
See [ACP Session Config Options](https://agentclientprotocol.com/protocol/v1/session-config-options).

---

### OMP RPC (hearsay-tools/cezarion#595)

`omp-runner.ts` launches `omp --mode rpc` and holds one persistent JSONL connection, like Pi.
OMP is a Pi fork with its own dialect, so it is a standalone runner, mapper and mock (Pi files
are untouched; pure helpers proven identical to Pi's are copied with a comment naming the Pi
function). Design record: `.ai/specs/2026-10-02-omp-runner.md`, wire contract oh-my-pi
v18.4.11 `docs/rpc.md` and `rpc-types.ts`.

`omp-ui-mapper.ts` is the pure mapper. The load-bearing differences from Pi:

- **No `agent_settled`.** The turn ends at `session_settled`, or at a `prompt_result`
  `agentInvoked: false` (or a `prompt` response carrying it) for the prompt that **opened** the
  turn. `agent_end` is never a boundary: it also fires with `yielded: false` while OMP retries,
  compacts or answers a reminder. A steer OMP completes locally, or that fails after admission,
  does not end the running turn. A `prompt` response with `success: false` (pre-admission, no
  `prompt_result` follows) emits one non-fatal `session.error` and ends the turn only when it
  answers the opening prompt; the mapper remembers the id so a later `prompt_result` does not
  duplicate the error.
- **Result-based diffs and plan.** Edit/write diffs come from the tool **result** `details`
  (`path`, `oldText`, `newText`, `perFileResults[]`; default `edit.mode` is `hashline`, whose args
  are only `{input}`), falling back to replace-mode args. `plan.updated` comes from the `todo`
  result `details.phases[].tasks[]` (`abandoned` is `cancelled`, `blocked` is `pending`).
- **Sub-agents** stream as `subagent_lifecycle` / `subagent_event` after
  `set_subagent_subscription {level: "events"}`. Children nest under their `task` call by
  `parentItemId` and never reach v1 text or end the parent turn (S9). A batch `task` call
  (`args.tasks[]`) becomes one synthetic task item per sub-agent (`<toolCallId>#<id>`) so the
  Agents drawer shows N rows. A child event that arrives before its lifecycle frame is held in a
  bounded buffer (200 frames, 8 ids) and replayed.
- **Ignored frames:** `ready`, `extension_ui_request` (`setWidget` and friends, sent unsolicited
  at startup in plain rpc mode), `advisor_cost_changed`, `available_commands_update`, `queue_update`,
  `auto_*`, `cache_warming_*`. The wire stays on protocol v1; opt in to
  `set_event_filter {messageUpdates: "delta"}` to drop per-delta snapshots.
- **Ask** is the portable `CEZ:ASK` marker: plain `--mode rpc` never builds OMP's native ask tool.
- Startup writes `get_state`, `set_steering_mode all`, `set_subagent_subscription events`,
  `set_event_filter`, then the first `prompt`. A fresh session's id comes from `get_state`;
  Continue uses `--resume <id>`.

Tools: `--tools` is an allowlist validated against OMP's registry, so cezar maps names onto OMP's
(`TodoWrite` to `todo`; `WebFetch` has no web-only equivalent and is dropped) and drops anything unmapped with one v1 `note`;
`allowedTools: []` is `--no-tools`. The zero-config default adds `todo, lsp, ast_edit, task, wait`
to the cezar defaults. `find` and `ast_grep` are gated behind settings that default off and are
**not** in it: naming an unavailable built-in exits 2. When settings the user chose disable a
named tool, the runner respawns once without exactly those names, keeping accepted input in a
stdin outbox so none is lost. MCP tools: OMP registers `mcp__<server>_<tool>` (one underscore,
lowercased and sanitized), so a Claude-spelled grant `mcp__<server>__<tool>` is translated before
it reaches `--tools`. OMP validates `--tools` right after its 250 ms RPC MCP discovery window, so a
slow server's tool can still read as unknown: the same one-time respawn also drops the `mcp__`
names this spawn passed from an `Unknown tool(s) in --tools: a, b.` refusal, with one v1 `note`
for everything dropped. Any other unknown name stays fatal, and the respawn never widens.

Models: `omp models --json` prints an object, `{"models": [...]}`, which feeds discovery and the
provider status probe (empty means not logged in). Settings, MCP and memory files are edited from
Settings → Agent config, including OMP's YAML config.

Verified on the real binary: `omp/18.4.11` startup frames, the `set_*` acknowledgements,
`omp models --json`, `--tools` refusals and `get_state.dumpTools`. **Not verified live:** no
model turn ran, so turn fixtures and `inputDelivery` are source-derived with citations (the
fixtures README separates observed from constructed lines).

---

## 5. The tool display model (`packages/cezar/src/core/tool-display.ts`)

`toolDisplay(name, input)` turns a backend tool name + raw input into
`{ toolKind, title, subtitle? }`, computed **once** in the protocol layer (never
in components) so the thread, activity groups and notifications all say the same
thing. It is a pure function over untrusted input and **must never throw**. Tool
names are matched case-insensitively, so claude's `Bash` and opencode's `bash`
share one row; unknown tools keep the backend's name as the title with a
heuristic subtitle. `mcp__server__tool` names collapse to `server.tool`.

---

## 6. Backend parity — the hard rule (`packages/cezar/src/core/ui-parity.test.ts`)

> Every capability in the parity matrix MUST be emitted by **every**
> backend, so the GUI degrades **per-capability, never per-backend**.

This is made executable: `ui-parity.test.ts` asserts each capability over each
backend's golden-fixture expected output. If a mapper change drops a capability —
or a new fixture set forgets one — a named row fails. The matrix:

- `plan.updated` with entries (TodoWrite / todoList / todowrite)
- tool status `running`, `completed`, `failed`
- reasoning items (thinking / reasoning items / reasoning parts)
- structured diffs (Edit input / fileChange.changes / patch parts)
- sub-agent task items (Task / review-mode span / subtask parts) — one item per
  sub-agent: codex's `enteredReviewMode`/`exitedReviewMode` pair folds into a
  single `task` item with a running→completed lifecycle, so a consumer counting
  task items counts agents, not frames (spec
  `.ai/specs/2026-07-20-grouped-subagent-display.md`, open-mercato/cezar#474)
- `usage.updated` with raw token counts
- `turn.completed` with a `stopReason`
- sub-agent **nesting** via `parentItemId` where the upstream wire attributes
  child work to a parent
- hook items (`hook_response` / `hook/completed`, hearsay-tools/cezarion#961) — Claude
  and Codex only. OpenCode 1.18.35, Pi 1.0.4, OMP 18.8.0 and Cursor
  2026.10.01-e373342 run hooks in-process or report none, and carry the named
  `NO_HOOK_TELEMETRY` exemption with an inverse assertion

A new backend must produce every row its wire supports. A genuine upstream gap
requires a named, versioned exemption with an inverse assertion; Cursor token
telemetry above is the first UI-matrix exemption. Missing implementation is never
a wire gap.

That covers what a mapper EMITS. The other half of the same requirement — what a
runner DOES — is §7, and a new backend has to satisfy both.

<a id="waits"></a>
<a id="ci-wait-tool-contract-474"></a>

## Waits (hearsay-tools/cezarion#1233, hearsay-tools/cezarion#1234; CI since hearsay-tools/cezarion#474)

A run's waits live in one list on its record (`waits`, settled ones in `lastWaits`),
typed by `packages/contract/src/waits.ts`; spec `.ai/specs/2026-10-17-unified-waits.md`.
There are five agent kinds: `pr`, `timer`, `human` (since phase 2), `process`
(hearsay-tools/cezarion#1446) and `peer` (hearsay-tools/cezarion#1995); Cezar also opens `worker`
waits. The agent opens `pr`, `timer`, `process`, `worker` and `peer` waits with `cezar_wait`
and a human wait with `cezar_ask`. A wait is an observation the agent asked for;
it never grants merge, review acceptance, or task-completion authority. There is no
wait marker and no delegation prerequisite. `claude-cli` uses the Claude adapter.

`cezar_wait({ kind: 'pr', pr, until?, wake_on_conflict?, timeout_seconds? })` registers an
external PR observation (hearsay-tools/cezarion#1425 renamed `kind: 'ci'` to `'pr'`; `'ci'` is
`invalid_request`). `pr` is an HTTPS GitHub PR URL (at most 2,048 characters, positive PR
number, no userinfo, port, query or fragment); `timeout_seconds` is an integer
1–7,200, default 1,800. `until: 'checks'` (default) watches the PR's checks; `until: 'merge'`
polls the PR's state every 30 seconds, outside the watcher slots, and resolves `merged` only on
GitHub's `MERGED` state (with `mergedAt` and `mergeCommitSha` when GitHub gives them) or
`closed` when the PR closed without merge. `wake_on_conflict` (default `true`) ends either
target as `conflicting` on merge conflicts; an agent watching a PR it does not own sets it
`false`. A checks wait and a merge wait on one PR are two waits. `cezar_wait({ kind: 'timer', seconds, note? })` opens a
timer of 60–7,200 seconds with a note of at most 512 characters. Unknown keys, a
field that does not fit its kind, and `kind: "human"` are `invalid_request`; the last one's
message names `cezar_ask`. `cezar_wait({ kind: 'process', pid, exit_file?, timeout_seconds?, note? })`
waits for a background job the agent started to end (hearsay-tools/cezarion#1446). Cezar checks
the exit file, then whether the PID, with its recorded start identity, still runs, every
5 seconds until the deadline (default 1,800, at most 7,200 seconds). It reports `exited with code N`
from the exit file's first line, or `exited, code unknown`, and never signals or stops the
process. `exit_file` must resolve inside the task worktree or the task temp directory
(`exit_file_outside`); Cezar's own PID and a session leader are `process_not_allowed`, and
another user's process is `process_not_owned`. A process wait keeps its slot and counts
against the automatic-wake budget, like a timer. The tool advertises one flat object schema, because the Anthropic
tool API refuses a top-level union; the server validates the discriminated union. Every
answer carries the wait id, its kind, its absolute deadline and `open_waits`.

`cezar_wait({ kind: 'worker', worker_ids, mode?, timeout_seconds? })` waits on owned workers, and
`cezar_wait({ kind: 'request', request_ids, mode?, timeout_seconds? })` on the replies to requests
the run sent, to a worker, its parent or a peer task (hearsay-tools/cezarion#1995). Kind `worker`
takes `worker_ids` only: `request_ids` there is `invalid_request`, whose message names kind
`request`. A request wait is still stored as a `worker` entry with `requestIds`; the answer's
`kind` is `request`, and the footer and `open_waits` call it a `request wait`.
`cezar_wait({ kind: 'peer', peer_ids, timeout_seconds? })`, or
`cez message wait --peer <task-id> [--peer <task-id> …] [--timeout-seconds <1-1800>]`
(`via: 'cez-message-wait'`), waits for named peer root tasks (hearsay-tools/cezarion#1995, spec
`2026-10-27-task-communication-protocol` § 7). It names 1–32 peers; each must pass the
relationship resolver as a peer, so an unknown task, the run itself, a worker, or a family
deleting its history is `denied_scope`, and a worker cannot register one. The deadline is
1–1,800 s, default 600, and there is no "any peer" form. The first of these resolves it: a
message of any kind from a named peer that the run has not received (`result.reason: 'message'`,
with `peerRunId` and `messageId`), a named peer reaching `review`, `done`, `failed` or
`cancelled` or being deleted (`settled`, with `peerRunId`), or the deadline (`timeout`). A message
comes before a settlement, so a peer that wrote and then finished reports what it wrote. A
matching message or settlement already there at registration resolves it at once, and recovery
re-reads it the same way. It is the one wait a message closes: a human message, a message from
the run's parent or workers, a peer it does not name, and any other wait resolving wake the run
and leave it open. The same peers in any order return the open wait. A park whose top wait is a
peer wait (`waiting:peer`) holds no slot, arms the idle timer, and reads **waiting on N tasks**
(`waitingOn: { kind: 'peers', count }`, bucket `none`, never Needs you); the order is human >
usage limit > workers > peers > PR > process > timer. A resolution that opens a wake turn spends
one unit of the automatic-wake budget, as a peer message does; with the budget spent it is
cancelled with the note `automatic peer wake-up cap reached`, and Cezar's `budget` human wait
opens. A root's request wait on a request to a peer task reads **waiting on replies**, not
**waiting on worker replies** (`waitingOn.peers`). `cez message cancel-wait` and
`cezar_cancel_wait` cancel it through the list. Tests: `workflows/peer-waits.test.ts` drives each
`waiting:peer` row of `workflows/run-states.ts`, and parity row **U19w** in
`workflows/waits-parity-cells.testkit.ts` runs it on every `RUNNER_IDS` native wire.

An older cezar reads a stored peer wait as an unreadable entry: its strict wait union has no
`peer` arm, so the store drops that entry, keeps the run and its other waits, and sets
`lastWaitsError`. A run parked only on a peer wait then reads as a plain park: Needs you. A
stored summary whose `waitingOn` is `peers` fails the older
summary schema, so its run index reads the full record instead. `runs/peer-wait-downgrade.test.ts`
pins this read (hearsay-tools/cezarion#1993).

`cezar_ask({ context, questions })` waits for the user (hearsay-tools/cezarion#1234). Both are
required. `context` is 1–20,000 characters of Markdown that the cockpit shows above the card.
`questions` is a card in the ask format, 1–4 questions, each with a header of at most 12
characters, the question, and 2–4 options with unique labels. A question with its `options`
left out is open: the cockpit shows only an answer field and sends `header: text`. An empty or
one-option list is `invalid_request`, never an open question, and `multiSelect` applies only
to options. The answer carries the wait id and `open_waits`, with no deadline. The ask line
takes open questions too, since both share `askRequestSchema`. The ask line takes an optional
`context`; native asks carry none.

On Claude, assistant text written between tool calls can reach Cezar only as a short server
summary (hearsay-tools/cezarion#1458), and the user never sees the agent's reasoning or a
rejected call's arguments (hearsay-tools/cezarion#1428). So the lifecycle instructions, the
tool description and its hints tell the agent to put the full draft, findings, evidence and
option meanings in `context`. Cezar stores `context` on the human wait and the
`ask.requested` event, and a worker's routed question carries it to the parent. An
`invalid_request` names every failing field with its limit from `ASK_LIMITS`, `context`
included.

At most 16 waits are open at once. A
timer is refused with `timers_disabled` when `resources.monitoringWakeIntervalMinutes` is
`null`, and with `wake_budget_spent` once the run's automatic-wake budget
(`MAX_AUTO_CONTINUES`, 40) is spent. `cezar_cancel_wait({ wait_id })` moves an open wait
to `lastWaits` as cancelled and answers `open_waits`; a resolved but undelivered wait
answers `already_resolved` and its result is still delivered with the next wake, and a
human wait the user has already seen answers `human_question`.

A run holds at most one human wait. A second registration in the turn that opened it
replaces its card and keeps its `wait_id`; one after the user saw it returns it unchanged.
A human wait is shown to the user at the end of the turn that registered it (an
`ask.requested` event, recorded as its `askSeq`), at once when registered at a boundary,
or by the failure, close or recovery path, never mid-turn. Any human message settles every
human wait as `delivered`: it is never `resolved`, so it queues no wake, and a message to a
run whose only open wait is human is delivered as the answer. `cezar_ask` in an autonomous run
is refused with `autonomous_run` until its automatic-wake budget is spent. A worker's card
reaches its parent, and an open question asks the parent for its own words. Until
phase 4, the transcript's question facts stay authoritative for attention, and
`computeWaitingOn` reads both them and the human wait.

`cezar_done({ summary? })` finishes the task at the end of the current turn. In a workflow
agent step that is not the last, it finishes that step instead, and Cezar then starts the next
step (hearsay-tools/cezarion#1620). `summary` is at most 2,000 characters and unknown keys are
`invalid_request`. It answers `{ ok: true, finishes: 'at_turn_end', completes: 'task',
open_waits }`, `{ ok: true, finishes: 'at_turn_end', completes: 'step', next_step, open_waits }`
with the next step's name, or `{ ok: false, code, message, workers?, open_waits? }`. It is
refused, in this order, by the session refusals `cezar_wait` answers, then `root_finish_pending`,
`human_question_pending` (an earlier turn's question is unanswered), and for a root parent
`worker_questions`, `workers_outstanding` and `workers_uncollected`, each listing up to 64
`{ worker_id, reason }` and naming the command that clears them (a general form of the
command when listing every worker would pass `WAIT_MESSAGE_MAX`, 4,096 characters). The answer
a Continue opened with is not a pending question while its turn runs. The turn end that reads an
accepted done takes it, and a human message clears it. An earlier workflow step's turn that ends
without a done is handled as the last step's is: the no-wait nudge, then Cezar's human wait. A
session that closes without a done leaves the step `waiting`, and Continue resumes that step.
`not_final_step` stays in the code enum for old clients and is never returned since
hearsay-tools/cezarion#1620. `worker_wait_pending` stays in the code enum for old clients and is never
returned (it was the old completion wait's refusal, removed by hearsay-tools/cezarion#1301). A done
refused at the turn end becomes the refusal nudge described below. The close writes `summary` as a `note`, then the
lifecycle event `goal achieved — session closed` with `via: 'cezar_done'` (or
`via: 'done-line'` for the `CEZ:DONE` line, which closes through the same path), and cancels
every open wait, a human wait from the same turn included.

Only github.com is currently accepted; the forge has no enterprise-host resolver. CI
registration resolves canonical repository, PR and head with a ten-second metadata
budget, persists the intent before acknowledging, and returns immediately without
waiting for checks. Invalid, unauthorized, conflicting or unpersisted requests create
no durable wait. A CI registration repeats an **open** CI wait for the same PR: the PR
URLs are compared normalised (`identicalWait` in `workflows/waits.ts`), whatever either
call's `timeout_seconds`, and the open wait is returned with its deadline unchanged.
Concurrent calls for the same PR share one metadata lookup, and the lookup checks again
for an open wait under another spelling of the URL. A wait that has resolved, been
delivered or been cancelled matches nothing, so a later call for that PR opens a new
wait. A timer repeats an open timer only with the same seconds and note in the same turn.

The aliases land in the same list, each recorded in the entry's `via`.
The deprecated `cezar_wait_for_ci` tool was removed in phase 4b (hearsay-tools/cezarion#1236);
`via: 'cezar_wait_for_ci'` remains only on stored entries it opened.
At a turn end, the `CEZ:MONITORING` line opens a timer of
`resources.monitoringWakeIntervalMinutes` × 60 seconds (`via: 'monitoring-line'`),
and Claude's `ScheduleWakeup` opens one of its `delaySeconds` clamped to 60–3,600,
or of the interval when it gave none (`via: 'schedule-wakeup'`). An alias opens at
most one open timer per run and `via`: a later turn's line keeps the timer already
open. With re-checks off an alias opens a `monitoring-line` human wait instead, and with
the budget spent a `budget` one (`source: 'cezar'`); either adds a note and the run reads
as Needs you. An autonomous run whose nudge would fire skips the alias. The ask-marker
card opens an `ask-line` human wait with its questions, and a native ask (Codex, OpenCode,
Cursor ACP) a `native-ask` one. A session started without cezar tools (the controller is
unavailable) is taught the marker lines instead of the tools, and its monitoring wake keeps
the marker wording. `cez worker wait` is an alias too (hearsay-tools/cezarion#1235 phase 3a):
it opens the same `worker` entry as `cezar_wait({ kind: 'worker' })` (or kind `request`), with
`via: 'cez-worker-wait'`, and answers the legacy `WorkerWait` shape; the same workers (or
requests) and mode return the open entry, and `cez worker cancel-wait` cancels through the list
as `cezar_cancel_wait` does. A worker wait sits beside CI, timer and human waits and cancels
none of them. A park whose top wait is workers holds no slot, reads as the workers and
idle-closes after `IDLE_TIMEOUT_MS`; a resolution or a message reopens it through the scheduler
continuation. Messages are not waits: a worker message or reply wakes the run with every wait
still open and in the footer, and beside a pending portable question it is delivered next to the
card, which stays answerable; beside a pending native question it waits for the answer's turn end.

A root's done that the completion check refuses at a turn end (hearsay-tools/cezarion#1301, phase
3b) opens no wait. The agent gets the refusal `cezar_done` would return (`worker_questions`,
`workers_outstanding`, else `workers_uncollected`, one helper builds both) as one automatic turn,
charged to the automatic-wake budget and bounded by the no-wait nudge's reply timer; its settled
outcome is a completion nudge. When live workers block it, the nudge adds one sentence:
*If you end your turn with done again while these workers are live, Cezar will wait on them for
you and wake you when they have all settled.* The mid-turn `cezar_done` answer never carries it.
An open agent wait or owed input comes first: no nudge, the refusal is a note, and the run parks
on its waits. A block found after the session closed (or a legacy accepted Finish) queues the
refusal as one lifecycle input that the scheduler continuation reopens the session to deliver.
Its reply is bounded like the live nudge's, a run owes one refusal at a time, and the owed refusal
holds a closing session like a wait: a reopened session that closes or fails before the refusal is
submitted is a failed delivery, bounded by `MAX_WAKE_DELIVERY_ATTEMPTS`. The input carries
`purpose: 'completion-refusal'` on the run record, so a Continue after the run failed at that bound
and a restart deliver it under the same two bounds. Stop retires it while undelivered, so no later
Continue delivers a stale refusal (U22x).
One nudge per cycle: a human message or a wake starts a fresh one. When the turn that answers it
ends on a blocked done again, Cezar registers
a list `worker` wait on the live workers (`source: 'cezar'`, `via: 'completion'`, `mode: 'all'`,
no deadline, no slot; it idle-closes like any worker park), or with only uncollected results or
unanswered worker questions opens its own human wait (`via: 'completion'`), which parks for the
user; once every worker has settled and only uncollected results remain, only a human action ends
it. An autonomous run is nudged again until the budget. Finish refuses either park while any
blocker remains (`delegationFinishBlockedReason`); Stop and delete settle it. Settlement resolves the worker wait; worker messages wake the
parent beside it. `delegation.wait`, `delegation.completion` and `activity: 'monitoring'` are no
longer written; store schema 7 reads a stored completion wait into the list
(`upgradeLegacyWaits`), keeping an already-queued wake input as `wakeInputId`.

The agent ends its turn after registering. At a turn end, in both turn-end handlers:
a question or a permission gate parks for the human, an accepted `CEZ:DONE` finishes,
a worker wait parks on its workers, and only then do open waits park the run, after
the owed-input checks (held human input, unread agent input, an admitted wake) have
found nothing. The parked run is `waiting` with its waits open, and `deriveAttention`
reads it from `waitingOn`: **waiting for CI**, **waiting for merge** or **monitoring**, the running bucket
and a ring, never Needs you. A `waiting` run whose only waits are resolved reads
**waiting for capacity** until its wake turn starts.

A CI or timer park keeps one slot, so its wake runs at once: a monitoring slot when
one of `maxMonitoringSessions` is free, otherwise its regular slot.
`busySlots` is `active + starting − (waiting runs outside the pool) − min(pool,
maxMonitoringSessions) − worker-parked runs`, so a pool member beyond the monitoring
cap holds a regular slot, and a member that leaves the pool frees one and pumps the
line. Pool membership changes only at a turn end or on a terminal path, and always
releases the slot it held; a pool member running its wake turn keeps its slot until
that turn ends. A question or a permission park leaves the pool and keeps its waits.

A wait resolves when its event fires, its deadline passes or a terminal path cancels
it. At the next turn boundary every resolved wait is delivered in one turn, through
scheduler admission (a pool member is admitted immediately) and the session's native
`sendAgentMessage`; the provider acknowledgement checkpoints delivery and moves the
waits to `lastWaits` as delivered. Settled results retry admission and refused
delivery once per second without human input; cancellation, terminal state and
disposal stop retries. A result that lands mid-turn waits for the boundary. An automatic
batch that carries a timer result reserves one wake of the automatic-wake budget when it
is submitted, however many timers it carries; a refused submission or a rejected
acknowledgement gives it back, and the acknowledgement keeps it. A peer message that opens an
admitted wake turn reserves and spends one unit the same way (hearsay-tools/cezarion#1990). A CI result spends none,
and a human message resets the budget. The count, reservations included, is checked when
a timer comes due and before a batch with timer results is sent: at the budget, those
timers are cancelled with a cap note and wake nothing, and CI results beside them are
still delivered. A parked run left with no wait becomes a plain park that reads as Needs
you and gives its slot back: a `budget` human wait opens and is shown. The budget is the
run record's `automaticWakes` (hearsay-tools/cezarion#1234): a restart and a scheduler
continuation keep it, a human message and a human Continue reset it, and a parent's answer
to its worker does not. A batch's reserved unit stays in memory and is charged to the record
on the provider acknowledgement, in the delivery's own commit, so a batch a restart cuts off
is charged once and a crash cannot keep the delivery without its charge.

That budget cannot stop a delivery whose session keeps failing, since every retry is a
new session, so failed deliveries have their own bound. A session that fails (a provider
error on the opening or resume prompt, a rejected acknowledgement beside a question, a crash)
or closes cleanly while the run owes resolved, unacknowledged results counts one failed delivery, and the next
attempt starts after `WAKE_RETRY_BACKOFF` (15 s, then 30 s), not at once. The third
consecutive failure (`MAX_WAKE_DELIVERY_ATTEMPTS`) settles the run `failed` through the
ordinary failure path, with the last error and the note `could not deliver wait results
after 3 attempts — continue this task to retry`; after a clean close the error is `the session
closed before the wait results were delivered`. The count is the run record's
`waitDeliveryFailures`, so a restart keeps it; a delivery acknowledgement, human input or a
question answer, Continue, Stop, Finish and cancel reset it. A failure or clean close with
nothing resolved is not counted and parks as before. A usage-limit failure that owes results
settles `failed` at once, uncounted, so the usage-limit hold and its automatic resume take
it. A `failed` run that owes results is the one terminal run that keeps its waits: they stay
resolved and undelivered, its open waits stay armed (across a restart too) and still
resolve, and nothing wakes it. Continue delivers them once; a pending portable question
stays answerable, and its answer opens the turn that also delivers them. Stop discards them:
every wait, open and resolved, moves to `lastWaits` as `cancelled`, the backoff, the admission
retry, the count and any automatic resume are cleared, no session starts, the run stays
`failed`, and the note `Stop discarded the waits this task held and their results; the task
stays failed` is written. The cockpit offers Stop for that record beside Continue, Archive and
Delete; Finish stays unavailable, as on every failed run.

Human input never cancels a wait. A human message, `resumeParkedRun`, a question and
a permission request leave every open wait, whatever its `via`, and its deadline as
they were; the message is delivered and the wait's result arrives in a later turn.
Every delivered turn, human or automatic, including a continuation's opening prompt,
ends with the open-waits footer: `Still open: CI wait <id> for <repo>#<n>, deadline
<iso>; timer <id> at <iso> (<note>). Call cezar_cancel_wait for any you no longer
need.` An open question is listed as `your question <id> to the user`, and the closing
sentence then says the user's reply answers it, offering `cezar_cancel_wait` only for the
CI waits and timers (a question the user saw cannot be cancelled). A turn with nothing open
gets no footer. The footer replaces the CI withdrawal notice.

A pending portable question (the ask-marker card) never takes CI data as its answer:
a wake at a boundary is delivered beside it, the card stays answerable, and the
answer keeps its `askSeq`. That wake goes through `sendAgentMessage` with
`besideQuestion`, never the answer transport, and its provider acknowledgement is the
checkpoint as for any wake. A rejected acknowledgement delivers nothing and fails the
session like any rejected agent input (Codex, OpenCode, Pi and OMP report it as a provider
error). The waits stay resolved and the question stays pending, the run stays `waiting` on
its waits, and a scheduler continuation delivers them after the wake backoff and re-parks
as Needs you; a rejection that persists stops at the delivery bound. An
acknowledgement that lands after the wake turn ended parks the run for the question again. A pending native question (Codex, OpenCode, Cursor)
delivers nothing mid-turn: the wake waits for the answer and that turn's end. A
question whose session closed idle reopens through the scheduler-owned continuation
to deliver the wake, then re-parks as Needs you.

Stop, finish, review and deletion cancel open waits without waking the agent, and so does
every other terminal status except a `failed` run that owes results (above).
Project disposal aborts owned processes while retaining durable intent for recovery.
Recovery preserves the absolute deadline and the stable lifecycle input id (the wait
id) and re-arms every open wait; a parked run stays parked and its wake folds in any
queued messages, and a terminal run never reopens. A crash after provider acceptance
but before the acknowledgement checkpoint can replay that id: delivery is **not
exactly once**. The resumed agent must treat it as an observation, not a new
instruction.

The shared supervisor captures the registered head and checks attribution before
and after final structured observations. Outcomes are `passed`, `failed`,
`cancelled`, `skipped`, `no_checks`, `head_changed`, `deadline` and `error`.
Changed-head observations carry original and observed SHAs. No checks never means
passed, and `gh` exit status alone cannot distinguish check failure from command
failure. Mixed final outcomes prioritize failure, cancellation, skips, then pass.
Even passed observed checks do not prove every expected workflow has appeared or
that the PR is merge-ready.

Bounds are implementation constants: four concurrent watchers and four short
queries per shared supervisor; ten seconds per metadata/head/snapshot command,
always bounded by the remaining deadline; at most 60 seconds discovering absent
checks; `command_failed` and `query_timeout` retry at 1/5/15 seconds, then every
30 seconds until the original deadline. A successful observation resets backoff.
A deadline after unresolved query failures includes the last sanitized error in
`diagnostic`; cancellation has no retry diagnostic. Authentication, inaccessible
PRs, missing gh, malformed data and output limits still end with `error`.
Retry state is memory-only; recovery keeps the persisted deadline and starts
fresh backoff without requiring a live agent session. R92 in
`workflows/ci-wait-retry-parity.test.ts` covers retry-to-verdict delivery across
`RUNNER_IDS`, fresh and recovered.
Check-status polling (`gh pr checks --watch --interval`) and periodic PR-head
probes both use 30 seconds. The first observation still runs immediately. Those
intervals do not stretch the ten-second command timeout, the 60-second discovery
deadline, or the absolute wait deadline.
Registered watcher queues retain their original deadlines. Capture is bounded to
64 KiB per subprocess, with watch redraws discarded. Results contain at most 100
rows (256-character names, 2,048-character links), 4 KiB sanitized diagnostics and
32 KiB serialized data, with total counts and truncation reported. Compute the
aggregate before row truncation; structured-output overflow is an error. Teardown
stops the owned process tree with a two-second force-kill bound, including controller
pipe closure after a hard exit. Never recover ownership from a stale PID alone.

### Private transport and required harness evidence

The tools are provisioned through `AgentRunSpec.cezarTools` independently of worker
permissions. Claude, Codex, OpenCode and Cursor use the bundled stdio MCP adapter;
Pi and OMP use a bundled extension over the same shared client. The private chained Hono
family accepts `POST /api/v1/tools/wait`, `POST /api/v1/tools/cancel-wait`,
`POST /api/v1/tools/done` over a Unix-domain socket or Windows
named pipe; authenticated `GET /api/v1/tools/ci-wait` holds the adapter lifetime connection
(the path is historical: its POST was removed with `cezar_wait_for_ci`, hearsay-tools/cezarion#1236). It is **not** a cockpit HTTP route or network listener. Middleware
validates the shared schema. A memory-only session capability binds project, run
and generation; the model supplies neither a run ID nor a filesystem path.
`CEZ_TOOL_TOKEN` and `CEZ_TOOL_SOCKET` are internal child-environment wiring, never
prompts, persisted records, descriptor snapshots or user-authored settings.
Capabilities are revoked on session replacement, stop and controller disposal.
This is cooperative same-user authorization, not isolation from unrestricted shell.

Wait registration refusals name the blocking state (hearsay-tools/cezarion#713), with separate contract
codes for manager disposal, capability revocation, missing/inactive/stopping runs,
missing/replaced/closed sessions, cancellation/finish, stale session generation,
worker waits, stopped worker execution and parent finish. A pending or unanswered
human question refuses nothing in phase 1 (hearsay-tools/cezarion#1233): the wait opens,
and its result is delivered beside the question at a boundary; phase 4b
(hearsay-tools/cezarion#1236) removed the unused `human_ask_pending` and
`human_ask_unanswered` codes from the contract. Registration checks again after metadata lookup, distinguishing an
aborted registration from a changed turn. Only missing or revoked transport
capabilities are `unauthorized`; an unknown registration failure is `unavailable`.
Safe messages never forward request contents or raw provider errors.

Since hearsay-tools/cezarion#1235 phase 3a an agent-registered worker wait is a `worker`
entry in the run's wait list, and a settled one no longer blocks CI registration: CI,
timer, human and worker waits register beside each other up to `WAIT_LIMIT`. Cancellation
(`cezar_cancel_wait`, `cez worker cancel-wait`) and completed destruction move the entry
to `lastWaits`; a queued wake stays load-bearing for a parked parent, so cleanup must not
strand it. R80 in `workflows/ci-wait-refusal.test.ts` holds each `RUNNER_IDS` native mock
turn open, settles its worker, cancels or records completed destruction, then registers a
new worker wait and CI wait before releasing the turn; R27 reproduces the delivery
sequence through the real private CI controller and verifies CI registration succeeds
beside the worker wait (the old refusal is gone, so these now pin the absence of a block).
`worker_wait_pending` is no longer returned by any tool since hearsay-tools/cezarion#1301 (phase
3b) removed the completion gate's own wait; it stays in the error-code enums for old clients.

Every cezar tool comes from one list (`packages/cezar/src/ci-wait/tools.ts`, hearsay-tools/cezarion#781):
the adapter's `tools/list` and server instructions, Pi's and OMP's extensions, Claude's
generated allow-list entries, Pi's and OMP's tool admission and the environment names each
harness forwards to the adapter all read it. `cezar_preview_serve` and
`cezar_preview_stop` (hearsay-tools/cezarion#803) are on that list only under `CEZ_PREVIEW=1`, and
`cezar_schedule_task` and `cezar_scheduled_tasks` (hearsay-tools/cezarion#1465) only under
`CEZ_AUTOMATIONS=1`; the provisioned session environment carries each opt-in,
and Claude, Codex and Cursor forward it explicitly because they start MCP servers
from an environment allowlist. Harness row R35 lists the tools through every
runner's native mock wire and the real bundled adapter, with the flag on and off.
Under `CEZ_PREVIEW=1` the session environment also carries `CEZ_PREVIEW_CDP_URL`, the agent's
address for the task's preview browser (hearsay-tools/cezarion#784, spec
`2026-10-26-preview-agent-cdp`); its grant ends when the session's tool capability is revoked.
Harness row R125 reads it in every runner's native process, with the flag on and off.
The stop tool uses the same run-scoped session capability on fresh, continued and
recovered launches. It accepts only a port and optional restart, stops only owned
servers, and reuses owner approval only while command, cwd and path remain unchanged.
Replacement, release or capability revocation during teardown prevents restart.

Startup and tool listing do no GitHub work. IPC failure preserves ordinary boot
and execution, surfaces a bounded unavailable diagnostic, and never substitutes
model polling. Explicit tool denial remains denial. Preserve existing MCP servers,
extensions and permissions when adding a collision-resistant per-session tool name:

| Harness | Injection and evidence required before shipping |
| --- | --- |
| Claude / `claude-cli` | Add `--mcp-config` without `--strict-mcp-config`; admit only the added tool when tools are restricted; exercise fresh and resumed argv. |
| Codex | Merge `mcp_servers` for both `thread/start` and `thread/resume`; forward internal environment names with `env_vars`; set `default_tools_approval_mode = "approve"` on that entry so Codex never asks before a cezar tool (hearsay-tools/cezarion#1294); verify discovery and invocation on both paths. |
| OpenCode | Merge the local MCP entry into parsed runtime configuration without discarding supplied config or replacing unrelated servers; malformed configuration fails explicitly. |
| Cursor | Supply the supported ACP descriptor and environment on `session/new` and `session/load`; verify invocation and existing permission routing. |
| Pi | Add an explicit CI extension alongside the retry extension; exercise actual tool registration and calls without replacing discovered extensions or tool settings. |
| OMP | Add an explicit CI `--extension scripts/omp-ci-wait.mjs` alongside the user's discovered extensions (never `--no-extensions`); registration is proven by `get_state.dumpTools` listing the then-current CI tool on the real binary (v18.4.11; see `core/__fixtures__/omp/README.md`). `--tools` admits exactly the names the extension registers, since OMP exits 2 on an unknown name. The extension imports `src/ci-wait/tools.ts` in a source checkout; real OMP cannot resolve the workspace contract package there, so it falls back to `dist/ci-wait/tools.js` only when that file exists and otherwise rethrows the source error. MCP injection is rejected: OMP has no CLI flag for it, only `.omp/mcp.json` files. |

These are **release requirements**, not a claim that a configuration fixture alone
proves tool discovery. Every `RUNNER_IDS` backend needs named executable parity
coverage, installed upstream interface/version evidence, and real bundled
`tools/list`/`tools/call` transport (Pi and OMP registration/call for the extension runners) over its offline
wire on fresh, Continue and recovery paths. A wire limitation requires owner
review before shipping; there is no silent skip, permission widening or marker
fallback. Pack/install and `CEZ_DRY_RUN=1` checks must exercise the bundled helpers
without downloads, credentials or live GitHub, in both headless and cockpit paths.
The integration verification ledger must record actual outcomes separately from
this normative contract.

## 7. Harness parity — session and lifecycle (`packages/cezar/src/core/harness-parity.test.ts`)

The cells are defined in `core/harness-parity-cells.testkit.ts`. Each runner's
`RUNNER_IDS` cells run from its own `core/harness-<runner>-parity.test.ts`.
`core/harness-parity.test.ts` runs the matrix guard, the single-runner cells and
a guard that every runner has its file (hearsay-tools/cezarion#1288). Below,
`core/harness-parity.test.ts` names this whole matrix.

**P1** (hearsay-tools/cezarion#1049, hearsay-tools/cezarion#1266) routes an
approval from each native mock that carries one through `RunManager`, the
cockpit HTTP decision route, and the exact native reply: the Codex JSON-RPC
response, or OpenCode's `POST /permission/{id}/reply` for an ask the user's
own permission config makes. Each adapter's `approvalDecisions` names the
options P1 picks and the reply its mock echoes; every pick reaches the turn
end, including in an autonomous run, and ordinary user/agent text cannot grant
permission. The exhaustive `RUNNER_IDS` / `HARNESS_ADAPTERS` row registers
named executable exemptions for native wires that carry no permission request
cezar answers through the cockpit.

**P2** (hearsay-tools/cezarion#1266) pins a backend's own built-in permission
ask: OpenCode's `external_directory` ask, which no user rule names, is answered
with a once reply and the run never parks. OpenCode reads the user's rules once
per session from `GET /config`; an unreadable config sends every ask to the
cockpit, and no reply is ever `always`. Wires with no built-in ask that cezar
answers carry named exemptions.

**P3–P8** (hearsay-tools/cezarion#1266) pin the pending request's lifecycle: a
native request holds from its receipt until the backend settles it. P3 to P6 run
through `RunManager`. P3 retires a card the backend settles itself (Codex
`serverRequest/resolved`, OpenCode `permission.replied`), and P4 retires one
still pending when its turn ends. In both, `permission.resolved` carries a reason
and no option, `hasPendingPermission` clears, and the retired card's option
answers nothing. P5 answers through the HTTP route and the backend refuses the
answer: a replacement card is published before the old one resolves, so the run
stays `waiting` with `hasPendingPermission` set, and the replacement completes
the run. P6 sends a malformed request, which cezar refuses natively (a JSON-RPC
error, or an OpenCode `reject`) without a card while the turn goes on. P7 drives
the seam, where agent input lives: it refuses agent input from receipt, while
OpenCode reads its config to classify the ask, and shows no card for an ask
OpenCode settles in that window. P8 sends a card after the turn ended. OpenCode
asks only from a running session loop, so the runner reopens the turn
(`turn.started`) for a main-session ask; the answer resumes that run, and its own
`session.idle` ends the turn. At the seam, a self-closing session
(`autoEndAfterFirstTurn`) then closes. Through `RunManager`, a step's done
closes its session at once (hearsay-tools/cezarion#1620), so the late card never
pends and the next workflow step runs.
Codex carries named exemptions for P5 (a JSON-RPC response gets no reply that
could refuse it), P7 (its request is shown on receipt, with nothing to read
first) and P8 (a request arrives only inside the turn it names). Wires with no
native permission request carry P1's exemption for each row.

**P9** (hearsay-tools/cezarion#1294) routes another MCP server's tool approval
from the native Codex mock through `RunManager` and the cockpit HTTP decision
route; accept and decline each reach Codex as the exact elicitation reply. The
mock models Codex's MCP tool gate, so Codex rows of `ci-wait-parity`,
`ci-tools` H1 and U0 fail if cezar's own server loses `approve`. Runners whose
wires carry no MCP tool approval request have named exemptions.

**R72/R73** (hearsay-tools/cezarion#994), in `workflows/ci-wait-failure-parity.test.ts`,
drive every `RUNNER_IDS` backend through its `HARNESS_ADAPTERS` native provider-error
wire with a pending CI wait, on fresh and scheduler-owned continuation attempts.
The failed step retains its error, finish timestamp and `session.ended(error)`;
the run stays `waiting` with its CI wait open until automatic recovery delivers
the observation. Later successful settlement must leave that failed attempt intact.
Clean session closure while CI is pending still parks without failure. No runner
exemptions or normalized-event injection.

**R85** (hearsay-tools/cezarion#1399), in `workflows/ci-wait-rerun-parity.test.ts`,
drives every `RUNNER_IDS` backend through its `HARNESS_ADAPTERS` native CI tool
call with the real supervisor and a controlled GitHub wire. A partial green check
list stays pending while a rerun is active, then delivers one observation after
the checks return and finish. Recovery covers the same wait without a live session.

**U0–U19** (hearsay-tools/cezarion#1233, hearsay-tools/cezarion#1234, hearsay-tools/cezarion#1260, hearsay-tools/cezarion#1235, with U2c, U2t, U2w, U3w, U5a, U5c, U5d, U6s, U7d, U7h, U7w, U9c, U9h, U9u, U9w, U14m and U16b) pin the
wait list on every `RUNNER_IDS` backend through its `HARNESS_ADAPTERS` native wire, with no
normalized-event injection. U0, in `core/ci-tools.test.ts`, calls `cezar_wait`, `cezar_ask`,
`cezar_cancel_wait` and `cezar_done` through each native wire on fresh and resumed sessions. The rest are `WAIT_CRITERIA` in
`workflows/waits-parity.testkit.ts`, defined in `workflows/waits-parity-cells.testkit.ts` and run from three files per runner: `waits-<runner>-parity.test.ts` for the base rows, `waits-<runner>-workers-parity.test.ts` for the worker rows (U2w onward) and `waits-<runner>-entries-parity.test.ts` for U27, the turn-end entry axis, with the criteria guard in `waits-parity.test.ts` (hearsay-tools/cezarion#1288, hearsay-tools/cezarion#1525). U27 settles U5, U6, U11, U20 and U20u from a fresh step, a Continue and an acknowledgement that lands after its turn ended, and checks each settled outcome's word; the late-acknowledgement cells are exempt where no turn can end before its input is acknowledged. U1
registers a CI wait and a timer through `cezar_wait`, parks, and wakes with each result.
U2 opens both: the timer wakes, the CI wait stays open and is in that turn's footer,
the turn end re-parks without a new registration, and the later CI result is
delivered. U3 delivers a human message during a CI wait, keeps the wait open and
delivers its result in a later turn. U4 cancels with `cezar_cancel_wait`, and nothing
is delivered. U7 lands `cezar_wait`, the monitoring line and `ScheduleWakeup`
in the same list with their `via`; only `ScheduleWakeup` is exempt, as
`native scheduler tool exists only on the Claude wire`. U8 parks on a CI wait, and separately on a
timer, at `maxParallel: 1` and wakes without queueing behind the held slot. U8l
(hearsay-tools/cezarion#1236) holds the only slot while a timer park's wake and an
unstarted task wait in the line, and the wake takes the freed slot first, though the
task queued earlier. U8h settles a CI wait for a park whose account a seeded
usage-limit record holds, once with a deadline hold and once with a resume in flight:
the result waits in the line and is delivered once the hold lifts. U9 leaves the run
recoverable after a provider failure and after a clean close with each kind open, and
the next wake delivers. U10 resolves two timers before one boundary with 39 wakes spent:
one turn carries both and spends one wake, and a third timer due at the budget is
cancelled with the cap note and wakes nothing. A second U10 case holds the provider
acknowledgement of a timer batch sent at 39: a timer that comes due meanwhile is
cancelled, the held batch keeps the fortieth wake, and a CI result still wakes the agent
uncharged. U11 opens a monitoring-line timer and ends the turn on a done blocked by a live
worker: the timer keeps its deadline, the run parks on it with the refusal as a note and no
nudge, and the timer's result is delivered. U12 delivers a timer result beside a pending portable question and holds its
provider acknowledgement: the wait stays `resolved` and its input undelivered until the
acknowledgement lands after the wake turn ended, and then the run is back in Needs you and
the answer keeps its `askSeq`. U13 rejects that acknowledgement once: the session fails, the
run does not, a continuation sends the result again and delivers it once, and the question
is answered. A second U13 case keeps rejecting it: exactly `MAX_WAKE_DELIVERY_ATTEMPTS`
rejected submissions, each in its own session, then the run is `failed` with the result
resolved, its input undelivered and the cap note, and the question still pending; once the
rejection lifts, the answer delivers the result once. Claude is exempt from U12 and U13 as
`capability-absent`: it acknowledges agent input with the local stdin write, so its wire can
neither delay nor reject that acknowledgement. Cursor is exempt from U13 only: Cursor print
acknowledges on the first model work of the process it spawns, which U12 delays, but the
print wire has no rejection of an admitted prompt. U14 fails every wait-wake continuation's
opening prompt through each runner's native provider-error wire, with a resolved timer and no
question: the same bound, a timer that resolves on the failed run stays resolved and wakes
nothing (no queued continuation, admission retry or backoff is left), and Continue delivers both
results once. A second U14 case closes every session cleanly at a turn end while the result is
owed, as U9 closes one at a boundary: the original session, whose turn the timer resolves in, and
two continuations, then the same held state with the clean-close error, and Continue delivers once.
A third U14 case Stops the held run at the bound before any Continue, with the resolved timer and
a still-open one: both are in `lastWaits` as `cancelled`, no wait, backoff, admission retry,
delivery count or queued continuation is left, the run stays `failed` with the discard note, and
a later Continue is a plain continuation that delivers neither. Scenario cases that need one wire live in
`workflows/waits-wake.test.ts`: a CI result beside a pending portable question (U3b,
Claude and Codex), a Codex native question, an idle-closed question, two waits in one
submission, the footer and the monitoring pool, and on the Claude wire the delivery bound's
backoff (each retry waits for it, and Continue clears it), the usage-limit failure that is
not counted, a failed run's held result across a restart and Stop, and Stop on a
usage-limited held run, which also cancels its automatic resume.

Phase 2 (hearsay-tools/cezarion#1234) adds eight cells. U16 spends the automatic-wake budget to
39, closes the session, and fires a timer: the scheduler continuation that delivers it charges
the fortieth wake, `cezar_wait` then refuses a timer with `wake_budget_spent`, and a human
Continue resets the count to 0. U16b spends the whole budget, closes the session and fires
both timers, as recovery fires overdue ones: each is cancelled, the last opens a `budget`
human wait that is shown and reads Needs you with no session, and Continue answers it. U9c
puts a failure count on the record and blocks the store's writes: Finish still stops the
run, because the counter writes outside a delivery are best-effort. U6s calls `cezar_done`
in the first of two workflow steps: it is accepted with `completes: 'step'` and the second
step's name, the first step's session closes as done, and the second step runs
(hearsay-tools/cezarion#1620). U10 also reads the committed row as the charge note is written: the
delivery, the charge and the cleared failure count are there together. U7h lands the ask line, `cezar_ask` (its card holding an open
question) and a native ask in the same list with their `via`, and the user's answer delivers each; Claude, Pi,
Cursor (print) and OMP are exempt from the native case as `native ask arrives as the portable
marker on this wire` and assert the `ask-line` alias instead. Two more U7h cases run on every
runner: a valid ask line later in the turn replaces a `cezar_ask` card (on Cursor print the
turn end re-enters a boundary from `discardQueuedMessages`, so the replacement is saved
first), and a Continue that answers one question and asks the next keeps the next one open
and shows its card. U9h registers a human wait
mid-turn and fails the provider, and separately registers one at a boundary and closes the
session cleanly: each time the card is shown once with its `askSeq`, the run reads Needs you,
and the answer delivers it. A step's authored `timeoutMs` is the exception: once it has passed,
the step's human waits are cancelled and the run fails, which `workflow-ask-parity` Q8 pins on
every runner. U6 calls `cezar_done` from a parent with a live worker
(`workers_outstanding`), then with that worker settled but not collected
(`workers_uncollected`), and once it is collected with a CI wait open: the run finishes, the
CI wait is cancelled into `lastWaits`, and the closing event carries `via: 'cezar_done'`. U7d
finishes one run with the done line and one with `cezar_done` and a summary, which lands as a
note just before the closing event, and then finishes a Continue turn through `cezar_done`
again, so both turn-end handlers are covered. A third U7d case closes the session while a
question is shown, then Continues with a message that answers it and calls `cezar_done`: the
answer in flight is not a pending question, so the done is accepted and the run finishes.

Phase 2b (hearsay-tools/cezarion#1234) adds the turn-end rule. `decideTurnEnd`
(`workflows/turn-end.ts`) is one pure function. Every turn end applies it through one
`RunManager` method, `settleTurn` (hearsay-tools/cezarion#1525): the fresh step's and the
Continue's turn-end handlers, the boundary an acknowledgement settles late, and input readiness for
a refused autonomous nudge. Since then it also decides a done the completion gate refused, so both
nudge causes (no wait and completion) have one table test, and the parity cells read each settled
`TurnEndOutcome` through the private seam `settledTurnOutcome` (`workflows/turn-outcomes.testkit.ts`;
hearsay-tools/cezarion#1809 removed the handoff heartbeat line that recorded it). Input already
owed defers the decision;
then done finishes; any open wait or question parks; a workflow step that is not the last
completes; a spent budget opens a `budget` human wait; an autonomous run gets the autonomous nudge;
and any other turn end gets the no-wait nudge once, charged to the automatic-wake budget, before
Cezar opens a `no-wait` human wait (`source: 'cezar'`). Nothing reads the turn's prose. Cezar's own
human waits raise no human gate: they are shown as their note, worker messages still wake the run,
the agent's own wait or question replaces them, they end with the session that opened them, and
the agent's `open_waits` and footer leave them out. A worker keeps the nudge; since
hearsay-tools/cezarion#1301 (phase 3b) its second no-wait turn end opens Cezar's `no-wait` wait
with one open question (`Worker <id> ended its turn without waiting on anything or finishing.
Reply with what it should do next.`), raised as `ask.requested` and routed to the parent like a
worker question; the parent's reply resumes the worker, charged to its budget. A parent's steer,
an automatic message, an admitted Continue, a clean exit, an idle close or a restart supersedes
it (`human-ask-closed`, reason `superseded`; its routed request completes without reply). A worker
whose budget is spent keeps the plain park. The native mocks answer the nudge with a `cezar_ask` card, or with the ask line in
a session taught the markers, unless `CEZ_MOCK_NUDGE_REPLY=plain`. The unit fixtures set `plain`,
and the cells that need the card opt out. U5 ends a turn with no wait: one nudge, then a second
no-wait turn end opens the `no-wait` wait, which reads Needs you and is answered by the user's
reply, which restarts the budget. U5a answers the nudge with `cezar_ask` and parks on that question
after one extra turn, the default dry-run path. U5c finishes a root parked on Cezar's no-wait wait,
and pins that an agent question still blocks Finish. U5d pins that the no-wait wait raises no
question (its `askSeq` is its note, and no gate fact is pending), and that a timer the agent
registers cancels it into `lastWaits` and parks the run as monitoring. U18 finishes a run parked
on the agent's `cezar_ask` card, with its session open and with it closed: Finish records
`human-ask-closed` for that question and no `human-input-delivered`, so no question stays pending.
U17 sends a prose question
with no wait, which gets the nudge, then the same question after the monitoring line, which leaves
the line's timer in place with no gate note. U15 nudges an autonomous run with the autonomous
wording until the budget, then opens a `budget` human wait.

Phase 3a (hearsay-tools/cezarion#1235) adds nine cells for worker waits, with the workers on the
Claude wire and the parent on each runner's native wire, and no exemptions. U2w opens a CI wait
and a worker wait through `cezar_wait`: the worker settling wakes the agent with the CI wait
still open and in the footer, the turn end re-parks on it, and the later CI result is delivered.
U2t does the same with a timer: the timer wakes the agent with the worker wait still open and in
the footer, the turn end re-parks on the same entry with its deadline, and the worker result is
delivered later. U2c does the same with the CI wait resolving first: its observation wakes the
agent with the worker wait still open and in the footer, the turn end re-parks on that entry, and
the worker result is delivered later. U3w sends a worker progress message through the delegation service while the
parent is parked on a worker wait: it wakes the parent with the wait in the footer, the wait
stays open with its deadline, and only the worker's own settlement resolves it, once. U7w opens
one worker wait with `cez worker wait` and another with `cezar_wait`: both are entries of the
same list (`via: 'cez-worker-wait'` and `'cezar_wait'`), and each resolves on its own worker into
`lastWaits`. U9w registers a worker wait mid-turn and fails the provider, and separately
registers one at a boundary and closes the session cleanly. After the provider failure the run
is not failed and stays recoverable with the wait open; after the clean close it stays `waiting`
with no error and the wait open (the clean close was an error before 3a). Either way the worker's
settlement delivers it. U14m wakes a parent whose session has closed beside an open worker wait
with a worker message alone, and fails every continuation's opening prompt: the third failure
settles the run `failed` with the message still undelivered and no backoff or retry left, and
Continue delivers it once. A message-only wake that fails once counts the failure, and the
delivered message clears the count. A message the agent has not read is not delivered: on
Claude's wire the failure ends the process before the mock reads the steered message. U9u
restarts a parked parent from a row an older build wrote, with its worker wait in
`delegation.wait`, and U9v does the same for the completion gate's wait (schema 7), which wakes
once through the list: a cancelled receipt's queued wake is delivered as ordinary input and the wait
stays cancelled in `lastWaits`, and a `reason: 'message'` stand-in whose message a provider took
before the crash reads as interrupted execution, so recovery resumes the parent. U19 delivers a worker message beside a pending portable question on every runner:
the message reaches the wire, nothing answers the card, and the human's answer keeps its
`askSeq`. No runner takes U12's exemption here: U19 pins delivery, not a delayed acknowledgement.
Phase 3b (hearsay-tools/cezarion#1301) adds, on every runner: U20 and U20u (a blocked done at the
turn end gets one refusal nudge, with the will-wait sentence for live workers and without it for a
settled, uncollected one, and opens no wait), U20h and U20m (a human message, in the opening session
or a continuation, or a worker message after a refusal nudge the harness never answered starts a
fresh cycle: its blocked done gets a fresh nudge, not the park), U20a (a done in the turn that answers
an input acknowledged only after that turn ended still gets the nudge once the acknowledgement
lands, never an implicit re-check timer), U21 (an ignored refusal parks on Cezar's completion
worker wait, which settlement wakes), U21r (that deadline-less wait restarted and settled), U21m (a
worker message wakes the parent beside it), U21t (an agent timer beside it keeps its deadline),
U21h (only uncollected results: Cezar's human wait), U21a (an autonomous parent is nudged again
until the budget), U22 (a done blocked after the session closed reopens it and delivers the
refusal), U22s (a reopened session that acknowledges the refusal and never answers parks at the
nudge's reply bound), U22c (reopened sessions that keep closing first: one copy, the delivery bound,
and Continue delivers it once; a legacy Finish too), U22f (one such close counts a failure, and the
delivery clears it), U22x (Stop retires a refusal a closed session still owes, and a Continue after
it does not deliver it), U24 (a worker's second no-wait turn end asks its parent, whose reply resumes it) and U25
(an automatic message supersedes that question). The harness that never answers is each native
mock's `mock:ack-only` reply (`CEZ_MOCK_COMPLETION_REPLY`): it acknowledges the refusal on its own
wire and opens no turn until more input arrives. Cursor print is exempt from U20h, U20m and U22s
(each prompt spawns a process whose init frame is `turn.started`, as F8), and OpenCode from U20h (a
human prompt waits for the busy turn to go idle, and that turn never does; U20m's worker message
steers it). Claude and Cursor print are exempt from U20a: neither can end a turn before its input is
acknowledged (the stdin write; the first model work of the spawned process).

**R74** extends that native-wire matrix to a failed nonfinal workflow agent.
CI recovery must retain the failed attempt, including across restart and CI
acknowledgement, then execute the remaining agent and bounded check retry.
Both passing checks and exhausted retries settle according to the workflow;
a successful synthetic continuation never rewrites the failed source as done.

**R75** drives accepted owned workflows through restart after CI acknowledgement
and after a synthetic continuation durably queues the remaining workflow. Both
must preserve the failed source and execute the tail with its bounded check retry.
**R76** pins an authored check retry targeting that source: actual re-execution
advances the logical step's latest iteration/result while the original failure's
`session.ended(error)` and `step-end(failed)` remain in the append-only transcript.
This is existing retry behavior, not per-iteration snapshots in `StepState`.

**R7** also pins off-loop restart readiness (hearsay-tools/cezarion#906): every
`RUNNER_IDS` backend uses its `HARNESS_ADAPTERS` native mock, then restarts with
both root and worker facts sidecars removed. Recovery must never use the
exceptional synchronous facts queue join. Pending asks and queued input survive;
bare Continue is refused, and an explicit human answer reaches the native runner
before queued agent input drains. This extends the registered R7 cell, with no
runner exemptions.

**R60** (hearsay-tools/cezarion#906), in `workflows/worker-restart-parity.test.ts`,
uses every `RUNNER_IDS` backend's `HARNESS_ADAPTERS` native wire to persist a
starting execution generation. A fully terminal modern root and worker have no
live or deferred anchor; their plain history is nonempty and facts sidecars are
missing. Immediate boot recovery must prepare the selected family off-loop,
never enter the synchronous facts join, and complete the private generation with
one correctly sequenced lifecycle repair. No runner exemptions. Selected-readiness
guards also pin disposal, failure, changed ownership and completed-proof rechecks.

**S21** (hearsay-tools/cezarion#832) detects unexpected restored history through
OMP's startup `get_state.messageCount`. A fresh step emits one v1 note and one
non-fatal `session.error`, and still completes normally. Other native wires have
named `scenario-unconstructible` exemptions for this OMP-specific startup response;
S1/S3/S14 retain their native start/resume coverage. OMP's focused tests also pin
explicit resume, empty/absent/malformed counts, unrelated queries and duplicate replies.

**S22–S24** (hearsay-tools/cezarion#843), in `core/runner-shutdown-parity.test.ts`,
start every `RUNNER_IDS` backend through its `HARNESS_ADAPTERS` native mock.
After prompt admission, an outside SIGKILL must fail the session; `end()` must
escalate to SIGKILL when the child cannot handle EOF or SIGTERM; and a failed
output transport must terminate the live child. OpenCode uses its real HTTP/SSE
stream for the transport failure, while the other backends use stdout.
Requested teardown remains successful. The matrix has no wire exemptions.

**S33/S34** (hearsay-tools/cezarion#1899), in the same file, delay delivery of
an actual native exit callback after an outside SIGKILL on every `RUNNER_IDS`
wire. The exact OS status still fails the session when EOF cleanup runs first.
Pi also pins self-exit 143 with the same scheduling fault. Claude, Codex and Pi
retain bounded live-EOF cleanup and SIGKILL escalation when process evidence is
unreadable. S34 also denies every process probe. Confirmed exit may suppress a
cleanup signal; unknown evidence may not. Automatic cleanup with unknown evidence
fails nonzero/signal exits, including on Windows without a live-state probe.
Positive live evidence permits successful teardown but cannot prove causation
against a later external signal. Explicit end/interrupt before native exit takes
precedence without extending an active cleanup deadline. The same file tests intent
before EOF, during the probe and after TERM. No wire exemptions or synthetic
normalized events.

**S29** (hearsay-tools/cezarion#906, hearsay-tools/cezarion#969), in `core/omp-input-pipe.test.ts`, closes each
native input transport while the admitted turn's child is alive, then submits agent input.
Codex waits until `sendAgentMessage` admits — `session.open` can be true before the first
main-thread turn exists, so a one-shot send races the startup gate.
Claude/Codex/Pi/OMP mocks close fd 0; OpenCode destroys the next native prompt HTTP socket
while retaining SSE. The rejected receipt must retain input failure evidence, settlement
must be bounded, and no successful native turn completion may be fabricated. OpenCode's
synthetic terminal turn boundary remains valid after failure. Cursor print has a named,
executable `scenario-unconstructible` exemption: Cursor print writes its prompt to stdin
and closes stdin once per turn, refuses agent input while busy, and queues human follow-ups
for a new per-turn child; consequently this admitted-turn/live-followup scenario cannot be
constructed.
Pi and OMP additionally close admission immediately, report one fatal transport failure
and reject their results even if the child would later exit zero. OMP's focused regression
closes stdin before the native `ready` frame to exercise the queued startup outbox.
Their S29 fixtures gate the initial native prompt acknowledgement after closing stdin;
the cell waits for that acknowledgement to drain before submitting agent input, so a
filesystem marker cannot race the runner's admission guard (hearsay-tools/cezarion#974).

**S26–S28** (hearsay-tools/cezarion#890), in the same file, start every `RUNNER_IDS` backend's
native mock with `mock:no-progress-leftover`. The mock leaves two children in its cwd: one in
the session's process group that ignores SIGTERM, and one that left the group with `setsid`.
S26: the session leader leads its own process group (`pgid` equals its pid). S27: `interrupt()`
ends the leader and the in-group child, and the `setsid` child keeps running. S28: `end()` on a
leader that cannot process EOF or SIGTERM escalates to SIGKILL for the whole group, with the
same outcome. Every runner spawns and signals through `core/session-process.ts`, which also
sends the group its SIGKILL when a member outlives a leader cezar stopped. win32 has no process
groups and skips these rows; it ends the tree with `taskkill /T /F`. No wire exemptions.

**S30–S31** (hearsay-tools/cezarion#1286), in the same file, use the same scenario for a leader
cezar did not signal. S30: `end()` with no SIGSTOP; the native mock exits on EOF by itself, and once
the session settles the in-group child is gone and the `setsid` child keeps running. OpenCode's
runner and Cursor print end by a cezar signal on `end()`, so their S30 cells take S27/S28's path.
S31: the leader alone is SIGKILLed from outside, with the same outcome. `core/session-process.ts`
reaps the group of a leader that exited on its own after the exit drain (SIGTERM, then SIGKILL
after the grace), under the same reuse guard, and keeps its host up until the group is empty or
the SIGKILL is sent. Cursor print reaches the same reap when it ends its group after each turn.
win32 skips both rows. No wire exemptions.

**R43** (hearsay-tools/cezarion#738), in `workflows/worker-reboot-parity.test.ts` and
`workflows/worker-location-evidence.test.ts`, drives every `RUNNER_IDS`
backend's `HARNESS_ADAPTERS` native wire through worker cancellation and a successful twin.
Linux prior-boot controller evidence settles the old execution independently of resource cleanup.
Both collect-first and destroy-first unblock parent Finish after collection. A real same-user
`PR_SET_DUMPABLE=0` process inside the scratch or worktree is no evidence (hearsay-tools/cezarion#889,
reversing the #738 rule that it retained both): once location evidence recovers, production
60-second retries after restart release every resource while it still runs, and nothing signals it.
A readable holder still blocks history removal after a complete checkpoint, and reuse until it
exits; a stale retry cannot touch a newly admitted native execution. Disposal/detach stops retries; recovery/reattach
reconstructs their durable intents from private generation checkpoints even if the run index is
missing, corrupt, or quarantines the worker. Surviving unknown private evidence protects local
and fallback scratch from generic sweeping; unreadable discovery retries too. Unknown fallback
ownership retains its saved location. Partial removal retains a directory-identity receipt and
the pointer until the fallback is gone, so permissions recovering cannot strand cleanup. If uncertainty
never clears, files remain indefinitely.
Malformed or unreadable fallback pointers/removal receipts retain every independently readable
candidate and mark location discovery incomplete. Legacy execution, collect and parent Finish
remain unsettled until holders exit and location evidence recovers; a clear partial scan is not
termination proof. The native matrix covers all four damage shapes with real readable holders,
post-probe writes and restored-evidence recovery. Known-reboot execution still settles without
holder scans when cleanup metadata is damaged, while independent cleanup remains blocked.
Only prior-boot evidence and process enumeration scope are synthetic; cwd permission denial,
process exit, native wires, stores and Git remain real. Linux-only OS coverage exempts no runner;
legacy/unknown-boot and recorded-process guards live in `delegation/process-liveness.test.ts`.

**R47** (hearsay-tools/cezarion#839, hearsay-tools/cezarion#889), in `workflows/worker-restart-parity.test.ts`,
drives every `RUNNER_IDS` backend through its native `HARNESS_ADAPTERS` wire,
cancellation, and same-boot interrupted checkpoint recovery. A live recorded
unreadable process still blocks settlement, and that partial collection cannot
authorize parent Finish. Once the recorded incarnations exit (a reused PID does
not attest the old one), restart settles the generation as gone, with no
abandonment and no new execution revision, although an unrecorded unreadable
process still runs inside the worktree. Real mutation keepers make owned cleanup
refuse promptly and withdraw its queued claim, preserving resources until an
explicit retry after unlock; that retry completes while the unreadable process
runs, and latest settled collection then authorizes Finish. Mixed probes with
absent or incomplete ledgers recheck each fresh poll: destroy waits while a
readable holder runs, then completes even though an unreadable process remains,
never signalling it. Linux-only OS coverage exempts no runner. Checkpoints an
older cezar wrote with `abandoned` still parse and still refuse a new generation.

**R48–R52** (hearsay-tools/cezarion#779), in `core/harness-parity.test.ts`, drive every
`RUNNER_IDS` backend through its native `HARNESS_ADAPTERS` wire against the `runs.db` run
store, where memory holds only live runs and their delegation families and each process
claims the families it acts on. R48: Continue loads a finished run into memory and releases
it after the run settles. R49: a restart clears a cancelled root's stale Finish intent, and
Continue then resumes it. R50: a headless open beside the owning process leaves the owner's
parked run waiting, and a restart still answers it. R51: adopting a dead owner's run in the
middle of a turn starts no agent, and Continue resumes it. R52: Stop on a dead owner's run in
the middle of a turn ends it as cancelled and starts no agent. No runner is exempt.

**R53–R57** (hearsay-tools/cezarion#790), in `core/skill-resume-parity.test.ts`, drive every
`RUNNER_IDS` backend through its native `HARNESS_ADAPTERS` wire on a skill-driven task.
R53: a live Continue resends `skillSystemPrompt` before the extra prompt on `resent`
runners (claude, pi, omp) and does not duplicate it on an `in-thread` same-session resume
(codex, cursor, opencode). R54: a continuation persisted as `running` or `queued` is resumed
by `recover()` on a new manager (the boot funnel), and that recovered spawn matches the
Continue prompt. R55: a skill removed from the registry before Continue keeps today's
extra-only prompt and emits exactly one lifecycle warning on `resent` runners; `in-thread`
resumes skip the warning because they would not resend the skill. R56: each runner's
required `systemPromptOnResume` declaration matches its resume wire (`--append-system-prompt`
/ prepend on every process versus `thread/resume`, `session/load`, or OpenCode `GET
/session/{id}` into history). R57: Continue and restart recovery reuse the recorded session
id (OpenCode GETs `/session/{id}` and does not `POST /session`; the other runners use their
resume channel). A fresh-session continuation on an `in-thread` runner still receives the
skill. OpenCode's lost-session 404 fallback is covered alongside R57: one notice, a new
session id, skill present in the fresh session's system prompt. No runner is exempt.

**PR1–PR2** (hearsay-tools/cezarion#922), in `core/harness-parity.test.ts`, drive
all `RUNNER_IDS` through the native `multi-pr-refs` scenario. PR1 retains five
main-assistant declarations in first-seen order, including split text and repeats,
and excludes tool, reasoning and attributed child text. PR2 continues the task,
retains those five references and appends the sixth. Both check the last scalar
subject and reopen the persisted store. No runner is exempt from accumulation;
whole-block wires declare over complete assistant blocks rather than text deltas.

**R58** (hearsay-tools/cezarion#917), in `core/worktree-setup-parity.test.ts`, drives every
`RUNNER_IDS` backend through its native `HARNESS_ADAPTERS` wire on a task in an isolated
worktree whose project declares `worktreeSetup`. The setup runs before the first turn, the run
records `worktreeSetup.status === 'done'`, and the paragraph saying what ran reaches the opening
message on each runner's own wire. The note is appended in `workflows/run.ts` before the
runner seam, so no runner can lose it on the way. No runner is exempt.

**R92–R96** (hearsay-tools/cezarion#1408), in `core/skill-provision-parity.test.ts`, drive every
`RUNNER_IDS` backend through its native `HARNESS_ADAPTERS` wire on a skill-driven task in its
own worktree. The selected skill names a companion. R92: Start installs both in `.claude`,
`.agents` and `.cursor` `skills/`, and nothing under them shows in `git status`. R93: an
ordinary Continue, whose prompt names no skill, reinstalls the step skill's companion. R94:
`recover()` resumes a persisted continuation with no live session and reinstalls it. R95: a
live `/name` message is delivered at once, its companions install after it, and one durable
lifecycle agent input names what landed; a repeat installs nothing and sends nothing. That
input follows the agent-input rules: a pending question holds it until the question is
answered. Cezar does not rely on a runner's native lookup seeing a skill added mid-session,
so the input is the delivery on every runner. R96: Stop while the install is held launches no
agent. No runner is exempt.

Crash-diagnostic rows **S15–S17** (hearsay-tools/cezarion#499) drive every `RUNNER_IDS` adapter's
native transport through an uncaught-exception-shaped stderr fixture, a plain
single-line failure, and a clean/requested shutdown with stderr. RPC mocks send
a malformed native frame before the crash. Crash summaries preserve the
exception and exit code, omit empty lines and the Node runtime footer, and cap
the stderr detail at 500 characters. A separate v1 `note` retains the available
stderr (including stack and error properties); it never replaces the fatal
summary. Cursor retains a bounded 65,536-character diagnostic tail, explicitly
marks truncation, and keeps its existing sanitized 500-character display bound.
Its existing startup retries are unchanged. OpenCode chooses the crash diagnostic
after process settlement, before its synthetic turn-end, so an SSE disconnect
cannot obscure the exception or add a second error. Timeouts and requested
signal teardown retain their existing outcomes.

S15 additionally pins selection of the terminal outer exception after a recovered
error, without confusing indented nested causes/properties with the fatal header.
**S18** crashes while the opening prompt is awaiting acknowledgement (before the
first response on Claude's stream wire), requiring one actionable error before
any terminal boundary. **S19** inherits the CLI's pipes in a descendant, writes a
late diagnostic after CLI exit, and proves settlement remains bounded. OpenCode
awaits drained stdout/stderr after confirmed process exit under the shared 250ms
pipe deadline; an opening HTTP rejection keeps its note and failure reason, while
a concurrent process crash supplies the authoritative error. Codex startup crash
errors retain their phase context alongside the terminal stderr exception.

**S20** exercises missing executables through every adapter's binary setting.
There is no child process or backend wire on ENOENT, so it uses the OS spawn
boundary and preserves each runner's existing event/rejected-result failure
channel. No turn starts. OpenCode's focused spawn test additionally requires
exactly one wrapped error event with PATH/installation guidance before rejecting
the result, without a turn-end or done event.

**S25** (hearsay-tools/cezarion#872) starts OpenCode's native mock with its first
`opencode serve` start exiting before it prints a URL. The runner notes the failure,
waits `SERVE_START_RETRY_DELAY_MS`, spawns once more on a fresh port, and completes the
turn with no error; the focused test also pins that the new pid reaches
`onPidChange`. A second early exit fails with one error naming both attempts' exit
codes and stderr summaries, and a retry whose spawn throws names that spawn error; a
retry that instead hangs or is torn down reports through the ordinary paths. A spawn
error, the 30 s no-URL timeout, and a teardown or deadline before or during the pause
are never retried (`opencode-serve-retry.test.ts`). The other runners speak over the
spawned process's stdio, with no listen phase, and carry named
`scenario-unconstructible` exemptions; retrying their starts is out of scope.

Workflow deadline rows **T1–T6** (hearsay-tools/cezarion#470) live in
`core/workflow-timeout-parity.test.ts` and are registered in the shared parity
guard. Each `RUNNER_IDS` backend uses its own `HARNESS_ADAPTERS` native wire:
non-final managed steps outlive the default runner deadline, explicit zero disables
it, authored positive limits fail before trailing checks, and standalone sessions
retain their default cap. Longer authored limits override that cap, while default
tasks retain no wall-clock cap. The tests shorten only `DEFAULT_RUN_TIMEOUT_MS`; the
manager, runners, transports and terminal signals remain real.

Intermediate question rows **Q1–Q10** (hearsay-tools/cezarion#427) live in
`core/workflow-ask-parity.test.ts` and the shared parity guard. Every
`RUNNER_IDS` adapter sends portable ASK text through its native assistant-message
and turn-completion wire; the malformed variant changes only the text inside
the existing snapshot fixture. No wire exemption is needed. The rows cover
same-session answers and trailing checks, malformed markers, final interactive
asks, idle close/Continue, disk-round-trip restart recovery, cancellation,
Finish on fresh and continued sessions, authored timeouts, autonomous ask lines
that are not registered (Q9), and clean unanswered session exit. Unrun checks remain pending on stop/failure;
an unanswered clean close retains durable waiting and releases capacity.


Open-turn inactivity rows **N1–N8** live in `core/workflow-no-progress-parity.test.ts`
and the same parity guard. Every native adapter proves that stalled nonfinal turns
fail without running trailing checks, native progress/heartbeats sustain a long
turn, parked sessions do not time out, followups and Continue rearm protection,
native questions pause until answered (Claude/Pi use their marker fallback),
agent input rearms protection even when a backend omits a turn-start notification,
and a process ignoring SIGTERM is killed before capacity is released. A descendant
holding inherited stdout/stderr cannot retain capacity after the CLI exits.
`startManagedSession` supplies the shared 30-minute guard to both RunManager
construction paths. `SessionOptions.onActivity` reports native transport frames
before presentation coalescing; it refreshes only an open turn. Native questions
pause the guard until an answer, and turn-end pauses it until another turn starts.
End, cancellation, provider failure and process settlement dispose it. The guard
emits a failure and interrupts the runner; it never synthesizes process exit or
releases capacity early. Standalone wall-clock limits remain unchanged.

Autonomous turn-end rows **A1–A14** live in
`core/workflow-autonomous-parity.test.ts` and the same parity guard (hearsay-tools/cezarion#426).
Every adapter covers fresh and Continue nudges, the unregistered ask line, the
40-nudge cap, non-autonomous parking, monitoring, DONE and persisted-question
priority. A9 preserves native mid-turn questions; Claude/Pi have executable
exemptions proving their native wire uses the portable marker fallback instead.
Before the budget an autonomous run registers no ask line, as `cezar_ask` refuses with
`autonomous_run` (hearsay-tools/cezarion#1234): A3/A4 record the note
`autonomous — question not registered; continuing` with its questions, and the
autonomous nudge goes instead. Only that fresh turn-end ask line may use the existing
answer transport for the nudge, without a human message or answer checkpoint, because
the runner holds the line as a pending portable ask. Queued/accepted input, worker/CI
waits, existing questions and lifecycle stops block it, and a wire that refuses the
nudge registers the line after all.
OpenCode's cap cell holds each nudge's HTTP ACK until after its SSE turn ends;
deferred idle-boundary settlement applies the same policy after the ACK, including
the cap note and the settled outcome for the state actually entered. A11/A12 start with
an unregistered ask line before markerless turns, covering the separate answer
transport's delayed ACK on fresh and Continue sessions. A refused ordinary nudge
retains its capacity slot and a readiness outcome until input readiness retries
that exact completed boundary, after durable input. New parent activity, accepted
input or a real question invalidates the retry; cancellation, Finish, disposal and
session replacement revoke it. Missing readiness reaches the existing idle close
bound. Successful retries use normal acknowledged input, so the cap and all
worker/CI/native-question guards still apply. A13/A14 use ordinary root runs on
fresh and Continue paths: OpenCode retains the answer ACK indefinitely, the actual
idle callback requests shutdown, and the slot stays occupied until process exit.
Only then do the run and step become durable `waiting`, with a successful Continue
proving resumability. The other adapters have named executable exemptions for
this HTTP-only ordering and test root idle expiry/Continue on their native wires.
Owned-worker terminal settlement and explicit question/worker/CI waits retain
their existing policies.

**H1–H5** (hearsay-tools/cezarion#486, H4–H5 hearsay-tools/cezarion#1112) live in `core/workflow-followup-parity.test.ts`
and the same parity guard. A human follow-up sent via `manager.sendMessage` while a
turn is running must reach the agent without a resend when that turn ends with
`CEZ:DONE` (H1), must be dropped when the same turn parks on a portable `CEZ:ASK`
(H2), and a markerless hold-style turn must not park or nudge between the follow-up
and the next turn (H3). H3 is a guard that the run does not park or nudge in that
gap, not a proof the follow-up ran as its own turn — except OpenCode continuation,
which does pin the follow-up across Continue. H4 sends the follow-up with
`mock:deferred-turn-start`, which every mock honors by starting that turn 800 ms late
(`scripts/mock-deferred-turn-start.mjs`), and asserts no turn starts after the first
park. H5 adds `:late-ack`: Pi and OMP acknowledge the steer inside the running turn,
Pi then runs it as its next prompt and OMP reads it before settling.

`AgentSession.holdsHumanInput()` reports a follow-up the runner still holds and will
still deliver; both turn-end handlers fold it into “input delivered” so the run does
not close, park, or nudge. Every runner releases a held human input by one rule
(hearsay-tools/cezarion#1152). It releases only when:

- (a) the normalized `turn.started` of the turn that carries it has been emitted;
- (b) it is read inside an open normalized turn; or
- (c) a rejection or a close means it can never start, or a `discardQueuedMessages`
  drops it. A discard cannot retract an input the wire already wrote or spawned: the
  runner then either drops only the hold, and the input can still run, or keeps the
  hold because its discard is a no-op (see the H2 exemptions).

Close releases because run.ts reads the hold only while the session is `open`
(`harnessHoldsHumanInput` and the recheck timer both check `session.open` first), so
a runner need not clear its hold on close. A native ack, a native run-start frame, a
spawn or a queue shift is not a release on its own: it releases only when one of
those exits already holds, as a Pi or OMP ack does when cezar emitted that turn's
`turn.started` at the write and the turn is still open. A release on the frame alone
lets the 250 ms recheck find the hold drained and park the run `waiting` while the
follow-up's turn is still starting; that turn then runs under Needs you. Each runner
maps these exits to its own wire:

- **Claude**: (b) the `--replay-user-messages` echo of the line's `uuid`, or a
  `result` whose `user_message_uuids` names it. A line written after the turn's last
  model call runs as the CLI's next turn; while that turn is pending, cezar emits its
  `turn.started` on the first assistant, user or result frame, before it processes the
  replay echo. A `result` that settles lines through `queued_turn_count` alone is not
  a release. `discardQueuedMessages` is a no-op on this wire, so it is not an exit.
- **Codex**: (a) `turn/started` after the human `turn/start`, or the `turn/start`
  response when `turn/started` came first. (b) the `item/started` `userMessage` echo
  of a steer's `clientUserMessageId`. (c) a `turn/start` or `turn/steer` error;
  `discardQueuedMessages` is a no-op on this wire, so it is not an exit. A
  `turn/steer` response is admission, not a release.
- **OpenCode**: (a) the `turn.started` cezar emits at the follow-up's `prompt_async`
  POST, once the running turn ends. (c) `discardQueuedMessages`. A follow-up sent
  while a question reply is in flight stays held until that reply succeeds, then posts
  like any other.
- **Cursor ACP**: (a) the `turn.started` cezar emits when it shifts the follow-up off
  its queue into `session/prompt`, after the running prompt's response. (c)
  `discardQueuedMessages`, which a `CEZ:ASK` turn end also runs.
- **Cursor print**: (a) the `system`/`init` frame of the print process that carries
  the follow-up, which the mapper turns into `turn.started`. (c)
  `discardQueuedMessages`, which drops the queue; for a spawned follow-up it drops
  only the hold, and that process can still run it. The queue shift and the spawn are
  not a release. Before the wrapper picks ACP or print, it holds the follow-up itself
  and hands it to the runner it picks.
- **Pi**: (a) its ack, when its write opened a normalized turn that is still open
  (cezar emits that `turn.started` at the write); for a steer, the first
  `turn.started` after its ack. (b) its user `message_start` inside an open
  normalized turn. (c) a rejected ack, and `discardQueuedMessages`, which drops only
  the hold: the prompt is already written and can still run. A steer's ack alone is
  not a release: Pi reads a steer acknowledged after the turn's last model call as
  its next prompt, after `agent_settled` (the `mock:steer-late` ordering, H5). A raw
  `agent_start` is not one either: the mapper reports nothing for it, and Pi's mock in
  H5 holds 800 ms between that run's `agent_start` and its first activity.
- **OMP**: the Pi exits, plus (b) its `prompt_result`, which OMP sends at the
  terminal `agent_end` before `session_settled`. (c) also covers a local
  (`agentInvoked: false`) ack or `prompt_result`. A raw `agent_start` is not a
  release.

`discardQueuedMessagesOnAsk` still runs first, so an ASK park drops the waiter on
queueing wires. Write-through/steer wires may consume the follow-up inside the running
turn or open a later one; H1 still holds either way. A held follow-up that drains at
an idle boundary (the turn already ended) without opening a new turn must call
`onAgentInputReady` so run.ts re-settles that boundary (close, park, or nudge).
`handleAgentInputReady` is the fast path and a 250 ms recheck timer is the backstop;
after `UNREAD_INPUT_GRACE_MS` of a hold that never drained with no runner activity,
the follow-up is treated as delivered-unconfirmed (a `#505`-style note) and the
boundary settles so the run cannot keep a slot forever. Codex does not release a
human `turn/steer` whose completed-then-response ordering left no active turn; it
restarts an accepted-but-unread steer with `turn/start` under the same
`clientUserMessageId`, and skips that restart when the turn already echoed the id.
OMP named wire limit: a human prompt rejected after `session_settled` is only a note
and is not restarted — real OMP settles only at `queuedMessageCount === 0`, so a
steer accepted before settle is read in-turn (I2), and a post-settle rejection has
no cheap idle-boundary retry. Claude, Codex, Pi and OMP have named executable H2
exemptions: their wires write or steer immediately, so `discardQueuedMessages` cannot
unwrite a line already on the pipe. On Claude, a mid-turn line is queued by the CLI
and runs as a fresh turn after the ASK park while the card is pending — the inverted
H2 assertion does not pin that.

No-wait nudge rows **F1–F11** live in
`core/workflow-final-message-parity.test.ts` and the same parity guard. They were written for the
final-message nudge (hearsay-tools/cezarion#544), which the no-wait nudge absorbed
(hearsay-tools/cezarion#1234): a silent tail is a turn end with no wait, so it gets the same one
nudge, reply bound and settled outcome. Every adapter covers a reasoning-or-tool tail with no later
assistant message, on fresh and Continue paths: one nudge that can complete with DONE, a
still-silent nudge that opens Cezar's no-wait human wait (#119), reasoning that names `CEZ:DONE`
never completing the run (#399), a markerless message-then-tool tail getting exactly one nudge, an
explicit DONE with zero nudge notes, and an autonomous silent tail that stays `running` with a held
slot and no idle timer at the first `continuing without pausing` note, with zero no-wait nudge
notes. F7 covers the park-after-ACK site: a silent-tail turn that ends while its agent-input ACK is
still pending produces exactly one `no wait or done — reminding the agent once` note and a
no-wait nudge outcome after the ACK.
Only OpenCode's HTTP ACK is independent of the SSE turn; the other adapters have named executable
exemptions because turn frames and the transport ACK share one stream, so turn-end-before-ACK
cannot be constructed.
F8 covers an ACKed nudge that never opens a turn (OpenCode keeps sending SSE heartbeat comments):
after `NO_WAIT_NUDGE_REPLY_MS` (5 minutes) the run notes `no reply to the no-wait nudge — waiting
for you` and opens Cezar's no-wait human wait, `waiting` with busySlots 0; a worker parks plain. Cursor's ACK is the
stdin write callback, as for Claude: the mock accepts `session/prompt` and sends nothing. A synthetic
`turn.started` emitted inside `sendAgentMessage` before the reply timer is armed does not count as a
reply; items, text and tools count at any time, and nested `item.*` events with `parentItemId` do not.
F9 lets a late reply after expiry unpark the run (`running`, slot held) and then complete normally;
the nudged-last-turn latch still prevents a second nudge. F11 lets the bound expire, then starts the
late reply turn on the wire and gates content until the test observes the resumed slot: `turn.started`
alone unparks (`running`, slot held) before content arrives, then the run completes normally. Only Codex
emits a native `turn/started` after the nudge is sent; the other adapters have named executable exemptions
because `turn.started` is synthetic inside `sendAgentMessage` and fires at nudge send, before the bound.
F10 starts streaming content before the bound and ends after it: no `no reply to the no-wait nudge`
note, and a normal DONE. A user-authored
delivery resets the one-shot latch so the next silent tail can nudge; expiry does not. The one-shot
latch keeps #48 closed; control markers are never read from reasoning. A pending autonomous retry is
never replaced by the no-wait nudge.

> Every criterion in the harness parity matrix MUST hold for **every** backend,
> or carry a declared exemption naming the wire limitation that prevents it.

§6 pins what a mapper emits. This pins the rest of the contract in
`agent-runner.ts`: session lifecycle, provider-failure surfacing, `sendMessage`,
ask routing and park declarations. It exists because nine fixes (hearsay-tools/cezarion#2, hearsay-tools/cezarion#3, hearsay-tools/cezarion#4, hearsay-tools/cezarion#5,
hearsay-tools/cezarion#6, hearsay-tools/cezarion#46, hearsay-tools/cezarion#48, hearsay-tools/cezarion#53, hearsay-tools/cezarion#54) each repaired a failure mode on ONE backend that no
shared contract covered, so the same class of bug shipped again on the next one.

**Regression coverage belongs in the fixing PR.** A fix to runner lifecycle,
input delivery, attention, asks or completion MUST add or extend a shared
`RUNNER_IDS` case in this matrix, or an equivalent exhaustive adapter loop such
as `workflows/worker-parent-attention.test.ts`. Do this when fixing the bug; a
separate parity issue is not a prerequisite. Keep a focused backend test when it
helps explain the wire, but it is not the shared regression proof.

Drive each real runner through its own native mock frames. Register each new
criterion in the total-coverage guard, and use a named, executable exemption only
when the wire cannot express the case. Prove the new test fails when the relevant
production fix is removed, then restore it and record the passing run in the PR.
An injected normalized event can test the manager in isolation; it cannot prove
that another runner constructs or attributes that event correctly.

**Two tiers.** The seam tier drives each real runner class against that
backend's own offline mock and asserts over the v1 and v2 streams plus the
settled result. The run tier drives a real `RunManager` run in a temp git repo.
The second tier is not redundant: `ask.requested` is emitted by the RUNNER for
codex, opencode and cursor (`codex-app-server-runner.ts`, `opencode-server-runner.ts`, `cursor-acp-runner.ts`)
and by `workflows/run.ts` for claude and pi, and whether a provider failure
fails the run or parks it is decided in the orchestrator either way. Provider
failures, asks and park declarations are only uniform above the seam.

**Shared scenario names, per-backend spellings.** Every mock is already driven by
`mock:<scenario>` markers found in the prompt text. The matrix names a scenario
once and `HARNESS_ADAPTERS` maps that name onto whatever a backend already calls
it, so no existing marker is renamed. A new runner declares its own map:

| Scenario | The mock must |
| --- | --- |
| `baseline` | one text, one tool call and result, usage, then its terminal turn signal |
| `done` | the same, with a trailing `CEZ:DONE` so the run reaches its review gate |
| `hold` | acknowledge the prompt, then a timed pause before the content AND the terminal signal |
| `hold-gated` | like `hold`, but wait for `CEZ_MOCK_RELEASE_FILE` (or a fallback delay) so a mid-turn follow-up can be injected before content |
| `hold-done` | like `hold-gated`, then end with `CEZ:DONE` so a mid-turn follow-up can race the close |
| `hold-ask` | like `hold-gated`, then end with a portable `CEZ:ASK` so a mid-turn follow-up can race the park |
| `split-text` | stream the reply in pieces, ending with a trailing `CEZ:MONITORING` |
| `provider-error` | a runtime provider rejection in its own native error shape |
| `ask` | an ask — native where the wire has one, a `CEZ:ASK` marker otherwise |
| `ask-resume` | ask, accept a human answer, then complete work with `CEZ:DONE` without another human prompt |
| `plan-resume` | Cursor’s `cursor/create_plan` variant of `ask-resume` |
| `ask-bad` | a malformed ask, and then still end the turn |
| `ask-reply-late` | the same ask, with OpenCode SSE idle preceding the independent reply HTTP acknowledgement |
| `subagent` | child work and a child terminal signal the parent survives, then parent `CEZ:MONITORING` text followed by child text before parent turn-end |
| `subagent-after-park` | wait for the manager to park, then emit native child updates without a new parent turn |
| `ask-snapshot` | a complete parent assistant ASK snapshot, without earlier text deltas where the wire supports snapshots |
| `ask-prose` | code-span and quoted-log ASK mentions with no final-line marker; no card or rejection note |

S9 also pins parent-only v1/result text while child messages remain nested on v2.
R12 asserts the `subagent` turn parks on an open monitoring timer (`waiting`, label
`monitoring`), never as a plain wait that reads as Needs you (hearsay-tools/cezarion#149). Pi is explicitly exempt from S9 and R12 because its RPC has no child
session transcript. Codex filters both child message deltas and completions;
Claude excludes child assistant text from v1 and its result fallback buffer;
the v2 fallback uses the same parent-only guard.

**Text that cezar adds can change the scenario** (hearsay-tools/cezarion#1643). A native
mock picks its scenario with `includes('mock:<scenario>')` over all of the native user text
it receives, not over the task alone. That text also holds what cezar adds to the message:
the system instructions of an in-thread runner, the resume context, and the session-start
`<cezar-context>` blocks ([docs/context-injection.md](docs/context-injection.md),
hearsay-tools/cezarion#1584). The handoff block repeats the task's Goal. So a Continue
message also carries the first task's `mock:` token, and the mock replays the first task's
scenario. When a change adds text to an opening message, strip that text before the mock
matches a scenario. Do this in `packages/cezar/scripts/mock-session-context.mjs`, or in a
helper next to it. The mock must still record the raw native text in its recording
(`CEZ_MOCK_STDIN_FILE` or `CEZ_MOCK_ARGS_FILE`), because tests assert what cezar sent.
Record first and strip after, as `mock-claude.mjs` does, or keep the raw text next to the
stripped text, as `stripCommandMessage` and `rawMessage` do for Pi and OMP. An OpenCode
request body is JSON, and JSON escapes the quote of an attribute. So a check for
`<cezar-context id="` never matches that body. Check for `<cezar-context id=` without the
quote, as `withoutSessionContextBody` does. The Cursor print mock matches only the text
after the last `\n\n---\n\n` divider, so the blocks never reach its match. In
hearsay-tools/cezarion#1638, the handoff replayed `mock:ask-snapshot` in the OpenCode cells
of `workflow-ask-parity` rows Q5 and Q10. The cause showed only after a temporary debug log
in `mock-opencode-serve.mjs`.

R36–R39 (hearsay-tools/cezarion#399) record the shared monitoring wrap-up contract on every native
prompt channel for fresh, Continue and restart-recovered sessions, and the
automatic monitoring wake. Every runner honors `cezarTools`, so since
hearsay-tools/cezarion#1234 the contract names the tools: finished and verified work calls
`cezar_done`, pending work calls `cezar_wait`, and a question for the user calls
`cezar_ask`. A session started without cezar tools keeps the
marker prompt and the marker wake (`CEZ:DONE`, `CEZ:MONITORING`); `human-waits.test.ts`
pins that form on the Claude wire. R40 keeps completion prose without a marker parked as waiting;
the harness does not infer completion from prose. Offline prompt recordings prove
delivery, not live model compliance.

R26 (hearsay-tools/cezarion#398) runs every `HARNESS_ADAPTERS.askResumeCases` entry for every
`RUNNER_IDS` backend: Claude/Pi/OMP `CEZ:ASK`, Codex `item/tool/requestUserInput`,
OpenCode `question.asked`, and Cursor `cursor/ask_question` plus `cursor/create_plan`.
One human answer must reach completion with no later `waiting` transition and no
second human prompt. R3 proves parking; R6 deliberately returns to markerless
waiting to test owned-input draining. Neither replaces R26. New runners must
supply a nonempty ask-kind inventory and native prompts, or a named executable
wire exemption. The prose guard rejects counted runner rosters in this contract,
the hearsay-tools/cezarion#68 spec and harness-parity comments so adding an id cannot stale their counts.

R77 (hearsay-tools/cezarion#961) is R15's shape for hooks: a native hook frame mid-turn, a
monitoring park, then a late hook frame released after the park (Squeal's async `waiter`
completes this late). Status, activity and the wake deadline survive, no turn opens, and
both hooks persist as distinct `item.completed` hook items. Only Claude and Codex have a
hook wire; the other runners carry `scenario-unconstructible` exemptions naming the version
surveyed.

R15 (hearsay-tools/cezarion#121/#401) releases native child updates only after the run has parked,
then checks that status, activity and the monitoring wake deadline survive.
Claude and Codex retain nested items; Cursor retains attributed late task
metadata while dropping closed child-session chunks; OpenCode discards closed
child scopes. Pi has the same explicit child-wire exemption as S9/R12. OMP has none: its
`subagent_lifecycle`/`subagent_event` frames carry the child transcript, so S9, R12 and R15
run on OMP's native mock wire including `subagent` and `subagent-after-park`. The mock's
frames after `session_settled` are constructed (real OMP settles only when it has no pending
async work) and kept as a stricter robustness check.

**OMP exemptions** (`PARITY_EXEMPTIONS` in `harness-parity.testkit.ts`; each names a wire fact,
never "not implemented"):

| Row | Kind | Why |
| --- | --- | --- |
| A9 | capability-absent | v18.4.11 plain `--mode rpc` never constructs the ask tool: `sessionOptions.hasUI` is true only for interactive or `rpc-ui` (`src/main.ts`) and `AskTool.createIf` returns null without it. The turn-end `CEZ:ASK` fallback applies (A3/A4). |
| R16 | capability-absent | `text_end.content` is the one assistant-text channel for v1 and v2; `message_end` has no separately mapped text. |
| I2 | capability-absent | `session_settled` requires `queuedMessageCount === 0` (`isRpcSessionSettled`, `modes/rpc/rpc-session-settle.ts`) and `agent_end` is rewritten to non-terminal while the agent has queued messages (`session/agent-session.ts`), so a steer accepted before settle is read in the same turn. Source-derived (no live turn). |
| A13, A14 | scenario-unconstructible | Same as every runner: no portable-answer HTTP ACK retained after turn completion; the executable cell checks idle expiry and Continue instead. |
| H2 | capability-absent | Mid-turn human follow-up is steered immediately; `discardQueuedMessages` cannot unwrite it. OpenCode and Cursor queue and drop (H2 live rows). |

R16 (hearsay-tools/cezarion#134/#401) checks a stored assistant ASK and exactly one waiting question
card on every runner. All current wires couple their completed parent text to
v1, so the v2-only precondition has named `capability-absent` exemptions pinned
by the opposite assertion: the raw v1 stream must contain that same marker.
A future runner that can carry independent final text must exercise the v2-only
case instead. The isolated manager fallback tests remain in `run.test.ts`; the
wire rows do not pretend to reproduce a missing-v1 envelope these protocols do
not supply.

R22/R23 (hearsay-tools/cezarion#515) preserve task scratch across native session close and host temp-environment changes: ordinary
runs keep files through fresh and continuation idle-close paths, and workers
with a pending question keep files after private process completion. Terminal
Finish still reaps both repo-local and fallback scratch. Every runner is covered.

R28/R29 (hearsay-tools/cezarion#473) idle-close and Continue twice on every native runner wire, then
Finish into `done` or `review`. Intermediate Continue steps remain waiting while
parked and become done with a completion timestamp only when the run succeeds.
R30 delays the final diff check and cancels during it: cancellation wins over
success, including the intermediate steps. Successful settlement preserves other
step statuses and existing timestamps, and still respects parent completion deferrals.
R31/R32 accept Finish on fresh and Continue sessions, dispose the manager during
the final diff check, and still require terminal success on every native wire.
Disposal cannot revoke accepted Finish/Stop intent; a replacement active execution
still prevents the old settlement from completing its steps.
R33/R34 hold an inactive run's Finish diff check while a newer Continue either
starts and idle-closes or remains queued behind capacity. Continue acceptance
supersedes that settlement before scheduling; returning to no active session must
not let the earlier Finish close the newer execution or its steps.

R20/R21 (hearsay-tools/cezarion#661) complete an owned worker over each native mock wire, then commit a
cleanup checkpoint. Enabled delegation reads only that worker's family; disabled
delegation enters no terminal-checkpoint reconciliation and reads no histories.
The persisted execution proof remains complete in both cases.

R24/R25 (hearsay-tools/cezarion#495, `core/harness-autosave.test.ts`) retain writer
protection across stalled autosave Git commands on initial and Continue sessions
on every native runner wire. Each command gets 30 seconds, then TERM and (after
one second) KILL. An unsuccessful save is reported without deleting working files.
Two further seconds without termination proof produce blocker diagnostics: Git
leader state, group liveness or failed inspection, and retained cwd-holder PIDs.
The strict autosave promise stays pending until its group and observed holders
exit. Run finalization instead takes a separate maintenance hold, settles the
execution, clears stopping and releases capacity. That hold retains the store's
cross-process ownership claim. Private `runs/<id>.autosave-cleanup.json` evidence
retains the controller, observed process incarnations and unconfirmed groups across
store close and project replacement. Continue, publishing, deletion, reclaim,
branch and worker cleanup remain blocked until strict cleanup is confirmed. A dead
controller's evidence is freshly reprobed; zombie-only groups and a positively
different Linux boot grant no old writer, while uncertainty still blocks reuse.
Admission reads leave expired evidence nonblocking and never unlink a newer proof.
A queued workflow remainder
waits behind the same hold; confirmed cleanup wakes the scheduler. A warning or
Stop never grants permission for another writer or signals unrelated cwd holders.

R61–R66 (hearsay-tools/cezarion#934, `core/harness-autosave-settlement.test.ts`) drive
provider failure, Stop during final autosave, and successful Finish through every
`HARNESS_ADAPTERS` native wire, both fresh and on Continue. A real detached Git
descendant, in a session of its own, remains alive after Git exits: execution
must settle while reuse stays refused with the holder's PID, working files remain,
and confirmed holder exit automatically releases the worktree hold. An unrelated
parent-owned process churns new processes in the worktree throughout: it is never
named in the refusal and never signalled (hearsay-tools/cezarion#958). R61 replaces
the manager/store after the observed holder moves cwd; R64 stops a Continue with
a remaining workflow step and requires that queued tail to retire immediately.

R67–R68 (hearsay-tools/cezarion#958, same file) Finish a fresh run and a Continue
while an unrelated process keeps starting new processes in the worktree, as
Squeal's Vitest workers do. The final autosave must commit, leave no cleanup
evidence or hold, and leave the unrelated process running and unsignalled.

R78–R79 (hearsay-tools/cezarion#1004, `core/harness-autosave-branch.test.ts`) check
another branch out in an owned worker's worktree on every `HARNESS_ADAPTERS` native
wire, leave a file, and settle the session: R78 on the initial run (`run finalize`),
R79 on a Continue (`turn end`). The save commits nothing, the foreign branch tip does
not move, and an autosave record (the handoff's records block, from
`RunRecord.handoffRecords`, hearsay-tools/cezarion#1809) and a cockpit note both
name the branch and the uncommitted path count, while the Progress log stays free
of the report. R79's first settle, still on the task branch, pins the other half:
the commit is reported with its short sha, the branch and the
`git reset --soft <sha>~1` fold-back command. R79's periodic case fires the
Continue's `CEZ_AUTOSAVE=1` timer by hand, so the closing `turn end` flush finds
a clean tree and reports nothing: the timer's own merged `periodic:` record
names the commit, the branch and the fold-back command, and no cockpit note is
emitted for it.

Autosaves serialize per canonical worktree; Git auto-maintenance is disabled
only for these commands. Holder discovery shares orphan recovery's cwd boundary,
not OS containment. A new cwd holder counts only when it is Git's: each command
sets a fresh `CEZ_AUTOSAVE_OWNER` value that descendants inherit through detach
and reparenting, an unmarked child of Git or of an attributed holder counts, and
an environment that cannot be read counts (fail closed). A child that both clears
its environment and leaves the tree before it can be observed is outside that
proof. Transcript warnings stop after three cleanup changes; the durable evidence
still follows each one. Existing agent holders are left alone.
Windows uses bounded PowerShell process snapshots and creation-time checks,
retaining observed ancestry after the Git leader exits and checking each process
handle before shutdown. An intermediate process that appears and exits between
snapshots can hide its descendants; this is observation, not kernel containment.
If the platform probe is unavailable, autosave fails before spawning Git and
cleanup continues with working files preserved.

R69–R71 are retired (hearsay-tools/cezarion#1233). They pinned the CI withdrawal
notice that human input used to trigger; human input no longer cancels a wait, and the
open-waits footer that replaced the notice is pinned by U2 and the footer case of
`workflows/waits-wake.test.ts`.

R18/R19 (hearsay-tools/cezarion#548) use every runner's native message wire to check final-line ASK
selection after an earlier prose mention, and quoted ASK examples without a
marker. Parsing and transcript stripping must select the same final line;
ordinary examples leave no question card or rejection note.

Monitoring turn rows **M1–M30** (hearsay-tools/cezarion#772) live in
`workflows/monitoring-turn.test.ts`, `workflows/worker-parent-attention.test.ts`
and `workflows/monitoring-channel-order.test.ts` and enter the shared parity guard.
Every `RUNNER_IDS` adapter carries multiple parent assistant text segments through its native wire on fresh and Continue sessions.
A standalone `CEZ:MONITORING` declaration survives a same-turn acknowledgement.
No prose is read (hearsay-tools/cezarion#1234): a later question or review request,
in any Markdown form, leaves the monitoring line's timer in place (M2, and M3 with
live workers). Durable structured questions, DONE and spent parent completion gates
retain their existing precedence. Ordinary markerless autonomous turns retain their
nudge policy (M13/M14). Quoted/indented marker examples and fenced code cannot
declare monitoring. M1 fires the real monitoring wake
callback and proves capacity was released. M7 closes the actual idle session,
retains the unanswered question, then delivers its answer through Continue and
checks that a later monitoring turn carries no stale attention. M17 pins the fresh
path's genuine accepted-wait session-failure protection. M18 retains a real ASK
card across a routine acknowledgement, idle close and delivered answer; M19
retains DONE through an acknowledgement and reaches review. M20 excludes
quoted/fenced/indented/example ASK and DONE declarations. M21 retains later
DONE precedence over an earlier portable ASK; M22 retains the latest malformed
ASK diagnostic and raw fallback, and the turn, which registered no wait, takes the
no-wait nudge before Cezar's no-wait human wait. M23 does not register an autonomous
ask line on either turn-end path. A rejected ask line registers nothing either: M24
keeps its diagnostic and raw text beside the monitoring line's timer, including
latest malformed replacement, and a later valid ASK still shows its card. M26/M27
pin the same through delayed ACK admission with live workers; M28 preserves ordinary
rejected-ASK autonomous nudging. Active ASK lines use the existing payload parser
unchanged.

Each text-form row keeps one or two representative forms on every native wire, on
fresh and Continue sessions (M2, M3, M6, M18, M20, and M30's earlier gate). The other
quoted, fenced, indented, example and Markdown forms are read by the shared turn-end
rule directly in `workflows/turn-end-text.test.ts`, with identical channels and the
`missing` and `refresh` channel shapes (hearsay-tools/cezarion#1665).

M9, M10, M15, M16 and M25 are retired (hearsay-tools/cezarion#1234). They pinned
the prose gate and the rejected-ASK fallback gate, which raised Needs you beside a
monitoring line, live workers or a dependency wait and held later worker input until
the user answered. No prose raises a gate now: M2, M3 and U17 pin that a prose
question beside the monitoring line leaves its timer in place, and U17 that one with
no wait takes the no-wait nudge. M24, M26 and M27 pin the rejected ask line. The gate
a human wait without a card raises, which keeps the `unstructured-human-gate` note
code, is pinned by `workflows/human-waits.test.ts`.
M29/M30 in `workflows/monitoring-channel-order.test.ts` retain ordering across
partial channels on fresh/Continue. Native Codex completion refreshes and
Codex/OpenCode omitted completion text exercise actual channel divergence;
the native observer pins each capability. Claude/Pi/OMP/Cursor carry coupled
completion text; OpenCode also deduplicates refreshed completed parts. Those
named executable wire controls assert equality rather than inject divergence; a
runner runs one coupled control, not one per direction it lacks.
When one channel is an ordered expansion of the other, classify its raw text
once; neither channel always wins. Incomparable transcripts retain the existing
conservative gate policy. This partial/replayed-frame coverage differs from
R16's canonical complete-snapshot coupling guarantee.
The native rows
also assert CLI attention-wait and webhook projections. Cockpit grouping and
notification transitions remain consumers of the same contract attention rule.
M9/M10 extend owned-input ACK coverage with explicit human gates and live workers;
the existing executable Claude/Cursor pipe-write exemptions retain their native
acceptance-before-response proof. No new wire exemption is needed.

`worker-parent-attention.test.ts` (hearsay-tools/cezarion#249/#401) loops every runner for fresh and
Continue sessions: markerless turns with live workers stay monitoring, and real
ASK still wins. Codex/OpenCode/Pi delay transport acknowledgement past turn-end.
Claude/Cursor acknowledge pipe writes, so their named executable exemptions hold
the provider response and prove acceptance precedes it. Its exhaustive ACK table
makes a new runner fail until its transport is classified and exercised.

Owned-input rows S11/S12 pin ask separation and each runner's declared delivery mode:
a `steer` runner admits busy input, a `boundary` runner refuses and retries at its
boundary, and a closed session refuses. Input rows I1/I2 (hearsay-tools/cezarion#505) pin that mid-turn
input is reported read before its turn ends, and that accepted input a finished turn
never read is reported; Cursor is scenario-unconstructible for both, and Claude,
Pi and OMP are capability-absent for I2 because they never leave acknowledged input unread.
Rows I3–I5 (hearsay-tools/cezarion#935), in `core/conversation-answer-delivery.test.ts`, Continue a
worker's human answer after a restart closed its session and send a parent message through
`DelegationService.send`. I3: a steer runner reads it before the answer turn ends. I4: delivery
follows the declared mode while the answer is held: steer runners accept it in the turn, and Cursor
receives it only after the turn-end `human-input-delivered` checkpoint. I5: a genuinely unanswered
native question, and a newer one raised by the answer, hold the message until answered; beside a
portable question the message is delivered at once and the card stays answerable
(hearsay-tools/cezarion#1235 phase 3a). It is never the answer. The
answer's checkpoint stays at turn-end in every row. Cursor is scenario-unconstructible for I3. R6–R11 exercise durable queued/startup input, before/during/
after asks, restart with an unanswered ask, continuation asks, delayed native replies,
DONE/explicit-stop precedence and post-send checkpoint failure. R13 runs a persisted
catalog chain (an agent step plus a check step) inside the owned worker on every
runner, proving the check executes in the worker's own worktree (hearsay-tools/cezarion#451). R14 runs an
accepted mixed-runner chain — a step on the runner under test followed by a step on
another runner — under a per-step identity, proving each step binds its own pinned
account and provider instead of the run-level one (hearsay-tools/cezarion#452). Echo probes use the
same documented assistant/item and terminal frames as each mock's baseline, with
unique item IDs across turns; no new vendor wire event is invented.

New scenarios are **wire-faithful** on the same terms as the golden fixtures
(§8): derive the shape from that backend's real transcripts and cite the source.
A scenario invented from assumption is open-mercato/cezar#443 repeating inside the suite meant to
prevent it.

**Exemptions are data the suite validates, never an `it.skip`.** An entry in
`PARITY_EXEMPTIONS` carries a reason describing the WIRE limitation — "not
implemented yet" is a failing row, and the fix is the runner. Each entry has a
kind, because the two cases cannot be pinned the same way:

- `capability-absent` — the scenario is constructible, the backend just does not
  produce the signal. Pinned by an **inverted** assertion: the criterion must not
  hold, so a backend that later gains it fails its own exemption.
- `scenario-unconstructible` — the wire cannot create the situation at all, so
  there is nothing to invert (an unrelated baseline turn would satisfy some
  criteria by accident). Pinned by requiring the adapter to declare **no** prompt
  for that scenario, so the day a mock answers it the exemption fails and the row
  has to go live.

Guard tests assert every `(criterion, backend)` pair is a live row or an
exemption, that a kind agrees with whether a prompt is declared, and that the
file contains no skipped cell. A new id in `RUNNER_IDS` therefore fails the suite
until every row is addressed.

**Spec-support rows (hearsay-tools/cezarion#284).** The same file holds every runner's `specSupport`
declaration (§1) against its recorded boundary. Each `AgentRunSpec` field has
one probe. A `boundary` probe drives the runner twice against its mock, the two
specs differing in that field only, and compares what the mock recorded — argv
for claude and pi, JSON-RPC for codex, HTTP for opencode (`CEZ_MOCK_ARGS_FILE`),
plus the first user message where the mock records its stdin
(`CEZ_MOCK_STDIN_FILE`, claude and pi): the field is honored iff the recording
changed. `cwd` and `env` are proven by that recording landing under a RELATIVE
path, which only a child spawned in `cwd` with the env applied can produce.
`timeoutMs` is proven by a `hold` turn ending in the runner's own timeout error.
The assertion runs in both directions, so a runner that declares a field
dropped and starts mapping it fails too — Codex and OpenCode ignoring
`toolGrant` is pinned exactly as long as they declare it. The tool-grant cells
(`core/tool-grant-parity-cells.testkit.ts`) pin the flags of each Tool-list kinds
case on every wire. A new `RUNNER_IDS`
entry fails typecheck without a declaration, and fails these rows when its
`createRunner` case is missing (the factory's fallback is claude, whose
`backend` is not the new id).

**The matrix is a debugging tool, not only a gate.** Every row names the issue
whose failure mode it pins, and each was verified red by reintroducing that
defect. A red row is first evidence of a real bug, not of a bad assertion:
authoring this matrix is what found the claude half of group 1, where an
`is_error` result whose subtype is still `success` reported an auth failure to
the cockpit as a clean end of turn.

---

### Governed delegation controls (D1)

D1 inspects real runner argv, JSON-RPC and HTTP boundaries on ordinary versus
restricted start/Continue launches. These controls add no tool grants and write
no global harness configuration. Per-backend knowledge remains inside adapters.
`provision-workflows.test.ts` covers every backend's initial, nonfinal, Continue,
recovery and disabled paths, plus mixed-backend workers retaining their own
accepted identity, empty grants and distinct per-session delegation credentials.

| Backend (locally verified version) | Per-invocation control | Evidence and limitation |
| --- | --- | --- |
| Claude Code 2.1.311 | `--disallowedTools Agent,Task,Workflow,SendMessage,ListAgents` | `claude --help` documents the deny flag; installed `sdk-tools.d.ts` names `AgentInput`. `Task` covers the legacy name in recorded fixtures. `Workflow` runs a script that starts subagents: a free 2.1.303 probe (`/reload-plugins` as the only stream-json line, no model call) lists it in the init `tools` under `--disallowedTools Agent,Task` and drops it under `Agent,Task,Workflow` (hearsay-tools/cezarion#1284). `Skill` stays listed under both. Other tools and permission modes are preserved. Forked skills are not blocked; see the gap below. |
| Codex 0.153.4 | `thread/start` and `thread/resume` `config: { "features.multi_agent": false, "features.multi_agent_v2": false }` | `codex features list` names both flags; `codex --help` documents dotted config overrides; `codex app-server generate-json-schema` confirms both request config fields. Existing sandbox, approval, account and model settings remain unchanged. |
| OpenCode 1.18.33 | `POST /session` `permission: [{ permission: "task", pattern: "*", action: "deny" }]` on a fresh session; `PATCH /session/{id}` `permission` on resume when that deny is absent (installed `/doc` `session.update` accepts `PermissionRuleset`) | Installed server `/doc` declares `PermissionRuleset`; its embedded `TaskTool.execute` checks `task`. Live 1.18.33: `PATCH` with `{permission:[X]}` **appends** X (no replace, no dedupe); a title-only PATCH leaves permission alone; GET returns the session including `permission`. The deny therefore persists on the session once added — a later unrestricted Continue cannot remove it (fails closed). Continue GETs `/session/{id}` and PATCHes the deny only when `restrictNativeDelegation` is set and the rule is not already present; a 404 fallback POSTs a fresh session with the same rule. It still does not map general `allowedTools`. OpenCode 1.18.35's `task` tool skips the `task` permission ask when `extra.bypassAgentCheck` is set: for a `subtask` part, which only the `POST /session/{id}/command` handler creates (a command with `subtask: true`, or one whose agent is a subagent), and when the last user message carries an `agent` part (a client `@agent` mention). cezar's wire never takes that path: it posts only `text` parts through `prompt_async`, never calls `/command`, and `prompt_async` turns no text into either part. OpenCode's `skill` tool returns the skill's content as tool output in the same session. |
| Cursor 2026.09.15-d2fe57e | `initialize.clientCapabilities._meta.subagents = false` | Installed `src/acp/agent.ts` negotiates native delegation from this capability; `src/acp/session.ts` passes it to the agent. Ordinary runs advertise `true`; start and Continue use the same handshake. Custom tools and unrestricted shell remain outside hard isolation. |
| OMP 18.4.11 | `--config` overlay `tools.approval.task: deny`, plus `task`, `wait` and `eval` left out of `--tools` | OMP's user `deny` is absolute in every approval mode (`approval-mode.md`). OMP has no `--exclude-tools`, and no setting disables `eval`'s `agent()`/`workpool()` helpers, so `eval` is dropped from the list. With no workflow `allowedTools`, D1 passes an explicit list (OMP's default set minus those three) instead of no `--tools`, failing closed. Verified with `get_state.dumpTools` on the real binary. |
| pi 0.85.1 | `--exclude-tools subagent` | Installed `pi --help` applies exclusions to built-in/extension/custom names; the shipped `examples/extensions/subagent/index.ts` registers `subagent`. Other extension discovery and ordinary tool settings remain unchanged. |

Claude native peer messaging is suppressed for **both governed root tasks and
owned workers** whenever `restrictNativeDelegation` applies
(hearsay-tools/cezarion#557). `ListAgents` lists other native sessions and
`SendMessage` contacts them outside cezar's recorded conversations. Neither
`dontAsk` nor a narrow `--allowedTools` grant blocks these tools; the explicit
deny removes them even when a grant names them. Ordinary runner specs with the
restriction absent retain their native settings.

A bounded Claude Code 2.1.311 probe on 2026-10-27 sent only `/reload-plugins` as a
stream-json user message, with `--permission-mode dontAsk`,
`--allowedTools Read,Edit,Write,Grep,Glob,Bash` and no session persistence.
The init `tools` listed `SendMessage` and `ListAgents` under the old
`Agent,Task,Workflow` deny. Adding both names removed exactly those two tools.
A third probe explicitly allowed `Read,SendMessage,ListAgents` while denying
all five names: `Read` remained and both peer tools were absent. Each probe
reported zero model turns and zero cost; none listed or contacted another
session. These probes attest the tool catalog, not a messaging call.

**Explicit D1 pi exemption:** pi's RPC has no native delegation primitive or
capability identifying arbitrary custom delegation extensions. Only the verified
`subagent` entry point is excluded. Renamed/custom extensions remain outside that
restriction; D1 pins the exact exclusion and preserves unrelated extension/tool
settings. Guidance directs agents to cezar workers but must never be represented
as enforcement of this unsupported capability. Custom tools on other backends
and unrestricted same-user shell likewise remain outside hard isolation. Native
workers are not cezar-owned, collected, waited on or cleaned up by this protocol.
Older harness versions are not attested by this versioned capability check.

**Explicit D1 Claude forked-skill gap:** a Claude skill or command whose
frontmatter sets `context: fork` runs in a forked subagent. That covers project,
personal and plugin skills, and team skills cezar copies into `.claude/skills`.
On Claude Code 2.1.303 both entry points, the model's `Skill` tool and a typed
`/name`, reach the forked-skill launcher, which picks the agent from the session's
agent list and never consults the `Agent`/`Task` deny rules. No per-invocation
control blocks a fork while ordinary skills keep working. The `Skill(...)` deny
matcher matches names, aliases and globs only, with no `context: fork` attribute,
so only a blanket `Skill` deny would stop forks, and it would stop every skill.
`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` has a minimum of 1 and a fork runs at depth
1; `CLAUDE_CODE_FORK_SUBAGENT` is an unrelated conversation-fork feature; a
`SubagentStart` hook's output has only `additionalContext`, so a hook cannot stop
the subagent. Restricted Claude sessions therefore do not block forked skills.
Two haiku runs with a project skill under cezar's restricted argv
(`--permission-mode dontAsk`, `--disallowedTools Agent,Task,Workflow`) emitted
`system/task_started` with `subagent_type: general-purpose` and `spawn_depth: 1`
from both entry points, and the child ran `Bash`; the result's
`subagent_stats.spawned` stayed 0. The subagent is a native worker that cezar does
not own, wait on or clean up. D2 pins this gap.

**D2** (hearsay-tools/cezarion#1284), in `core/harness-parity.test.ts`, requires
that a forked skill start no native subagent in a restricted session
(`restrictNativeDelegation: true`). Only Claude's wire constructs the
`forked-skill` scenario. Its mock replays the `Skill` tool path of a real 2.1.303
capture (golden fixture `__fixtures__/claude/forked-skill.ndjson`) whatever
`--disallowedTools` says, as real Claude does. Claude's `capability-absent`
exemption is pinned by the inverted assertion: the restricted argv carries
`--disallowedTools Agent,Task,Workflow,SendMessage,ListAgents`, and the child `Bash` call still nests
under the `Skill` item. The day Claude can block forks, that cell fails and the
row must go live. A typed `/name` takes the same launcher, but its task frames
arrive before `init` and its children name a synthetic `forked-command-<name>`
parent with no tool item; the mock replays only the `Skill` tool path. The other
runners carry `scenario-unconstructible` exemptions naming the version inspected:
none starts a native subagent from skill or command frontmatter outside its D1
control.

### Native cross-session messaging at shipped defaults (D3)

Spec `.ai/specs/2026-10-27-task-communication-protocol.md` § 11 and
hearsay-tools/cezarion#1994. A runner's native cross-session messages bypass cezar's
recorded conversations: they carry no ledger, cockpit attribution, receipt or deadline,
and no protection for human questions. Cezar tasks talk through `cez message` with
`CEZ_DELEGATION=1`. Every session's instructions (`handoffInstructions` in
`packages/cezar/src/handoff.ts`, "Messaging other tasks") say so at shipped defaults
and under D1. The table records each runner's entry points, as inspected on the
installed versions on 2026-10-27.

| Runner (inspected version) | Native cross-session entry points | Shipped default (`CEZ_DELEGATION` unset) | Under D1 |
| --- | --- | --- | --- |
| Claude Code 2.1.311 | Outbound: `SendMessage` and `ListAgents`. They reach other local sessions, cloud and Remote Control sessions, and also the session's own subagents, background agents and teammates. Inbound: other sessions' `SendMessage`, governed by the `crossSessionInbound` setting (`accept`, `hold`, `refuse`; unset delivers when the sender's permission-mode class matches). | Inbound refused: every launch passes `--settings {"crossSessionInbound":"refuse"}`. Outbound tools stay callable, because a deny would also stop follow-ups to the session's own subagents and teammates, and break plugin agents and skills that call `SendMessage`. | Inbound refused, as at defaults. Outbound denied by `--disallowedTools Agent,Task,Workflow,SendMessage,ListAgents` (hearsay-tools/cezarion#1975). |
| Codex 0.164.0 | None at defaults. The `multi_agent` tools (`spawn_agent`, `send_input`, `wait`) reach only agents of the same session. The cross-thread `agent_message_board` feature is "under development" and off by default. | No control: cezar sends no flag for an unstable feature key. | `features.multi_agent` and `features.multi_agent_v2` off (D1). |
| OpenCode 1.19.4 | No messaging tool and no inbound channel. The `task` tool with `task_id` resumes any session by ID without checking its parent. | No control. The `task` permission pattern matches only `subagent_type`, so no session rule blocks a foreign `task_id`, and a deny on `task` removes native subagents. Only the shell finds another session's ID, and the shell reaches that session directly (`opencode run --session <id>`); the same-user shell is outside hard isolation (spec § Out of scope). Blocking `task_id` alone would need a new OpenCode plugin and would not close the shell path. | `task` denied (D1). |
| pi 1.4.0 | None built in. An extension may add a messaging tool. | No control: an extension's name cannot be discovered as messaging. | `subagent` excluded (D1). |
| Cursor 2026.10.22-27dcf5f | The agent protocol defines `send_message` (to cloud agents); the CLI never sets `sendMessageEnabled` and has no handler. | Unreachable; no control needed. | `task_tool_call` left out of `--allowed-tools` (D1). |
| OMP 18.13.1 | None in the default set (`get_state.dumpTools`: read, bash, edit, eval, glob, grep, find, task, wait, todo, web_search, write). `vibe_*` and `irc` are opt-in in the user's own config. | No control. | `task`, `wait` and `eval` removed (D1). |

**Verification limits.** A bounded Claude Code 2.1.311 probe on 2026-10-27 sent only
`/reload-plugins` as a stream-json user message (no model turn) with
`--settings '{"crossSessionInbound":"refuse"}'` and got a normal init. This verifies
that Claude accepts the flag. It does not verify the cross-session effect: that needs a
model-driven `SendMessage` between two live sessions, which no probe here made. Claude
ignores an unknown value of this setting without a warning (the same probe with
`"bogus"` also started normally), so a renamed key or value fails open: other
sessions' messages would reach the task again, and only the session instructions would
remain.

**User setup.** No row changes a user's MCP servers, plugins or tool settings. MCP
tools are named `mcp__<server>__<tool>`, and the Claude flag is one setting in the
`--settings` layer, which Claude merges with the user, project and local settings.
The only behavior a user loses at shipped defaults is sending messages from their own
other Claude sessions into a cezar task; human input reaches a task through the cockpit
or `cez task send`.

**D3** (hearsay-tools/cezarion#1994), in the per-runner `core/harness-*-parity.test.ts`
files, drives each runner's `baseline` scenario on start and Continue with no
`restrictNativeDelegation`. Claude's row is live: the argv carries the
`crossSessionInbound: refuse` settings and no `--disallowedTools`. The other runners
carry `capability-absent` exemptions naming the version inspected, pinned the other way
round: their default wire carries no cross-session control. The day cezar adds one,
that exemption must go.

**Compatibility (2026-10-27, deliberate).** The one changed default is Claude's inbound
refusal. Every Claude launch, with or without `CEZ_DELEGATION=1`, passes the setting, so
the user's other Claude sessions can no longer send `SendMessage` text into a cezar task.
That path was never a cezar surface: the text bypassed the cockpit, the ledger and the
handling of human questions. Human input still reaches a task through the cockpit and
`cez task send` outside a task. Outbound `SendMessage` and `ListAgents` stay callable at
shipped defaults, and D1 still denies them. No runner's MCP servers, plugins or tool
grants change, and the other runners send no new flag. The "Messaging other tasks"
section is prose, not a marker: an older cezar never parses it. The setting is per launch
and writes no file, so a revert restores the old behavior on the next launch, and no state
migrates.

Provisioning supplies the bundled absolute CLI invocation and fresh environment
credentials for both parent and worker sessions; it never copies the parent's
credential to a worker. With delegation disabled/unavailable, the intent is absent
and ordinary execution keeps its prior settings. Start/Continue/recovery share the
same provisioner, including nonfinal workflow steps.

The governed command protocol is documented with runnable forms in [README](README.md#owned-workers-opt-in).
Spawn supports selected context (`--context` or UTF-8 `--context-file`) and backend/
model selection; omitted backend follows the active parent, same-backend omitted
model/account/effort inherit, and mixed-backend defaults resolve independently.
Inspect reports materialized input paths. Wait defaults to `any`; `one` requires
one worker and `all` every selected worker. All waits have finite 1–1800 second
deadlines (600 default), return immediately, and release capacity at turn end.
`cancel-wait <wait-id>` cancels only waiting, preserving worker work.

`collect <worker-id>` returns typed availability and persists the latest execution
revision's summary, HEAD, bounded diff and artifact descriptors under the parent.
An available `diff.path` names a JSON `{ result, diffSnapshot }` document, **not a
raw patch**. Latest settled collection is required for parent readiness; running
or obsolete collected output cannot satisfy it. Collection is observation, not
integration. Automatic completion wakes for inspection/collection without silently
accepting review. A done blocked by live or uncollected workers is refused once as an automatic
turn; a repeated one parks on Cezar's deadline-less worker wait on the live workers, or, with only
uncollected results, on Cezar's human wait (hearsay-tools/cezarion#1301). Human
Finish refuses unmet readiness. Continue a reviewing parent before its worker.

Review and deliberately integrate desired worker commits with Git before cleanup.
Collect/integrate, destroy owned resources, explicitly delete child histories, then
delete the parent. Summary and bounded diff snapshots survive child deletion until
parent deletion; general artifacts are not archived. Removed paths, branch names
and historical SHAs do not promise live resources. A worker's pending human ask is
never answered by lifecycle input, and no automatic merge/review acceptance exists.

---

### Claude selected-model refusals (hearsay-tools/cezarion#1351)

A live Claude process can retry the exact “There's an issue with the selected
model (...)” result after that same reported session and model completed a
successful turn with usage. Eligibility requires an `is_error` result with
explicit zero input/output usage, zero other accounting counters and no work in
that attempt. The refusal's own assistant text is diagnostic; tools, reasoning,
other text, background-task or hook system frames, tool progress, nonzero usage
or cost forbid replay. Missing identity or usage,
changed model, authentication, rate limits and other errors keep their existing
failure paths. A resumed session id alone proves no success: eligibility starts
afresh in every runner process.

The shipped default is two extra submissions, after 5 and 15 seconds, on the
same session with the exact input content and unchanged model, account and grants.
Each retry records its reason, attempt and delay as a note. Each native attempt
has balanced v2 turn events, but intermediate refusals emit no v1 fatal error or
workflow `turn-end`. Retry state is process-local; there is no durable wake,
new run status, configuration or migration. A successful retry settles the input
once and drains later human input; new worker input is refused during backoff
and retry. Later human input is held in order. Exhaustion preserves the first
refusal and follows the existing failure path. Stop, Finish, timeout, process
exit and output closure cancel the retry timer. An unexpected exit during
backoff preserves the refusal rather than returning false success.

| State | Trigger | Who fires it | Behavior at shipped defaults |
|---|---|---|---|
| Active attempt | Eligible result | Claude reader | Bounded backoff; keep logical input pending |
| Backoff | 5s or 15s expires | Runner timer | Same input, fresh native UUID, same logical delivery IDs |
| Retry attempt | Success | Claude reader | Normal settlement; release later input |
| Retry attempt | Exhaustion or other error | Claude reader | Existing fatal path, first refusal retained |
| Attempt or backoff | Stop, Finish, timeout, process exit or output closure | Existing teardown and reader | Cancel retry; settle through existing cleanup |
| Recovery without session | Restart | Existing recovery | No inferred success; no retry until live success is observed |

`claude-model-refusal.test.ts` drives Claude's native mock with controlled time.
Shared row **S32**, in `model-refusal-parity.test.ts`, uses every `RUNNER_IDS`
entry's own `HARNESS_ADAPTERS` wire after a successful turn. Claude exhausts its
two retries; the other runners retain their native terminal-rejection policy.
Every cell must preserve a diagnosis and settle. This does not assert that the
other protocols expose Claude's exact zero-usage selected-model result.

<a id="codex-retrying-stream-errors-550"></a>

### Codex retrying stream errors (hearsay-tools/cezarion#550)

App-server `error` notifications map `error.message` plus nonempty
`error.additionalDetails` to a v1 `note` and v2 `session.error` with `fatal: false`
while `willRetry: true`. A `warning` notification's message uses the same
nonfatal channels. `willRetry: false` fails the session immediately and maps to
`session.error` with `fatal: true`. Malformed errors have no effect.

The first retry error for the active main-thread turn starts a fixed 60-second
no-progress deadline, enabled by default with no configuration. Later errors
update the retained failure reason without extending the deadline. Nonempty
assistant/reasoning/tool-output deltas, model/tool item lifecycle events and a
valid current-turn native question prove recovery and clear the deadline.
User input, metadata, warnings, repeated errors, stale turn output and child
thread activity do not. A later retry episode gets a fresh deadline. Completion,
new-turn start and session shutdown clear retry state; recovered turns complete
normally, and human-question waiting has no retry deadline.

Expiry emits v2 `turn.completed` with `stopReason: error`, then uses the existing
TERM/KILL teardown and rejects the session result with the latest error, failing
the run only after process exit. It never converts the error to a successful
turn-end or leaves a live child holding capacity.

Harness row R17 runs against every `RUNNER_IDS` adapter's native wire. Codex
replays the recorded reconnect errors without a terminal notification; the other
adapters use their native terminal provider rejections. Every cell must leave
`running` as `failed` with a reason, never park for user input. Exact deadline,
recovery, stale/foreign traffic and cleanup regressions use the real Codex RPC
reader with a controlled process clock. `__fixtures__/codex/stream-retry.md`
records the real probe's provenance and the limits of the captured excerpt.

---

## 8. The golden-fixture testing contract

Each backend has, under `packages/cezar/src/core/__fixtures__/<backend>/`:

- `<name>.ndjson` — a **wire-faithful** transcript of the backend's real output
  (shapes from `agent-event-protocols.md`, cross-checked against the backend's
  actual CLI / the dry-run mock, e.g. `packages/cezar/scripts/mock-claude.mjs`).
- `<name>.expected.json` — the **exact** `UiEvent[]` the mapper must produce for
  that transcript.

`<backend>-ui-mapper.test.ts` replays each fixture **exactly as the runner drives
the mapper** (seed turn started before the first line; malformed lines skipped),
round-trips the result through JSON (so a stray `undefined` fails loudly, since
these events get persisted as NDJSON), and asserts `toStrictEqual` against the
`.expected.json`. The same `.expected.json` files feed the parity test in §6.

> Verify fixtures against **upstream wire shapes**, never against your own
> assumptions. PR open-mercato/cezar#443's root cause was a fixture that encoded an *assumed*
> codex shape (`todoList` items that the app-server never emits), which hid a bug
> where a codex plan never rendered at all. When adding a fixture, cite the
> upstream schema/source it was derived from, as open-mercato/cezar#443 did.

## 9. Persistence & transport

- **NDJSON** — one append-only `runs/<id>.ndjson` per run, one JSON object per
  line (`seq`, `ts`, `type`, free extra keys). Never rewrite, reorder or
  re-number; readers skip bad lines. Both v1 and v2 events live here; a mixed
  file is valid. Cezar-owned task events are additive too: for example,
  `provider-auth-required` records only `{ provider, authFailureId, stepId? }`
  when a runtime rejection needs user authorization; it never carries vendor
  error text or credentials.
- **SSE** — the server replays from NDJSON then streams live, deduped by `seq`.
  Event names: `run-event` (v1) and `ui-event` (v2 dotted types). These names are
  a protected contract (see `BACKWARD_COMPATIBILITY.md`).

---

<a id="10-adding-a-new-runner-the-387-pi-checklist"></a>

## 10. Adding a new runner (the open-mercato/cezar#387 `pi` checklist)

A new backend is a **single class behind the seam** plus its mapper, fixtures and
its rows in **both** parity matrices — never backend-specific types leaking past
`packages/cezar/src/core/`. PR open-mercato/cezar#387 added `pi` and enumerated every place the
runner union was duplicated; that list is the concrete map, and the union now
derives from one `RUNNER_IDS` tuple in `agent-runner.ts` so most of it is
typecheck-enforced rather than hand-tracked.

To be first-class:

1. **Runner** — `packages/cezar/src/core/pi-runner.ts` implementing `AgentRunner` /
    `AgentSession` (persistent process; `pid`; `sendMessage`/`discardQueuedMessages`/`holdsHumanInput`/`end`/`interrupt`;
   `result`). Honor `AgentRunSpec` uniformly — use `prependSystemPrompt` if the
   backend has no native system-prompt channel — and declare `specSupport` (§1):
   every field, honored with its channel or dropped with the wire reason. The §7
   spec-support rows hold the declaration against the mock's recording. Declare
   `systemPromptOnResume` (§1, hearsay-tools/cezarion#790): `resent` when every
   session/process delivers `spec.systemPrompt` again (so Continue must resend a
   skill playbook — Claude keeps the launch prompt and ignores new flags, so changed
   extra/delegation/artifact/handoff instructions never reach a resumed session; Pi
   replaces stored sections with the new flags; OMP was not live-verified and is
   declared `resent` as the safe value), `in-thread` when the opening turn prepended
   it into resumed history (OpenCode, Codex, Cursor). The flag is the caller's
   skill-prefix dedupe policy — in-thread runners still re-prepend the whole
   `spec.systemPrompt` (extra prompt + handoff) on every resumed opening turn. Required
   — a new runner fails to compile until it decides. Declare
   `inputDelivery` (§1) from a live probe of mid-turn input, and pass the §7 I1/I2
   rows or declare their exemption.
2. **Factory** — add the id to `RunnerId` / `RUNNER_IDS` (`agent-runner.ts`) and
   a `case` in `createRunner` (`runner-factory.ts`). Add `UiBackend` in
   `ui-events.ts` **and its mirror** `packages/api-client/src/protocol/ui-events.ts` (the
   type-exactness test guards drift).
3. **Detection** — a `probePi()` in `backend-detect.ts` plus the `BackendCheck`
   name union; degrade gracefully when the CLI is absent (never fail boot). If it
   needs a binary override, add `CEZ_PI_BIN` — and per AGENTS.md's zero-config
   rule, document any new `CEZ_*` var in `.env.example` in the same commit.
4. **Mapper** — `packages/cezar/src/core/<runner>-ui-mapper.ts` emitting the full
   v2 `UiEvent` stream **alongside** v1. Never throw on malformed input; explicit
   immutable state.
5. **v1 alongside v2** — wire `SessionOptions.onUiEvent`; keep the v1
   `AgentEvent` stream flowing unchanged.
6. **Golden fixtures** — `packages/cezar/src/core/__fixtures__/<runner>/*.ndjson` +
   `*.expected.json`, wire-faithful and citing their upstream source, covering
   **every** parity matrix capability (§6), and a `<runner>-ui-mapper.test.ts`
   replaying them.
7. **Parity** — add the id to `BACKENDS` in `ui-parity.test.ts`; every capability
   row must pass. (If the backend has no wire parent attribution, document the
   nesting cell's substitute the way codex's review-mode items are handled.)
8. **Harness parity** — add the runner to `HARNESS_ADAPTERS`
   (`packages/cezar/src/core/harness-parity.testkit.ts`): the env var that points it at an
   offline mock, and a prompt for every name in the shared scenario catalog (§7). Then make
   that mock answer them, in the backend's own wire shape. **Every matrix row must pass** —
   the guard tests fail the suite until each `(criterion, runner)` cell is a live row or a
   declared `PARITY_EXEMPTIONS` entry naming the wire limitation. Never an `it.skip`, and
   never "not implemented yet".
   Choose the ask path explicitly: either map the backend's native question wire to
   `ask.requested`, or rely on the portable `CEZ:ASK` marker path in `workflows/run.ts`.
   A native bridge must keep its pending request in that runner's `AgentSession` state and
   route the next human answer through the same state back to the provider. Harness rows R3
   and R4 pin valid and malformed asks; R6 and R7 pin human-answer routing, queued agent
   input, and recovery with an unanswered ask. R26 pins completion after answering
   every exposed human ask kind in `askResumeCases`. A native-answer `end_turn`
   does not hand off to the human: resume the work unless the agent declares a
   terminal state, monitoring or another ask. Extra native kinds such as
   `create_plan` (and permissions if exposed as human asks) need the same resume
   coverage. Cursor permissions currently auto-resolve and do not create human asks.
   CI-wait exposure must also satisfy the CI-wait contract above: declare
   `cezarTools` in `specSupport`, preserve user configuration, prove discovery and
   actual invocation on fresh/resumed/recovered sessions, and verify the installed
   adapter with deterministic dry-run fixtures. Do not treat argv/config snapshots
   as transport proof or add a silent exemption for an unsupported CI tool.
9. **Plumbing** — the run-store `runner` enum, workflow step schema, the
   `POST /api/runs` / `PUT /api/config` bodies, `resumeCommand()`, the web
   `Runner` type, composer pills/presets, and Settings → Agents. Keep additive
   so old `runs.json` records still parse (the `runner` enum keeps `claude-cli`
   parseable — follow that precedent). **Settings → Agent config ships with the
   runner, not after it**: one `AGENT_DESCRIPTORS` entry in
   `packages/web/src/routes/settings/agent-descriptors.ts` keyed by the runner id,
   plus the vendor's documented config files in
   `packages/cezar/src/agent-config/catalog.ts` (paths, format, verbatim
   precedence, `docsUrl`; a home variable goes in `AgentHomePaths` /
   `agentHomePaths()` only when the vendor documents one). The guard in
   `agent-descriptors.test.ts` fails the suite for any `RUNNER_IDS` member
   without a descriptor, the way item 11's guard fails one without a
   model-discovery adapter (hearsay-tools/cezarion#321). A vendor that documents no editable file still gets its
   tab — give the group `empty` copy that says why and what to try, never omit
   the agent (hearsay-tools/cezarion#322, Pi's MCP group: "No MCP.").
10. **Model selection** — accept `provider/model` where relevant; open-mercato/cezar#387 documents
   the existing inconsistencies (opencode drops a bare model silently) — do not
   reproduce a silent-drop. A backend with no default provider gets no entry in
   `BACKEND_MODEL_MAP`'s default column, so a bare id fails loud.
11. **Host model discovery** — the picker lists the models the user's own CLI can run
   today, never a preset table. Discovery landed one runner at a time after each had
   shipped without it (hearsay-tools/cezarion#1 pi, hearsay-tools/cezarion#18 invalidation after login, hearsay-tools/cezarion#74 codex failure reasons,
   hearsay-tools/cezarion#89 claude), which is why it is a checklist step and not a follow-up. Nothing derives
   it from `RUNNER_IDS`: `modelDiscoveryRunnerSchema` is a hand-kept enum and
   `RunnerModelCatalog` takes a `Partial` adapter map, so a runner that skips this step
   fails nowhere — `GET /models` answers `unavailable` and the picker shows presets
   again. Seven pieces, in the same PR as the runner:
   - **Adapter** — a bounded `packages/cezar/src/core/<runner>-model-catalog.ts`
     exporting `discover<Runner>Models({ cwd })`. Spawn the CLI's own model-listing
     surface under the runner's sanitized child env (`pi --list-models`, codex
     `model/list`, claude stream-json `list_models`, opencode `models`), cap it (the pi
     precedent is 10 s, 512 KB of stdout, 500 models), and **throw on every failure** —
     absent CLI, too old, not logged in, malformed, timeout — so the catalog degrades to
     `unavailable` and boot never fails. Never read the CLI's config or cache files, and
     never run a model turn to discover.
   - **Contract enum** — add the id to `modelDiscoveryRunnerSchema`
     (`packages/contract/src/workspace.ts`); `runnerDiscoversModels` and the `/models`
     query validator both read it.
   - **Catalog registration** — add the adapter to `hostModelCatalogAdapters`
     (`packages/cezar/src/core/host-model-catalog.ts`), the map `server.ts` hands to
     `RunnerModelCatalog`. It is a full `Record` over the contract enum, so the previous
     bullet without this one is a typecheck error, not a silent `unavailable`.
   - **`GET /api/v1/models?runner=<id>`** — answers `{ runner, models, source:
     live | cache | unavailable, stale, reason? }` with no route change once the two
     bullets above are in; add the runner to `models-api.test.ts`.
   - **Picker** — `packages/web/src/routes/new-task-form.ts`: `mergeModels` lists the
     live catalog and keeps only the first preset as the fallback alias when
     `runnerDiscoversModels` holds, and `DISCOVERY_RUNNER_LABEL` needs the runner's
     display name for the "cached" / "unavailable" hint.
   - **Sanitized `unavailableReason`** — a `reason` is a stable one-line category
     (spec `.ai/specs/2026-07-21-codex-latest-model-discovery.md`, hearsay-tools/cezarion#74): never raw
     stderr, a command line, env or config content. A stale cache is served with the
     reason attached, not dropped.
   - **Invalidation** — `RunnerModelCatalog.invalidate(runner)` after provider
     Connect / Check / refresh (`invalidateHostModels` in `server-deps.ts`, hearsay-tools/cezarion#18), so an
     `unavailable` answer is never cached across a login. Retry is the same call.

   The pin is `packages/cezar/src/core/model-discovery-guard.test.ts`: every `RUNNER_IDS`
   member must be in the contract enum, ship the adapter module and be registered on the
   host catalog, unless `MODEL_DISCOVERY_EXEMPTIONS` names it with the wire reason (a CLI
   with no model-listing surface at all) — never "not implemented yet". Adapter behaviour
   stays covered by `<runner>-model-catalog.test.ts` and `models-api.test.ts`; the §6/§7
   parity matrices deliberately carry no discovery row.
12. **Credentials** — one entry in `BACKEND_ALLOW_PREFIXES` (`agent-env.ts`):
   `buildChildEnv` is least-privilege per backend, so a multi-provider runner
   must receive credentials for every provider its own model ids can name
   without widening other backends.

### OMP lessons (hearsay-tools/cezarion#595)

OMP is the second Pi-shaped runner, and each place it differs from Pi broke a Pi assumption.
Check these before copying an existing runner's code for a fork or near-fork of its wire:

- **No `agent_settled`.** Copying Pi's turn trigger would hang every OMP turn. Read the
  upstream docs' own statement of the boundary (`prompt_result`, `session_settled`) and never
  treat `agent_end` as terminal: it is non-terminal while OMP retries or compacts.
- **No `--session-id`.** The session id is discovered from `get_state` and Continue uses
  `--resume <id>` (the Codex/Cursor precedent).
- **No `--exclude-tools`.** `--tools` is an allowlist validated against OMP's registry: an unknown
  name, or a built-in the session has not enabled, exits 2 before any frame. Never pass an unmapped
  name through, keep the default list to tools that are on by default (`find` and `ast_grep` are
  not), and handle the refusal for tools a user's settings disabled, or MCP tools OMP has not
  registered, by respawning once without them. OMP spells MCP tools `mcp__<server>_<tool>`, not
  Claude's `mcp__<server>__<tool>`.
- **Not every omp build takes every flag.** OMP fails fast on an unrecognized flag
  (`Error: unknown flag(s): …`, exit 2). `--add-dir` is the one optional flag cezar passes, so a
  build that rejects it is respawned once without it, with a note; any other unknown flag stays
  fatal, because model, prompt, resume and tools are not optional.
- **Diffs and plan come from the tool result**, not the args: the default `hashline` edit mode has
  args `{input}` only.
- **The ask marker works in plain `--mode rpc`** because OMP never registers its native ask tool
  without a UI; do not build a native ask bridge there.
- **Sub-agents are on the wire**, so S9/R12/R15 are constructible and carry no exemption.
- **`omp models --json` prints an object** (`{"models": [...]}`), not an array, and exits 0 with an
  empty list when logged out.
- **Record real-binary evidence, and say what you could not run.** Startup frames, `--tools`
  refusals and `dumpTools` were recorded first, and the turn fixtures were source-derived and
  labeled while no OMP login existed; live turns later confirmed streaming, a same-turn steer,
  `--resume` and interrupt (fixtures README verification ledger). A constructed frame (the mock
  sends frames after settle that the real wire never does) is labeled constructed, not passed off
  as a capture.

<a id="11-the-plan-channel-pr-443"></a>

## 11. The plan channel (PR open-mercato/cezar#443)

PR open-mercato/cezar#443 (`fix/issue-433-render-plan-todo`, open at the time of writing) hardens
`plan.updated` across Claude, Codex and OpenCode after finding the plan never reached the
cockpit dock — for a different reason on each backend. Its direction, which any
new runner should follow:

- **Claude** — current-session plans use `TaskCreate` / `TaskUpdate` / `TaskList`
  (not only `TodoWrite`); classify all of them as plan tools and fold them into
  a snapshot keyed by the task id the harness reports in each tool's **result**.
- **Codex** — the real plan channel is the turn-level notification
  `turn/plan/updated`, not a `todoList` item (which the app-server never emits);
  map it to `plan.updated` as a full replacement.
- **OpenCode** — `status` is free-form upstream; `cancelled` is a documented
  value. Don't whitelist a few statuses and silently drop the rest — an
  unrecognized status degrades to `pending` so a todo the agent wrote stays on
  screen.
- **General** — `plan.updated` is full-replacement; only a genuinely empty list
  clears the dock (a malformed frame maps to zero events, never a wipe).

The `plan.updated` **event name and payload structure are unchanged**; open-mercato/cezar#443
extends the *handling*, not the wire shape (on `main`, `PlanStatus` is the three
values in §3).

---

## Compatibility

The agent event protocol is a protected surface: see `BACKWARD_COMPATIBILITY.md`.
V1 `AgentEvent` `type` strings and v2 `UiEvent` dotted types are
additive-only; removing/renaming one, or breaking the parity requirement, is a
breaking change requiring an explanation and migration path.

## Related documents

- `.ai/specs/2026-09-04-harness-parity-matrix.md` — the harness parity matrix's design record (§7).
- `AGENTS.md` — repo working rules; the "Agent runners / backends" routing row.
- `BACKWARD_COMPATIBILITY.md` — the compatibility policy.
- `.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md` — the deep design record (§7, §7.1).
- `.ai/specs/2026-07-14-cockpit-ui-redesign.md` — the spec (protocol v2, parity requirement).

<a id="bounded-structured-question-recovery-88"></a>

### Bounded structured-question recovery (hearsay-tools/cezarion#88)

A CEZ:ASK payload missing only closing braces/brackets after a complete structural value gets one bounded repair, then the existing schema validation. Mid-string truncation, mismatched delimiters and invalid question structures remain rejected. Fresh and continuation turns persist a danger note for recovery or rejection; a recovered card warns users to check the options and how many they may pick, since repair cannot restore missing meaning. The raw recovered marker stays in the audit stream until the cockpit hides it alongside a validated card, preserving rejected split-stream fallback. Existing and unknown note tones stay dim. DONE/ASK precedence, Claude wakeups and monitoring serialization are unchanged.

Harness row S13 verifies the late auto-end veto and subsequent reply completion against every `RUNNER_IDS` backend’s real offline wire.


<a id="codex-managed-permissions-708"></a>

### Codex managed permissions (hearsay-tools/cezarion#708)

Before fresh or resumed threads, query `configRequirements/read` on the session's
own app-server. Only `requirements: null` selects Cezar's unmanaged full-access
sandbox (needed by containers without UID maps). Managed requirements, including
unknown future fields, retain Codex's permissions. Codex resolves saved profiles
and managed defaults on resume; Cezar never replaces an allowed read-only profile
with a writable default. Unavailable or malformed discovery never
selects full access. Approval policy is never overridden.

`CEZ_CODEX_NETWORK=0` disables legacy workspace network access without replacing
managed filesystem rules. The thread response must confirm restricted network
access before any turn starts; incompatible profiles stop with a clear error.
Follow-up `turn/start` and `turn/steer` do not set permission overrides.

Registered harness row S14 exercises fresh/resumed sessions and repeated human
messages through every `RUNNER_IDS` member's `HARNESS_ADAPTERS` native wire. The
Codex mock models a rejected override retained and revalidated on later turns;
this reproduces the reported diagnostic pattern, not an independently captured
enterprise-account trace. `codex-permissions.test.ts` additionally covers sandbox
and profile requirements, read-only policy, unknown discovery, network restriction
and mid-turn steering. Removing the startup selection must fail the managed cells.

### Codex approval routing (hearsay-tools/cezarion#1049)

A JSON-RPC message with a method and a numeric or string ID is a server
request, never a notification. Cezar handles modern command execution, file
change and permission approval requests, MCP tool approvals and
`item/tool/requestUserInput`. Every other server request receives `-32601`
(method not supported); a malformed supported request receives `-32602`.
Unsupported legacy approvals, dynamic tools, other MCP elicitations (forms, URLs),
token refresh and attestation therefore cannot silently stall the transport.
Notifications have no reply.

#### MCP tool approvals (hearsay-tools/cezarion#1294)

Codex gates every MCP tool call by the server's or tool's approval mode
(`mcp_servers.<name>.default_tools_approval_mode`, `…tools.<tool>.approval_mode`:
`auto | prompt | writes | approve`), separately from `approval_policy`. Unless the
mode is `approve`, it asks the client first with `mcpServer/elicitation/request`.
Cezar sets `approve` on its own server's per-thread entry, so its tools never wait
on a prompt, and never sets `approval_policy`.

An elicitation is a tool approval when its `mode` is `form`,
`_meta.codex_approval_kind` is `mcp_tool_call` and `requestedSchema` asks for
nothing (absent, null or no properties), the test Codex's own TUI applies. It
routes like the other approvals: the same thread and turn checks, a
`permission.requested` titled "Codex requests an MCP tool call" with the server,
message, tool description and arguments, and these options, each answered with
the exact native reply:

| Option | Offered when | Reply |
| --- | --- | --- |
| Allow once | always | `{ action: "accept", content: null, _meta: null }` |
| Allow this tool for this session | `_meta.persist` names `session` | `{ action: "accept", content: null, _meta: { persist: "session" } }` |
| Always allow this tool (saved in your Codex config) | `_meta.persist` names `always`, and the server is not cezar's own | `{ action: "accept", content: null, _meta: { persist: "always" } }` |
| Decline and continue | always | `{ action: "decline", content: null, _meta: null }` |

Codex saves `always` as an approve rule in the user's Codex config, so it is never
offered for cezar's per-run server. Codex reads `cancel` as the same skipped call
as `decline`, so it is not offered. If Codex still asks before a cezar tool (an
older Codex that ignores the key, say), the request reaches Needs you like any
other; it is never answered silently. Elicitations carry no item ID.

`.ai/scripts/probe-approvals.ts` checks this routing against the installed Codex
in one paid turn (hearsay-tools/cezarion#1343). It builds a scratch `CODEX_HOME`
from the user's provider settings only, with no `approval_policy`, and runs
cezar's own runner and tool socket beside a second, marker MCP server. The model
calls the marker tool and then `cezar_wait`. The probe prints the thread's
`approvalPolicy`, every server request with cezar's reply, and each
`mcpToolCall` status. A default run shows the cezar call completed with no
approval request, and the marker call's `permission.requested` answered with
"Allow once". With `--answer decline`, the marker call is rejected. CI never
runs the probe.

Approvals emit the `permission.requested` event with an opaque, fresh
request ID, item ID when present, a title, full action/scope details and offered
options. Command `availableDecisions`, when supplied, is authoritative, including
structured execution-policy and network-policy amendments. Absent or null lists use the
native command/file decision defaults. Permission-profile requests instead grant
only the requested profile with an explicit turn or session scope, or return an
empty grant. Cezar never changes the administrator's approval policy.

The cockpit shows the request under Needs you and sends only `{ requestId,
optionId }` to `POST /api/v1/runs/:id/permissions` (or its project alias). The
runner alone retains each exact native response and exposes the optional
`AgentSession.respondPermission(requestId, optionId): boolean` seam. An unknown,
expired or already answered request, or a non-offered option, is refused without
writing a grant. Free text, agent messages, autonomous nudges and a worker's
parent cannot answer approvals. Permission decisions never use Continue.

Concurrent requests retain separate identities and resolve independently through
`permission.resolved`. RunManager parks the run, releases its workspace slot,
pauses autonomous input and the managed no-progress timer, and resumes only when
all approvals have resolved. `hasPendingPermission` is an optional live-attention
scalar on records and summaries; it grants nothing. Compact history retains
outstanding permission events even outside the newest visible page.

Turn completion/failure, `serverRequest/resolved`, Stop, session closure and
transport loss retire pending approvals; writable transports receive a rejection
before closing. Expiry disables the old card. Recovery creates a new native
session generation for an interrupted approval turn and never replays a stored
approval decision. An owned worker awaiting approval remains unfinished on
restart; recovery cannot classify its wait as successful completion.

The wire contract follows the [official app-server documentation](https://developers.openai.com/codex/app-server/)
and Codex 0.160.1's generated JSON schemas. Focused native-runner tests pin
structured decisions, malformed/unhandled requests, concurrent requests and
teardown. P1 pins the manager/API path and terminal continuation.

<a id="recoverable-opencode-skill-discovery-723"></a>

### Recoverable OpenCode skill discovery (hearsay-tools/cezarion#723, hearsay-tools/cezarion#1265)

OpenCode's [skill loader](https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/skill/index.ts#L105-L116)
skips a skill it cannot load after publishing an unscoped `session.error` with
`error.name: UnknownError`. For an unreadable file, `error.data.message` is
`Failed to parse skill <path>` (captured on 1.18.33, hearsay-tools/cezarion#723).
For malformed YAML frontmatter it is the `FrontmatterError` text from
[config/markdown.ts](https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/config/markdown.ts#L20-L34),
`<path>: Failed to parse YAML frontmatter: <parser detail>`; a 2026-10-18
reproduction on OpenCode 1.18.35 showed the turn going on to answer after that
frame (hearsay-tools/cezarion#1265). Cezar classifies both as recoverable only
when the path ends in `/SKILL.md` (or a Windows separator); the frontmatter path
must start the message and sit on one line, while its detail may span lines or be
empty. Cezar then emits a v1 `note` and a v2 `session.error` with `fatal: false`.
The unreadable-file note preserves the path and suggests checking readability and
repairing or reinstalling the skill. The frontmatter note names the path, keeps the
parser detail collapsed to one line, and suggests fixing the frontmatter between
the `---` lines, for example by quoting values that contain a colon or a quote, or
removing the skill. Neither warning sets the turn's error flag or enters the
agent-input ACK barrier. A successful later idle remains `end_turn`. All scoped
errors, even with the same text, and all other unscoped errors keep existing
failure handling. No protocol shape changes or automatic filesystem repairs are
involved.

Harness cells R44/R45 exercise fresh and Continue success through the native
OpenCode wire: the mock's `mock:skill-warning` sends both unreadable-file
diagnostics and the frontmatter frame captured from `opencode serve` 1.18.35.
Other `RUNNER_IDS` members have named executable wire exemptions for these
server-wide skill diagnostics. R46 exercises genuine provider failure on Continue
through every native `HARNESS_ADAPTERS` wire, complementing fresh R2. The
OpenCode cells also retain scoped skill-text, scoped frontmatter-text
(`mock:scoped-frontmatter-failure`) and unscoped provider failures; mapper and
withheld-ACK tests cover completion state and barrier bypass for both diagnostics.

### CI conflict observation parity (hearsay-tools/cezarion#1339)

R81–R84 in `workflows/ci-wait-conflict-parity.test.ts` exercise every
`RUNNER_IDS` native mock through `HARNESS_ADAPTERS`, with a real GitHub client
and supervisor reading explicit `CONFLICTING` metadata from a separate gh wire.
R81 covers a fresh session, R82 a Continue, and R83 restart recovery without an
active session. They read committed rows before wake admission, inject a failed
checkpoint, retain one lifecycle input across duplicate completion, and deliver
one conflict observation over the native prompt channel. R83 also reboots with
a resolved but undelivered result after the external PR becomes clean: the saved
observation must survive without reclassification. No timer or repair authority
is introduced.
R84 cancels an open wait while native gh checks are blocked, then attempts late
resolution and proves there is no lifecycle input or native conflict prompt.
