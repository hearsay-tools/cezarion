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

The engine depends on the `RunnerFactory` type, not on that module. `RunManager` takes a
factory in its options and puts it on `RunModuleContext`; the planner and the task namer take
one as an argument. The entry points (`src/index.ts`, and serve through the boot manager)
pass `createRunner`. A test that drives one runner passes a factory for that runner only, so
its import closure holds one adapter (hearsay-tools/cezarion#2939).

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
  readonly facts?: RunnerFacts;           // this runner's RUNNER_FACTS row (hearsay-tools/cezarion#2991)
}
type InputDelivery = {
  readonly consumption: 'observable' | 'unobservable';        // does the wire show the model read it?
  readonly acknowledgement: 'write' | 'response' | 'model-work'; // what resolves sendAgentMessage
  readonly via: string;                                        // the native mechanism
} & (
  | { readonly mode: 'steer'; readonly humanInputAtTurnEnd: 'never-held' | 'held-when-late' | 'always-held' } // admitted mid-turn
  | { readonly mode: 'boundary'; readonly humanInputAtTurnEnd: 'always-held' }  // refused while busy
);
interface RunnerFacts {                  // core/runner-facts.ts, one row per runner id
  readonly inputDelivery: InputDelivery;
  readonly systemPromptOnResume: 'resent' | 'in-thread';
  readonly nativeAsk: 'answerable' | 'auto-skipped' | 'none';
  readonly nativeSubagents: 'reported' | 'unreported' | 'turn-held';
  readonly nativeTimerTool: string | null;
  readonly costReport: 'cumulative' | 'per-turn';
  readonly sessionIdSource: 'launch' | 'native';
}
```

- **Declared facts, not runner ids** (hearsay-tools/cezarion#2991). Shared code outside
  `packages/cezar/src/core/` reads what a runner declares; it never compares runner ids to
  decide what a runner can do. Identity choices, such as the default `claude` runner, stay. A runner declares its facts in its row of `RUNNER_FACTS`
  (`core/runner-facts.ts`), which holds its `inputDelivery` and `systemPromptOnResume`
  too; the class reads both from the row. The table is keyed
  by runner id because shared code often holds only a `RunnerId` before it builds the runner.
  Each runner class exposes its row as `facts`, and `core/runner-facts.test.ts` checks every
  runner `createRunner` builds against the table. Parity exemptions that follow a fact select
  their runners from the same table (`runnersWhere`), so a row and the code cannot disagree.
  - `inputDelivery.acknowledgement`: `write` when the local pipe write resolves
    `sendAgentMessage` (Claude stdin), so the provider can neither delay nor reject it;
    `response` when a native response does (the Codex RPC result, the OpenCode HTTP
    acknowledgement, the Pi and OMP prompt response id); `model-work` when the first
    model-work frame of the turn the input opens does (Cursor print), so no turn ends before
    its input is acknowledged.
  - `inputDelivery.humanInputAtTurnEnd`: whether a human `sendMessage` written while a turn
    runs can still be held, unread, when that turn ends; turn-end code then keeps the session
    for the turn it opens. `never-held`: always read inside the running turn (OMP, whose turn
    ends only at `session_settled`, and that needs an empty steer queue). `held-when-late`: read
    in the running turn unless it arrives after the turn's last model call, then held into the
    next turn (Claude runs such a stdin line as its next queued turn; Codex starts a turn for a
    steer the turn did not echo or refused at its end; Pi reads a late steer as its next
    prompt). `always-held`: queued until the running turn ends, then it opens the next turn
    (OpenCode posts a human prompt only after the busy turn goes idle; Cursor print). A
    boundary runner has no mid-turn input channel, so the type fixes it to `always-held`. A
    message written after the harness already ended the turn natively is not mid-turn input.
  - `nativeAsk`: `answerable` when the wire reports the harness's own question and Cezar
    routes the answer back (Codex, OpenCode); `auto-skipped` when the harness answers it
    itself before a human can (Cursor print); `none` when the agent asks only through
    `cezar_ask`.
  - `nativeSubagents`: `reported` when the wire reports a backgrounded child's start and end,
    so Cezar waits on it; `unreported` when it sends no child signal; `turn-held` when the
    parent turn stays open until every child returns.
  - `nativeTimerTool`: the native tool that schedules the session's own wake-up (Claude's
    `ScheduleWakeup`), the equivalent of a `cezar_wait` timer; null when none.
  - `costReport`: `cumulative` when each cost report is the session total (Claude
    `total_cost_usd`), which usage accounting turns into deltas; `per-turn` otherwise.
  - `sessionIdSource`: `launch` when the runner opens its session under the id Cezar saves on
    the step before launch (Claude and Pi `--session-id`), so that id resumes at once; `native`
    when the runner mints its own id and reports it in a `session` event (Codex
    `thread/start`, OpenCode `POST /session`, OMP `get_state`, Cursor print `system/init`).
    Until that event the step holds only Cezar's launch id. §7 *Continue: session and step*
    gives the resume rule.

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
  sendAgentMessage(content: ContentBlock[], inputIds?: readonly string[]): false | Promise<void>; // reserve now, harness acceptance later
  respondPermission?(requestId: string, optionId: string): boolean; // explicit offered native approval choice
  discardQueuedMessages(): void;     // drop mid-turn follow-ups; a turn that parks on a question calls this
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

`cez task send` is human input. When `CEZ_TASK_ID` is nonempty, it exits 64 before contacting the cockpit, including with `--resume` or `--notify`. Use `cez message progress <task-id> '<text>' --id <message-UUID> (needs task messaging on)` for agent-to-task messaging.

**Non-human input (owned workers, 2026-09-06; immediate delivery, hearsay-tools/cezarion#505).** `sendAgentMessage`
must never resolve a native question or a `cezar_ask` question. False means the caller
still owns the input and must retry later, NEVER fall back to `sendMessage`. A runner
whose `inputDelivery.mode` is `steer` admits it while a turn runs, through the
harness's native mechanism, so the model reads it at its next model step instead of
after the whole turn; a `boundary` runner refuses it until the turn ends. Routine
input never cancels a running tool. Every runner refuses while a native question is
pending, and before its opening prompt exists (Codex until startup completes, OpenCode
until the opening prompt starts), then emits one readiness hint if it refused. A
`cezar_ask` question is held by the workflow, not the runner: while it is pending the
caller admits only resolved-wait results and conversation wakes at a turn boundary,
and only a human delivery (or a routed parent reply) answers it (hearsay-tools/cezarion#2397).
Human input keeps priority: an outstanding human prompt acknowledgement refuses, then
hints once it lands.

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
| Cursor 2026.10.01 (print) | boundary | refused while busy: a print turn writes its prompt to stdin once, so a running turn has no input channel; input waits for the next exact-resume print process | the turn it opens | none |
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
work, so a done, auto-end, the autonomous nudge and parking wait for it. A restart
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

The delegation CLI (`cez worker` and `cez message`) is agent-facing and has no
compatibility window (hearsay-tools/cezarion#1933). New sessions receive the current
commands in their instructions. This policy does not change human input through
`cez task send` outside a task.

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
An older cockpit shows a peer message as a worker card with its raw outcome.
Versions from before hearsay-tools/cezarion#1990 have these stored-record downgrade effects
(hearsay-tools/cezarion#1993):

| Stored value | Effect in the older reader |
| --- | --- |
| `relationship` on a ledger message | The strict message schema rejects the field, including explicit `family`. The store keeps the run but quarantines its delegation metadata as `role: 'invalid'`, disabling delegation authority and conversation access. |
| Request outcome `deleted` | The older outcome enum rejects it. The store quarantines delegation metadata in the same way. |
| `relationship` on input attribution | The strict attribution schema rejects it. The containing run row is unreadable. |
| `requestHash` and `deadline` on a peer agent input | The strict input schema rejects either field, even without peer attribution. The containing run row is unreadable. These fields already existed on ledger messages; only inputs gain them. |

An absent `relationship` stays readable as family. The SQLite loader skips an
unreadable row and leaves its stored JSON in place; readable sibling rows remain
available. Neither rejection converts peer input into family or human input. Use a
current cezar to read the row. `runs/conversation-downgrade.test.ts` pins the
pre-change schemas through `parseRunRecords` and `decodeRunRow`, including a
readable family record. The peer-wait downgrade is documented with the wait
contract below.

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
worker's question (native or `cezar_ask`) is routed to its parent as a conversation
request carrying the question (`worker-question-routed`), and the parent's `reply`
to it answers the ask through the same seam a human answer uses, recording
`human-input-delivered` with `source: 'parent'`. Progress and follow-ups never
answer it, and human input on the worker is refused. The question has one addressee
(hearsay-tools/cezarion#2410): when the parent is not live or later settles, or the
worker stops, it closes (`human-ask-closed` with `parent-stopped` or
`worker-stopped`); when a live parent cannot take it (no `steer` grant, at
capacity), Cezar answers it with the reason through the same seam
(`source: 'cezar'`). No human answers it. Cezar's own "Worker idle" question is
superseded by any new input, a human message included. Durable queue
insertion is atomic with acceptance, while provider acceptance and the local ACK
checkpoint retain the documented crash ambiguity below.

Already accepted input precedes the closure of an accepted `cezar_done` at a safe boundary,
not explicit Finish, cancellation, destruction or fatal failure. Empty queues
preserve ordinary completion. A completed turn with an outstanding ACK retains its
done intent; acknowledgement rechecks that exact idle
boundary, without requiring a phantom turn. Worker-wake reservation acquires real
capacity immediately, while only positive ACK plus checkpoint retires the durable
wait. A wake turn completed before ACK does not become running again at ACK. A temporary refusal during a late OpenCode HTTP ack
keeps accepted input queued even when the completed turn called `cezar_done`. Rejected
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
- `restrictCrossSessionMessaging?` — optional per-invocation intent, mapped only
  inside adapters; absent preserves ordinary settings. Governed session
  provisioning supplies it on initial steps, Continue and recovery. It turns off
  native tools that reach another session where a runner keeps them separate from
  subagent messaging; native subagents stay. See D1 below for precise controls and
  exemptions; this is not a shell sandbox.
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
| `restrictCrossSessionMessaging` | **dropped** (D1) | D1 | D1 | **dropped** (D1) |
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
  and never touch run state: no turn, park, wake, Needs You, ask or completion path
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

**AskUser (`ask.requested`, open-mercato/cezar#473, open-mercato/cezar#565).** The portable path is
backend-neutral: the agent asks a structured question with the `cezar_ask` tool
(hearsay-tools/cezarion#1234), which every runner in `RUNNER_IDS` reaches over the same
private MCP wire. Cezar validates the card (`askRequestSchema`, modeled on Claude Code's
`AskUserQuestion`: 1–4 questions, 2–4 options each, `header` ≤12 chars), and at the
turn end emits `ask.requested` and parks the run `waiting`. The `CEZ:ASK <json>` line
that once did this is no longer read (hearsay-tools/cezarion#2397); saved transcripts that
carry it stay readable. A mid-turn `sendMessage` that a
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
the runner terminates the turn instead of hanging. A native `AskUserQuestion`
control-protocol bridge for claude (the `control_request can_use_tool` path) is a
possible future enhancement; `cezar_ask` is the portable baseline.

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
| `turn.started` | each stdin user message that opens a turn; after a `result` with no line queued, the first parent `assistant` frame (Claude resumed the parent itself, hearsay-tools/cezarion#1512) | `turn/started` | each prompt POST |
| `turn.completed` + `stopReason` | `result` subtype (`success→end_turn`, `error_max_turns→max_tokens`, `error_during_execution→error`) | `turn/completed→end_turn` (failed status or provider error → `error`), `turn/failed→error`, interrupt→`cancelled` | `session.idle→end_turn` (or `error` if a failure `session.error` preceded) |
| message item | `assistant` `text` blocks (deltas via `--include-partial-messages`) | `agentMessage` items | text parts |
| reasoning item | `thinking` blocks | `reasoning` items (+ `textDelta`) | `reasoning` parts |
| tool item | `tool_use`→running, `tool_result`→completed/failed, `permission_denials`→`declined` | `commandExecution`→execute (+`exitCode`, `outputDelta`), `fileChange`→edit (`diffs`), `mcpToolCall`→other, `webSearch`→fetch, collaboration spawn→task | tool parts (state `pending/running/completed/error→failed`, `patch` parts→`diffs`) |
| `item.delta` `output` (live terminal) | *(none — card fills on completion; per-capability degradation)* | `item/commandExecution/outputDelta` | running-state metadata |
| `plan.updated` | `TodoWrite` input | `todoList` / `plan` items | `todowrite` tool |
| `ask.requested` | portable `cezar_ask` tool | `cezar_ask` + native `item/tool/requestUserInput` | `cezar_ask` + native `question` tool (`GET /question`, `POST /question/:id/reply`) |
| hook item | `system/hook_response` (`--include-hook-events` when `--help` lists it; without it only SessionStart/Setup). Entries parsed from JSON stdout: `additionalContext`→context, `systemMessage`→warning, block `reason`/`stopReason`/deny `permissionDecisionReason`→stop, ask reason→feedback; plain stdout→context. Stdout yields entries on exit 0 only (Claude ignores it otherwise; it stays raw output). Exit 2, `decision:block`, `continue:false`, deny→`blocked` | `hook/completed` (`run.entries` verbatim, `sourcePath`→`source`, `stopped`→`cancelled`) | *(none — plugin hooks run in-process)* |
| subagent nesting (`parentItemId`) | `parent_tool_use_id` | collaboration receiver thread id (review mode remains childless) | child-session parts under a `subtask` |
| background child (`background`, hearsay-tools/cezarion#2431) | `task_started.is_backgrounded` or `async_launched` result → running; `task_notification` → completed / failed / declined | `subAgentActivity(kind: started)` → running; parent-thread `subAgentActivity(kind: completed)` → completed | *(none — the parent settles after its children)* |
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
Print is the only Cursor session transport: hearsay-tools/cezarion#1267 removed ACP
sessions. A build that fails the check fails the step before inference with
`Cursor CLI cannot run this task: <reason>`, followed by the fix: run
`agent update`, or update Cezarion when the build is newer than it supports.
A Continue or recovery of a session recorded on `cursor-acp`, or of an untagged
Cursor session from before print existed, fails with an error that says the
session cannot resume, and no Cursor process starts. Run records keep
`sessionTransport: "cursor-acp"` readable. A step that never received a Cursor
session ID has no conversation to lose, so its Continue opens a new print session.

The print invocation supplies the run's Cezar tools through a private temporary
plugin directory and accepts the user's existing Cursor marketplace plugins.
Governed runs pass no `--allowed-tools` list, so native subagent tools stay
callable (hearsay-tools/cezarion#2279; D1). The capability preflight still reads
the build's native tool catalog before every print session, Continue included,
and keeps a build that lacks a core tool off print. `cezar_ask` questions remain
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

### Cursor model discovery

ACP sessions were removed in hearsay-tools/cezarion#1267, and the earlier ACP runner
(hearsay-tools/cezarion#264) is in git history. One ACP use stays, for discovery only:
`cursor-model-catalog.ts` launches `agent acp`, sends `initialize` with
`_meta.parameterizedModelPicker: true`, and reads the read-only
`cursor/list_available_models` extension. It never sends `session/new`, so no session or
inference starts. The catalog gives the canonical model IDs, parameter keys, values and
defaults that print model admission needs (§ Cursor print); `--list-models` lists only
legacy aliases. Older CLIs without the extension fall back to `--list-models`, without
guessed effort. The discovery child has a finite startup bound and stops when selection
is cancelled.

**Telemetry limitation:** Cursor print emits no token usage: its terminal `result` frame
carries no `usage` or `total_cost_usd`, and print mode suppresses `thinking` events and
child-session transcripts. Cezar reports no invented usage, reasoning or nesting: the UI
matrix rows and harness S4 carry named, inverse-asserted wire-gap exemptions. Other
matrix rows remain required. Revisit these exemptions when Cursor exposes the data.

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
- **Ask** is the portable `cezar_ask` tool: plain `--mode rpc` never builds OMP's native ask tool.
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
- background sub-agent task items (hearsay-tools/cezarion#2431): a child that
  outlives its spawn call keeps its root `task` item `running` with
  `background: true`, and one `item.completed` (`completed`, `failed`, or
  `declined` for a stopped child) reports its end. Claude marks it from
  `system/task_started` (`is_backgrounded`) or the `async_launched` result and
  ends it on `system/task_notification`; Codex 0.164.0 marks the
  `subAgentActivity(kind: started)` row and ends it on the parent-thread
  `subAgentActivity(kind: completed)`, which carries the turn id of the parent
  turn that already completed. A repeated end maps to nothing, and a nested
  spawn stays passive. OpenCode and OMP settle the parent only after its
  children end, and Pi and Cursor report no child end, so they carry the named
  `NO_BACKGROUND_SUBAGENTS` exemption with an inverse assertion

A new backend must produce every row its wire supports. A genuine upstream gap
requires a named, versioned exemption with an inverse assertion; Cursor token
telemetry above is the first UI-matrix exemption. Missing implementation is never
a wire gap.

That covers what a mapper EMITS. The other half of the same requirement — what a
runner DOES — is §7, and a new backend has to satisfy both.

<a id="waits"></a>
<a id="ci-wait-tool-contract-474"></a>

## Waits (hearsay-tools/cezarion#1233, hearsay-tools/cezarion#1234; CI since hearsay-tools/cezarion#474)

A run keeps its waits in one list on its record. The agent opens and closes them with the cezar
tools. Read each fact from its owner:

- `packages/contract/src/waits.ts`, `ci-wait.ts` and `ask-schema.ts`: the stored wait shapes, and
  each tool's request, answer, limits and error codes.
- `WAIT_KINDS` in `packages/cezar/src/workflows/run/wait-kinds.ts`: one typed row for each wait
  kind, with its deadline, slot, wake budget, resolvers, cancel paths and texts. A new kind is a
  new row ([ADR 0061](docs/adr/0061-one-wait-engine-executes-wait-kind-rows.md)).
- `cezarTools` in `packages/cezar/src/ci-wait/tools.ts`: the one list of cezar tools, with the
  descriptions that the agent reads. Every runner's adapter, extension and allow-list read
  it, and `cezarToolEnvNames` lists the environment names a harness forwards. A new tool is
  one entry there. `errors.ts` beside it and `workflows/completion-policy.ts` hold the refusal
  messages.
- The `CI_*` constants in `packages/cezar/src/ci-wait/supervisor.ts` and `github.ts`: the PR
  watcher bounds. `packages/cezar/src/workflows/run/constants.ts`: the wake and delivery bounds.
- `.ai/specs/2026-10-17-unified-waits.md`: the model (the turn-end rule, waking, slots and
  liveness bounds).

A wait result is an observation. It grants no merge, review-acceptance or task-completion
authority.

### Private transport and required harness evidence

- A memory-only session capability binds project, run and generation. The capability, not the
  model, names the calling run. `CEZ_TOOL_TOKEN` and `CEZ_TOOL_SOCKET` exist only in the child
  environment: never write them to a prompt, a record, a descriptor snapshot or a setting.
- This is cooperative same-user authorization, not isolation from an unrestricted shell.
- An explicit tool denial stays a denial.
- Before a runner ships, the parity rows must list and call the tools through its native mock
  wire and the real bundled adapter or extension, on fresh, Continue and recovery paths. An argv
  or configuration snapshot is not transport proof.
- A wire limitation needs owner review and a named exemption. Do not skip the row silently,
  widen a permission, or fall back to a marker or to model polling.
- Record the installed interface and version that you checked in
  `packages/cezar/src/ci-wait/__fixtures__/README.md` or in the runner's fixture README.

## 7. Harness parity — session and lifecycle (`packages/cezar/src/core/harness-parity.test.ts`)

The harness matrix drives each real runner class through its native mock. Every criterion
holds for every runner, or carries a `PARITY_EXEMPTIONS` entry whose reason names the wire
limitation. A row that tests Cezar's shared logic above the seam runs on the derived runner
set instead.

Print every row with its exemptions:

```bash
node packages/cezar/scripts/parity-rows.ts
```

`--row R39` prints one row. `--runner pi` prints only the rows that the runner is exempt
from, not the rows that run on it. `--json` prints the index as JSON.

Owners. Paths are relative to `packages/cezar/src/`.

- **Rows** (`{ id, name, scenario }`): the kit modules that `KITS` in
  `packages/cezar/scripts/parity-rows.ts` names. The largest are the `*_CRITERIA` tables in
  `core/harness-parity-core.testkit.ts`, the row lists in
  `core/harness-parity-rows.testkit.ts` and `WAIT_CRITERIA` in
  `workflows/waits-parity.testkit.ts`.
- **Cells:** `core/harness-parity-cells.testkit.ts`,
  `workflows/waits-parity-cells.testkit.ts` and the testkit of each other family.
  `PARITY_FILES` in `core/parity-classes.testkit.ts` maps every parity test file to its
  family.
- **Exemptions and their kinds:** `PARITY_EXEMPTIONS` and `ExemptionKind` in
  `core/harness-parity-core.testkit.ts`. The wait rows use the same table, except the
  subagent wait rows: `SUBAGENT_EXEMPTIONS` in `workflows/waits-subagents-rows.testkit.ts`.
- **Tiers:** `driveSeam` (`core/harness-parity-core.testkit.ts`) drives a real runner class
  against its own offline mock. `driveRun` (`core/workflow-parity-core.testkit.ts`) drives a
  real `RunManager` run in a temp git repo.
- **Scenario catalog:** `SCENARIOS` and `HARNESS_ADAPTERS` in
  `core/harness-parity-core.testkit.ts`. The steps of each scenario are in
  `packages/cezar/scripts/mock-scenario.mjs`.
- **Row classes and the derived runner set:** `SHARED_RUNNERS` in
  `core/parity-classes.testkit.ts`.
- **Spec-support rows:** `SPEC_FIELD_PROBES` in `core/harness-parity-cells.testkit.ts`.
- **Per-runner files:** `core/harness-<runner>-<part>-parity.test.ts`
  (`harnessParityFile`) and `workflows/waits-<runner>-<part>-parity.test.ts`
  (`WAIT_PARITY_FILES`, `WAIT_PARITY_FAMILIES`).
- **Matrix guards and single-runner cells:** `core/harness-parity.test.ts` and
  `workflows/waits-parity.test.ts`.

[docs/areas/runners.md](docs/areas/runners.md) holds the rules for a parity row, for a
per-runner file and for regression coverage. Rules that no check holds:

- A red cell is a runner bug until proven otherwise. Fix the runner. Do not weaken the row.
- A new mock scenario is wire-faithful, as §8 requires of a fixture.
- A native mock matches `mock:<scenario>` over all the native user text it receives. That text
  includes what Cezar adds: in-thread system instructions, resume context and
  `<cezar-context>` blocks. A change that adds text to an opening message strips that text
  before the mock matches, in `packages/cezar/scripts/mock-session-context.mjs`. The mock
  still records the raw text, because tests assert what Cezar sent.

Autosave process attribution is observation, not OS containment: `autosave-holders.ts` and
`autosave-windows.ts` say what it cannot see.

### Continue: session and step (hearsay-tools/cezarion#2991)

`continuedSessionId` and `resumableSessionId` in `workflows/run/launch-read-resolver.ts` own
which step a Continue continues and which session it resumes.
`workflows/native-session-continue.test.ts` drives every runner through them.

### Governed delegation controls (D1)

The `restrictCrossSessionMessaging` doc comment in `core/agent-runner.ts` says what a governed
session is and what its launch turns off. The same row of each runner's `*_SPEC_SUPPORT` names
that runner's control. The D1 entries in `PARITY_EXEMPTIONS` name, for each runner without a
control, the reason and the version inspected. The Owned workers part of `README.md` states
the limits that a user meets, and § 11 of
`.ai/specs/2026-10-27-task-communication-protocol.md` holds the probe evidence.

A control adds no tool grant and writes no harness configuration file. The controls are
cooperative same-user supervision, not isolation.

### Native cross-session messaging at shipped defaults (D3)

A runner's native cross-session messages bypass Cezar's recorded conversations, so Cezar tasks
talk through `cez message`. The "Messaging other tasks" text of `handoffInstructions`
(`packages/cezar/src/handoff.ts`) tells every session so. The D3 cells and the D3 entries in
`PARITY_EXEMPTIONS` hold each runner's control at shipped defaults; § 11 of the same spec
holds the probe evidence.

Cezar changes no MCP server, plugin or tool setting of the user.

<a id="codex-retrying-stream-errors-550"></a>

### Codex retrying stream errors

`core/codex-startup.test.ts` holds the retry rules, and
`core/__fixtures__/codex/stream-retry.md` records the probe.

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
   `inputDelivery` (§1) from a live probe of mid-turn input, including its
   `acknowledgement` and `humanInputAtTurnEnd`, and pass the §7 I1/I2
   rows or declare their exemption. Add the runner's row to `RUNNER_FACTS`
   (`core/runner-facts.ts`, §1), with its `inputDelivery` and
   `systemPromptOnResume`, and expose it as `facts`; the class reads both from its
   row, and the table's type fails to compile until the row exists. A new value of
   a turn-path fact brings the runner into the derived parity set (§7). Shared code reads these facts, so a new runner never
   needs a runner-id branch outside `packages/cezar/src/core/`.
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
   (`packages/cezar/src/core/harness-parity-core.testkit.ts`): the env var that points it at an
   offline mock, and a prompt for every name in the shared scenario catalog (§7). Then make
   that mock a wire encoder over `scripts/mock-scenario.mjs`: shared scenario
   selection and scripts belong to that module; the encoder emits the backend's
   native frames. Keep acknowledgement, delivery control, failure control and
   steering admission in the mock. Declare genuine wire gaps in `unsupported`.
   The player uses `scripts/mock-lifecycle.mjs` for the no-progress stall and release wait. **Every matrix row must pass** —
   the guard tests fail the suite until each `(criterion, runner)` cell is a live row or a
   declared `PARITY_EXEMPTIONS` entry naming the wire limitation. Never an `it.skip`, and
   never "not implemented yet".
   Choose the ask path explicitly: either map the backend's native question wire to
   `ask.requested`, or rely on the portable `cezar_ask` tool, which every runner reaches through `cezarTools`.
   A native bridge must keep its pending request in that runner's `AgentSession` state and
   route the next human answer through the same state back to the provider. Harness row R3
   pins a valid ask and R4 a malformed native one (a wire with no native ask is exempt from R4,
   because `cezar_ask` refuses bad arguments with `invalid_request`); R6 and R7 pin human-answer routing, queued agent
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
- **`cezar_ask` is the ask in plain `--mode rpc`**, because OMP never registers its native ask
  tool without a UI; do not build a native ask bridge there.
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

Retired with the `CEZ:ASK` line (hearsay-tools/cezarion#2397). The repair once closed a `CEZ:ASK` payload that was missing only its closing braces and brackets, and it persisted a danger note. `cezar_ask` validates its arguments in the tool call, so the repair has no input left. Saved runs keep their recovery and rejection notes.

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

R81–R83 in `workflows/ci-wait-conflict-{fresh,continued,recovered}-parity.test.ts` exercise every
`RUNNER_IDS` native mock through `HARNESS_ADAPTERS`, with a real GitHub client
and supervisor reading explicit `CONFLICTING` metadata from a separate gh wire.
R81 covers a fresh session, R82 a Continue, and R83 restart recovery without an
active session. They read committed rows before wake admission, inject a failed
checkpoint, retain one lifecycle input across duplicate completion, and deliver
one conflict observation over the native prompt channel. R83 also reboots with
a resolved but undelivered result after the external PR becomes clean: the saved
observation must survive without reclassification. No timer or repair authority
is introduced.
A cancelled wait ignores a late result of any outcome: U4 and
`workflows/ci-wait-list-registration.test.ts` pin that, so hearsay-tools/cezarion#2991 retired R84.
