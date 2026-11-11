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

`AgentEvent` in `packages/cezar/src/core/agent-runner.ts` is the v1 stream. Every runner
emits it beside v2: `cezar run` renders it and saved runs hold it. New consumers read v2.
Its `type` strings are additive-only (§ Compatibility).

---

## 3. v2 `UiEvent` — the normalized protocol (`packages/cezar/src/core/ui-events.ts`)

`ui-events.ts` holds the vocabulary and imports no runtime code.
`packages/api-client/src/protocol/ui-events.ts` is a hand-kept copy for the browser;
`packages/cezar/src/server/api-types.test.ts` holds the two equal on the wire.

Where a name is an arbitrary choice (tool status, tool kind, plan entry, diff shape, stop
reason), use the ACP name.

---

## 4. Per-backend mapping (summary)

Each backend's mapper is `packages/cezar/src/core/<backend>-ui-mapper.ts`
(`cursor-print-ui-mapper.ts` for Cursor). Its golden fixtures (§8) are the wire-to-event
table.

<a id="cursor-acp-264"></a>

### Cursor print

`packages/cezar/src/core/__fixtures__/cursor/README.md` holds the limits that a user meets
on Cursor, with their evidence.

<a id="codex-managed-permissions-708"></a>

### Codex managed permissions

`packages/cezar/src/core/codex-permissions.test.ts` holds the rules: when Cezar selects its
own sandbox, and when Codex's managed permissions stay.

### Codex approval routing

`packages/cezar/src/core/codex-approvals.test.ts`, `codex-permission-recovery.test.ts` and
`packages/cezar/src/workflows/permissions.test.ts` hold who can answer a native approval and
what recovery does with one.

#### MCP tool approvals

`packages/cezar/src/core/ci-tools.testkit.ts` holds how Codex treats Cezar's own MCP server.
`.ai/scripts/probe-approvals.ts` checks that routing against the installed Codex in one paid
turn. CI never runs it.

---

## 5. The tool display model (`packages/contract/src/tool-display.ts`)

`toolDisplay(name, input)` computes a tool's kind, title and subtitle. Call it for every
tool title and never build one in a component: the thread, the activity groups and the
notifications must show the same line.

---

## 6. Backend parity — the hard rule (`packages/cezar/src/core/ui-parity.test.ts`)

`ui-parity.test.ts` holds the matrix and its rule: every backend emits every capability, so
the GUI degrades per capability, never per backend. It asserts each capability over each
backend's golden-fixture expected output. A real upstream gap takes a named exemption in
that file, with the version surveyed and an inverse assertion. A missing implementation is
never a wire gap.

§6 covers what a mapper emits. §7 covers what a runner does. A backend satisfies both.

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
`false`. `until: 'merge_or_blocked'` follows an initiated merge: it resolves `blocked`
on a conflict (regardless of `wake_on_conflict`) or when neither queue membership
nor enabled auto-merge remains. Normal waiting for checks or queue admission keeps
it open. A first poll can report no pending merge, including rejection before
registration. `mergeBlock` carries current pending-state flags and, if known, the
latest removal/disable event; its reason is external evidence, not permission to
retry. Current pending state overrides historical rejection. Only `merged` confirms
success. Each target on one PR is a separate wait. `cezar_wait({ kind: 'timer', seconds, note? })` opens a
timer of 60–7,200 seconds with a note of at most 512 characters. Unknown keys, a
field that does not fit its kind, and `kind: "human"` are `invalid_request`; the last one's
message names `cezar_ask`. `cezar_wait({ kind: 'process', pid, exit_file?, timeout_seconds?, note? })`
waits for a background job the agent started to end (hearsay-tools/cezarion#1446). Cezar checks
the exit file, then whether the PID, with its recorded start identity, still runs, every
5 seconds until the deadline (default 1,800, at most 7,200 seconds). It reports `exited with code N`
from the exit file's first line, or `exited, code unknown`, and never signals or stops the
process. A PID that was already gone at registration, with no exit file, is reported as not
running when the wait was registered, so a launcher's PID is not read as a finished command
(hearsay-tools/cezarion#3097). The tool description tells the agent to start the command with
`cez job start <name> -- <command>`, whose supervisor leads its own session: Codex ends a shell
command's process group when the command returns, so a plain `&` job dies there. `exit_file` must resolve inside the task worktree or the task temp directory
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
comes before a settlement, so a peer that wrote and then finished reports what it wrote. A peer whose record the store cannot read is not settled: it may still be live, so the wait stays open. A
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

Native subagents (hearsay-tools/cezarion#2431). A runner mapper marks a native subagent that
outlives its spawn call with `background: true` on its root task item, keeps it `running`, and
ends it with one `item.completed` (`completed`, `failed`, or `declined` for a stopped child).
When a turn ends with such a child still running, and with no done, question or permission
request, Cezar opens its own `subagent` wait (`source: 'cezar'`, `via: 'native-subagents'`) in
place of the monitoring timer, also after `CEZ:MONITORING` or `ScheduleWakeup`, and sends no
nudge. The park (`waiting:subagents`) keeps its session and a monitoring slot and reads
**waiting for N subagents** (`waitingOn: { kind: 'subagents', count }`, bucket `none`, the robot
glyph, webhook state `waiting-workers`); the order is human > usage limit > workers > peers >
subagents > PR > process > timer. Each child event saves the children and moves the 30-minute
deadline. When the last child ends and the runner starts no parent turn within 15 s, the wait
resolves `settled` and wakes the parent once for free; the deadline resolves `timeout` and spends
one wake. A parent `turn.started` the runner sends itself, outside Cezar's own write, closes the
subagent wait (`superseded`) and every open timer; PR, process, worker and peer waits stay. A lost
session or a restart resolves it `interrupted`, and the run continues once for free. Claude and
Codex report their children; Pi, Cursor, OMP and OpenCode keep the monitoring timer. Tests:
`workflows/subagent-waits.test.ts` drives each `waiting:subagents` row, and rows **U30**–**U37** in
`workflows/waits-subagents-parity-cells.testkit.ts` run on every `RUNNER_IDS` native wire, with
the named exemptions there.

An older cezar reads a stored subagent wait as an unreadable entry, as it reads a peer wait: the
store drops that entry, keeps the run and its other waits, and sets `lastWaitsError`. A run parked
only on it reads as a plain park: Needs you. A stored summary whose `waitingOn` is `subagents`
fails the older summary schema, so its run index reads the full record.
`runs/subagent-wait-downgrade.test.ts` pins this read.

`cezar_ask({ context, questions })` waits for the user (hearsay-tools/cezarion#1234). Both are
required. `context` is 1–20,000 characters of Markdown that the cockpit shows above the card.
`questions` is a card in the ask format, 1–4 questions, each with a header of at most 12
characters, the question, and 2–4 options with unique labels. A question with its `options`
left out is open: the cockpit shows only an answer field and sends `header: text`. An empty or
one-option list is `invalid_request`, never an open question, and `multiSelect` applies only
to options. The answer carries the wait id and `open_waits`, with no deadline. Native asks
carry no `context`.

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
lifecycle event `goal achieved — session closed` with `via: 'cezar_done'`, and cancels
every open wait, a human wait from the same turn included. Events recorded before
hearsay-tools/cezarion#2397 may carry `via: 'done-line'` from the retired `CEZ:DONE` line.

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
At a turn end, Claude's `ScheduleWakeup` opens a timer of its `delaySeconds` clamped to
60–3,600, or of `resources.monitoringWakeIntervalMinutes` × 60 seconds when it gave none
(`via: 'schedule-wakeup'`), and a turn that ends with live workers and no other wait opens
the interval timer with `via: 'monitoring-line'` and the note `Opened while workers run.`
An alias opens at most one open timer per run and `via`: a later turn keeps the timer
already open. With re-checks off an alias opens a `monitoring-line` human wait instead, and
with the budget spent a `budget` one (`source: 'cezar'`); either adds a note and the run
reads as Needs you. An autonomous run whose nudge would fire skips the alias. A native ask
(Codex, OpenCode) opens a `native-ask` human wait.

Every agent session gets the cezar tools (hearsay-tools/cezarion#2397). The `CEZ:DONE`,
`CEZ:ASK` and `CEZ:MONITORING` lines are no longer read: a turn that ends on one is a turn
with no wait and gets the no-wait nudge, which names the tools. Stored `ask-line` and
`monitoring-line` entries and `done-line` events from older runs still load. When the
private tool controller cannot start, the launch spawns nothing and fails with
`Cezar tools could not start: <cause>` and the fix: a fresh step and the task fail, a
Continue fails, and a continuation that owes wait results parks with them open and retries
under the wake-delivery backoff. A failed start is not cached, so the next launch after the
repair starts the controller again (U26). `cez worker wait` is an alias too (hearsay-tools/cezarion#1235 phase 3a):
it opens the same `worker` entry as `cezar_wait({ kind: 'worker' })` (or kind `request`), with
`via: 'cez-worker-wait'`, and answers the legacy `WorkerWait` shape; the same workers (or
requests) and mode return the open entry, and `cez worker cancel-wait` cancels through the list
as `cezar_cancel_wait` does. A worker wait sits beside CI, timer and human waits and cancels
none of them. A park whose top wait is workers holds no slot, reads as the workers and
idle-closes after `IDLE_TIMEOUT_MS`; a resolution or a message reopens it through the scheduler
continuation. Messages are not waits: a worker message or reply wakes the run with every wait
still open and in the footer, and beside a pending `cezar_ask` question it is delivered next to the
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
a question or a permission gate parks for the human, an accepted `cezar_done` finishes,
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
resolve, and nothing wakes it. Continue delivers them once; a pending `cezar_ask` question
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

A pending `cezar_ask` question never takes CI data as its answer:
a wake at a boundary is delivered beside it, the card stays answerable, and the
answer keeps its `askSeq`. That wake goes through `sendAgentMessage`, never the answer
transport, and its provider acknowledgement is the
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
`cezar_schedule_task` and `cezar_scheduled_tasks` (hearsay-tools/cezarion#1465) by default;
`CEZ_AUTOMATIONS=0` disables them. The provisioned session environment carries an explicit
`CEZ_AUTOMATIONS=0` or `1` plus the preview opt-in. Claude, Codex and Cursor forward these because they start MCP servers
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
| Cursor | Supply the run's cezar tools through the private temporary plugin directory of each print turn, fresh and resumed; verify invocation and existing permission routing. |
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

A per-runner file chooses its runner with `useRunners(onlyRunner(<id>, ...))` from
`core/runners-under-test.testkit.ts`, and its testkits build managers through
`workflows/fixture-manager.testkit.ts`, `workflows/worker-wait-core.testkit.ts`,
`core/harness-parity-core.testkit.ts` and `core/workflow-parity-core.testkit.ts`, which import
no adapter. Their plain names (`fixture-cleanup`, `worker-wait`, `harness-parity`,
`workflow-parity`) re-export them with every adapter chosen. `core/runner-closure.test.ts` fails when a `harness-<runner>-*` or
`waits-<runner>-*` file reaches another runner's adapter or `runner-factory.ts`. Two
exceptions: the wait kit runs its workers on the Claude wire, so a `waits-<runner>-*` file
also loads the Claude adapter (hearsay-tools/cezarion#2959); and R14 runs a mixed-runner chain,
so a `harness-<runner>-owned-workflows` file also loads the next runner in `RUNNER_IDS`
(hearsay-tools/cezarion#2939).

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
mock models Codex's MCP tool gate, so the Codex U1 row of `workflows/waits-parity`,
`ci-tools` H1 and U0 fail if cezar's own server loses `approve`. Runners whose
wires carry no MCP tool approval request have named exemptions.

**R72/R73** (hearsay-tools/cezarion#994), in `workflows/ci-wait-final-recovery-parity.test.ts`,
drive the shared runner set through its `HARNESS_ADAPTERS` native provider-error
wire (the `provider-error-controlled` scenario, which S44 holds on every runner) with a pending CI wait, on fresh and scheduler-owned continuation attempts.
The failed step retains its error, finish timestamp and `session.ended(error)`;
the run stays `waiting` with its CI wait open until automatic recovery delivers
the observation. Later successful settlement must leave that failed attempt intact.
Clean session closure while CI is pending still parks without failure. No runner
exemptions or normalized-event injection.

**R85** (hearsay-tools/cezarion#1399), in `workflows/ci-wait-rerun-{fresh,recovered}-parity.test.ts`,
drives every `RUNNER_IDS` backend through its `HARNESS_ADAPTERS` native CI tool
call with the real supervisor and a controlled GitHub wire. A partial green check
list stays pending while a rerun is active, then delivers one observation after
the checks return and finish. Recovery covers the same wait without a live session.

**U0–U19** (hearsay-tools/cezarion#1233, hearsay-tools/cezarion#1234, hearsay-tools/cezarion#1260, hearsay-tools/cezarion#1235, with U2c, U2t, U2w, U3w, U5a, U5c, U5d, U6s, U7d, U7h, U7w, U9c, U9h, U9u, U9w, U14m and U16b) pin the
wait list on every `RUNNER_IDS` backend through its `HARNESS_ADAPTERS` native wire, with no
normalized-event injection. U0, in `core/ci-tools-wait-cancel.test.ts` and `core/ci-tools-ask-done.test.ts`, calls `cezar_wait`, `cezar_ask`,
`cezar_cancel_wait` and `cezar_done` through each native wire on fresh and resumed sessions. The rest are `WAIT_CRITERIA` in
`workflows/waits-parity.testkit.ts`, defined in `workflows/waits-parity-cells.testkit.ts` and run from semantic part files in `WAIT_PARITY_FILES`. Cursor mixed rows and Cursor/OpenCode U27 turn-end entry rows use the smaller files in `WAIT_PARITY_FAMILIES`; the original entries files retain the refusal rows. The criteria and exactly-once full-row guards run in `waits-parity.test.ts` (hearsay-tools/cezarion#1288, hearsay-tools/cezarion#1525). U27 settles U5, U6, U11, U20 and U20u from a fresh step, a Continue and an acknowledgement that lands after its turn ended, and checks each settled outcome's word; the late-acknowledgement cells are exempt where no turn can end before its input is acknowledged. U1
registers a CI wait and a timer through `cezar_wait`, parks, and wakes with each result.
A Continue's registration for the same PR returns the open CI wait, a restart recovery keeps
it, and each session gets its own tool descriptor name.
U2 opens both: the timer wakes, the CI wait stays open and is in that turn's footer,
the turn end re-parks without a new registration, and the later CI result is
delivered. U3 delivers a human message during a CI wait, keeps the wait open and
delivers its result in a later turn. U4 cancels with `cezar_cancel_wait`, and nothing
is delivered. U7 lands `cezar_wait` and `ScheduleWakeup`
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
uncharged. U11 opens a `cezar_wait` timer, calls `cezar_done`, which is accepted, and then
starts a worker in the same turn, so the done is blocked at the turn end: the timer keeps its
deadline, the run parks on it with the refusal as a note and no nudge, and the timer's result
is delivered. U12 delivers a timer result beside a pending `cezar_ask` question and holds its
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
opening prompt through each runner's native provider-error wire (on the shared runner set; S44 holds
that failure on every runner), with a resolved timer and no
question: the same bound, a timer that resolves on the failed run stays resolved and wakes
nothing (no queued continuation, admission retry or backoff is left), and Continue delivers both
results once. A second U14 case closes every session cleanly at a turn end while the result is
owed, as U9 closes one at a boundary: the original session, whose turn the timer resolves in, and
two continuations, then the same held state with the clean-close error, and Continue delivers once.
A third U14 case Stops the held run at the bound before any Continue, with the resolved timer and
a still-open one: both are in `lastWaits` as `cancelled`, no wait, backoff, admission retry,
delivery count or queued continuation is left, the run stays `failed` with the discard note, and
a later Continue is a plain continuation that delivers neither. Scenario cases that need one wire live in
`workflows/waits-wake.test.ts`: a CI result beside a pending `cezar_ask` question (U3b,
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
delivery, the charge and the cleared failure count are there together. U7h lands `cezar_ask` (its card holding an open
question) and a native ask in the same list with their `via`, and the user's answer delivers each; Claude, Pi,
Cursor (print) and OMP are exempt from the native case as `this wire has no native ask; its ask
scenario calls cezar_ask` and assert the `cezar_ask` entry instead. A third U7h case runs on
every runner: a Continue that answers one question and asks the next keeps the next one open
and shows its card. U7k pins that `cezar_ask` delivers its `context` whole to the human wait and
the card on every wire (hearsay-tools/cezarion#1458). U9h registers a human wait
mid-turn and fails the provider, and separately registers one at a boundary and closes the
session cleanly: each time the card is shown once with its `askSeq`, the run reads Needs you,
and the answer delivers it. A step's authored `timeoutMs` is the exception: once it has passed,
the step's human waits are cancelled and the run fails, which `workflow-ask-parity` Q8 pins on
every runner. U6 calls `cezar_done` from a parent with a live worker
(`workers_outstanding`), then with that worker settled but not collected
(`workers_uncollected`), and once it is collected with a CI wait open: the run finishes, the
CI wait is cancelled into `lastWaits`, and the closing event carries `via: 'cezar_done'`. U7d
finishes a message turn with `cezar_done` and a summary, which lands as a note just before the
closing event, and then finishes a Continue turn through `cezar_done` again, so both turn-end
handlers are covered. A second U7d case closes the session while a
question is shown, then Continues with a message that answers it and calls `cezar_done`: the
answer in flight is not a pending question, so the done is accepted and the run finishes.

Phase 2b (hearsay-tools/cezarion#1234) adds the turn-end rule. `decideTurnEnd`
(`workflows/turn-end.ts`) is one pure function. Every turn end applies it through one
`TurnSettler` method, `settleTurn` (hearsay-tools/cezarion#1525): the fresh step's and the
Continue's turn-end handlers, the boundary an acknowledgement settles late, and input readiness for
a refused autonomous nudge. Since then it also decides a done the completion gate refused, so both
nudge causes (no wait and completion) have one table test, and the parity cells assert durable
outcomes: notes, runner input, wait rows and slot bounds. They no longer read `settledTurnOutcome`
(hearsay-tools/cezarion#1809 removed the handoff heartbeat line). Input already
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
whose budget is spent keeps the plain park. The native mocks answer the nudge with a `cezar_ask` card
unless `CEZ_MOCK_NUDGE_REPLY=plain`. The unit fixtures set `plain`,
and the cells that need the card opt out. U5 ends a turn with no wait: one nudge, then a second
no-wait turn end opens the `no-wait` wait, which reads Needs you and is answered by the user's
reply, which restarts the budget. U5a answers the nudge with `cezar_ask` and parks on that question
after one extra turn, the default dry-run path. U5c finishes a root parked on Cezar's no-wait wait,
and pins that an agent question still blocks Finish of a root with workers; a root without
workers finishes and closes it (hearsay-tools/cezarion#2784). U5d pins that the no-wait wait raises no
question (its `askSeq` is its note, and no gate fact is pending), and that a timer the agent
registers cancels it into `lastWaits` and parks the run as monitoring. U18 finishes a run parked
on the agent's `cezar_ask` card, with its session open, in a Continue that asked again, and with
it closed: Finish records `human-ask-closed` for that question and no `human-input-delivered`, so
no question stays pending. With a live session, fresh or continued, the later step stays pending.
U17 sends a prose question
with no wait, which gets the nudge, then the same question beside a `cezar_wait` timer, which
parks the run on that timer as monitoring with no gate note. U15 nudges an autonomous run with the autonomous
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
before the crash reads as interrupted execution, so recovery resumes the parent. U19 delivers a worker message beside a pending `cezar_ask` question on every runner:
the message reaches the wire, nothing answers the card, and the human's answer keeps its
`askSeq`. No runner takes U12's exemption here: U19 pins delivery, not a delayed acknowledgement.
Phase 3b (hearsay-tools/cezarion#1301) adds, on every runner: U20 and U20u (a blocked done at the
turn end gets one refusal nudge, with the will-wait sentence for live workers and without it for a
settled, uncollected one, and opens no wait), U20h (a human message, in the opening session or a
continuation, after a refusal nudge the harness never answered starts a fresh cycle: its blocked
done gets a fresh nudge, not the park), U21 (an ignored refusal parks on Cezar's completion
worker wait, which settlement wakes), U21r (that deadline-less wait restarted and settled), U21m (a
worker message wakes the parent beside it), U21t (an agent timer beside it keeps its deadline),
U21h (only uncollected results: Cezar's human wait), U21a (an autonomous parent is nudged again
until the budget), U22 (a done blocked after the session closed reopens it and delivers the
refusal), U22s (a reopened session that acknowledges the refusal and never answers parks at the
nudge's reply bound), U22c (reopened sessions that keep closing first: one copy, the delivery bound,
and Continue delivers it once; a legacy Finish too), U22f (one such close counts a failure, and the
delivery clears it), U22x (Stop retires a refusal a closed session still owes, and a Continue after
it does not deliver it), U24 (a worker's second no-wait turn end asks its parent, whose reply resumes it) and U25
(an automatic message supersedes that question). `cezar_done` itself refuses while a worker is
live or uncollected, so a done reaches the turn end blocked only when the tool accepted it and a
worker started later in the same turn; the cells build the blocked done that way, and their
second step is the nudge's reply, whose `cezar_done` the tool refuses. The harness that never
answers is each native mock's `mock:ack-only` reply (`CEZ_MOCK_COMPLETION_REPLY`): it
acknowledges the refusal on its own wire and opens no turn until more input arrives. Cursor print
is exempt from U20h and U22s (each prompt spawns a process whose init frame is `turn.started`, as
F8), and OpenCode from U20h (a human prompt waits for the busy turn to go idle, and that turn never
does). A done whose input is acknowledged only after its turn ended still gets the refusal nudge
once the acknowledgement lands, never an implicit re-check timer: U27 pins that through its
late-acknowledgement U20 cell, from which Claude and Cursor print are exempt.

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

**R60** (hearsay-tools/cezarion#906), in `workflows/worker-restart-starting-proof-parity.test.ts`,
uses each shared-set backend's `HARNESS_ADAPTERS` native wire (S43 holds the process report on every runner) to persist a
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

**S22–S24** (hearsay-tools/cezarion#843), in `core/runner-shutdown-outside-signal-parity.test.ts` and
`core/runner-shutdown-end-escalation-parity.test.ts`,
start every `RUNNER_IDS` backend through its `HARNESS_ADAPTERS` native mock.
After prompt admission, an outside SIGKILL must fail the session; `end()` must
escalate to SIGKILL when the child cannot handle EOF or SIGTERM; and a failed
output transport must terminate the live child. OpenCode uses its real HTTP/SSE
stream for the transport failure, while the other backends use stdout.
Requested teardown remains successful. The matrix has no wire exemptions.

**S33/S34** (hearsay-tools/cezarion#1899), in the outside-signal file, delay delivery of
an actual native exit callback after an outside SIGKILL on every `RUNNER_IDS`
wire. The exact OS status still fails the session when EOF cleanup runs first.
Pi also pins self-exit 143 with the same scheduling fault. Claude, Codex and Pi
retain bounded live-EOF cleanup and SIGKILL escalation when process evidence is
unreadable in `core/runner-shutdown-eof-evidence-parity.test.ts`. S34 also denies
every process probe. Confirmed exit may suppress a cleanup signal; unknown evidence may not. Automatic cleanup with unknown evidence
fails nonzero/signal exits, including on Windows without a live-state probe.
Positive live evidence permits successful teardown but cannot prove causation
against a later external signal. Explicit end/interrupt before native exit takes
precedence without extending an active cleanup deadline.
`core/runner-shutdown-eof-intent-parity.test.ts` tests intent before EOF, during
the probe and after TERM; `core/runner-shutdown-eof-deadline-parity.test.ts` pins
the earlier KILL deadline. No wire exemptions or synthetic
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

**R43** (hearsay-tools/cezarion#738), in `workflows/worker-reboot-{collect,destroy,reuse}-parity.test.ts` and
`workflows/worker-location-evidence.test.ts`, drives each shared-set
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

**R47** (hearsay-tools/cezarion#839, hearsay-tools/cezarion#889), in `workflows/worker-restart-same-boot-crash-lock-parity.test.ts`,
drives each shared-set backend through its native `HARNESS_ADAPTERS` wire,
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

**R53–R57** (hearsay-tools/cezarion#790), in `core/skill-resume-parity.testkit.ts`, drive every
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

### Continue: session and step (hearsay-tools/cezarion#2991)

A Continue makes two separate choices. **Which step it continues** names the skill, tool
grants, model, effort and worker identity of its turn. **Which session it resumes** decides
whether that turn reopens the step's conversation or opens a fresh one. The first never depends
on the second: the continued step owns the run's latest recorded session from before the
Continue (`continuedSessionId` in `workflows/run/launch-read-resolver.ts`), which is also the step
admission checks the worker identity against and queued revival rebuilds from. A synthetic
`continue-N` that owns a session of its own extends the definition's last agent step, as before.

Cezar saves a launch UUID on every agent step before the runner starts (`step-session.ts`), so
the step rail has an id at once. `resumableSessionId` decides whether the saved id resumes:

| Runner class (`sessionIdSource`) | Saved id | Event history | Session the Continue opens |
| --- | --- | --- | --- |
| `launch`: claude, pi | any | any | Resumes the saved id. The runner opened its session under it. |
| `native`: codex, opencode, omp, untagged cursor | named by a `session` event | present | Resumes the saved id. |
| `native` | not named by a `session` event | present, with the `step-start` of the step that first holds the id | Fresh session. The process ended before the runner reported its id, so the runner never knew the saved one. |
| `native` | any | absent or unreadable (`readEvents` returns `[]`), or without that step's `step-start` | Resumes the saved id. Nothing shows the runner never reported it, so older or salvaged run data keeps its conversation. A wrong id fails loudly: Codex `thread/resume` and OMP `--resume` fail the step, OpenCode answers 404 and opens one fresh session with the lost-session notice, and Cursor refuses an untagged id with `CURSOR_ACP_RESUME_REFUSED`. |
| `native`, recorded transport `cursor-print` | named by a print `session` event of a step, up to the session step, that holds the same id and transport | present | Resumes through print. |
| `native`, recorded transport `cursor-print` | without that event | present or absent | Refused: `Cursor print session identity lacks a matching recorded session event`. Queued revival fails the run with the same error. |
| any | any | any | A runner or account switch opens a fresh session on the new runner, as before. |

A confirmed id with absent history cannot occur: the `session` event is the confirmation. A
workflow step appends its `step-start` event (a synchronous NDJSON write) before the record saves
the launch id, so a crash in that window leaves both in place. A Continue step saves only an id it
resumes or one its runner reported.

The step each Continue runs as, for every row above:

| Chain | Latest recorded session belongs to | Session | Skill, grants, model, effort and worker identity from |
| --- | --- | --- | --- |
| Single step | the step | resumed or fresh | the step |
| Multi-step | step *k* (for example failed mid-chain) | resumed | step *k* |
| Multi-step | step *k* | fresh: native id not reported | step *k* (was the chain's last agent step) |
| Multi-step | step *k* | fresh: runner or account switch | step *k* (was the chain's last agent step) |
| Mixed-runner worker, codex `implement` then claude `review` | `implement` | fresh Codex session: id not reported | `implement`'s pinned identity: Codex account, model and grants (was `review`'s, which failed with `Accepted worker provider identity cannot change`) |
| Mixed-runner worker | `review` | resumed | `review`'s pinned identity |
| Any | a synthetic `continue-N` that owns its own session | resumed or fresh | the chain's last agent step |
| Any | a failed CI source step (`workflowResumeStepId`) | resumed or fresh | the CI source step |
| Legacy record without `workflowDef` | any | resumed or fresh | the defaults |

Only a resumed session reads the account (`profileId`) and transport recorded on its owning step;
a fresh session takes the account the run or the worker's pinned step identity names.

`workflows/native-session-continue.test.ts` drives every `RUNNER_IDS` backend through its native
`HARNESS_ADAPTERS` wire: a Continue after a crash before the `session` event resumes the launch
id on `launch` runners and opens a fresh session on `native` ones, as the continued step; a native
id without event history resumes. `continuation-tools.test.ts`, `cursor-bootstrap-continue.test.ts`
and `delegation/provision-intent-catalog.test.ts` pin the step for multi-step, Cursor and
mixed-runner worker chains.

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

**R92–R96** (hearsay-tools/cezarion#1408), in `core/skill-provision-parity.testkit.ts`, drive every
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

**S35** starts every adapter through the desktop privacy trampoline on macOS and
checks the native turn completes; other platforms assert that the trampoline is bypassed.

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

Workflow deadline rows **T1–T7** (hearsay-tools/cezarion#470) live in
`core/workflow-timeout-parity.testkit.ts` and are registered in the shared parity
guard. Each backend uses its own `HARNESS_ADAPTERS` native wire:
non-final managed steps outlive the default runner deadline, explicit zero disables
it, authored positive limits fail before trailing checks, and standalone sessions
retain their default cap. Longer authored limits override that cap, while default
tasks retain no wall-clock cap. The tests shorten only `DEFAULT_RUN_TIMEOUT_MS`; the
manager, runners, transports and terminal signals remain real. Cezar passes
`step.timeoutMs ?? 0` (`workflows/run/step-session.ts`), so T1, T2, T3, T5 and T6 test
Cezar's deadline logic and run on the shared runner set (hearsay-tools/cezarion#2991). T7 is
their seam row on every runner: through `driveSeam`, a `spec.timeoutMs` of zero and one longer
than the default both outlive the default, and a shorter one ends the turn with a timed-out
error. T4 (the default itself) also runs on every runner.

Intermediate question rows **Q4–Q6 and Q8** (hearsay-tools/cezarion#427) live in
`core/workflow-ask-cells.testkit.ts` and the shared parity guard. Every
`RUNNER_IDS` adapter drives the `cezar-ask` scenario, one `cezar_ask` call over its
native wire. No wire exemption is needed. The rows cover idle close and a second
question on Continue, whose clean close before its answer keeps the question and the
tail, and a later answer runs the trailing check (Q4); disk-round-trip
restart recovery (Q5), cancellation (Q6) and authored timeouts (Q8). Unrun checks
remain pending on stop/failure. hearsay-tools/cezarion#2991 retired Q1, Q3, Q7, Q9
and Q10, which repeated wait rows: U7h, U7k and U7d pin the ask, its answer and the
answering done; U18 pins Finish on a parked question, fresh and after a Continue, with the
later step left pending; U9h pins a clean close with a question open; Q4 pins that close
after a Continue; A3/A4 pin the autonomous refusal.


Open-turn inactivity rows **N1–N8** live in `core/workflow-no-progress-parity.testkit.ts`
and the same parity guard. Every native adapter proves that stalled nonfinal turns
fail without running trailing checks, native progress/heartbeats sustain a long
turn, parked sessions do not time out, followups and Continue rearm protection,
native questions or `cezar_ask` pause until answered (N6),
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
`core/workflow-autonomous-parity.testkit.ts` and the same parity guard (hearsay-tools/cezarion#426).
Every adapter covers fresh and Continue nudges, a refused `cezar_ask` (A3/A4), the
40-nudge cap, non-autonomous parking, a `cezar_wait` timer park with no nudge (A7),
`cezar_done` with no nudge (A8) and persisted-question priority (A10). A9 preserves
native mid-turn questions; Claude, Pi, Cursor and OMP carry executable exemptions,
because they ask through `cezar_ask`. Before the budget an autonomous run registers no
question: `cezar_ask` refuses with `autonomous_run` (hearsay-tools/cezarion#1234). The
refusal answers the tool call and writes no run event, so A3/A4 see no `ask.requested`
and no answer delivery, and the autonomous nudge goes at the turn end. A10 keeps a
persisted unanswered question pending: the run parks with no nudge, and the agent's own
`cezar_ask` is refused. A11/A12 repeat a refused `cezar_ask` until the cap on fresh and
Continue sessions, and the run is written `waiting` once.
OpenCode's cap cell holds each nudge's HTTP ACK until after its SSE turn ends;
deferred idle-boundary settlement applies the same policy after the ACK, including
the cap note and the settled outcome for the state actually entered. A refused ordinary nudge
retains its capacity slot and a readiness outcome until input readiness retries
that exact completed boundary, after durable input. New parent activity, accepted
input or a real question invalidates the retry; cancellation, Finish, disposal and
session replacement revoke it. Missing readiness reaches the existing idle close
bound. Successful retries use normal acknowledged input, so the cap and all
worker/CI/native-question guards still apply. A13/A14 pinned that a refused
autonomous nudge waits for readiness, that the idle bound closes it, and that the slot
stays occupied until process exit. Only the retired ask line reached that path on a
native wire: on OpenCode its nudge went out as human input and left its HTTP ACK
outstanding. A nudge is now agent input, which OpenCode admits at the boundary, so
every runner carries a `scenario-unconstructible` exemption, and the executable cell
checks ordinary root idle expiry and a successful Continue on fresh and Continue
paths. The readiness path stays in production, reached only when a human
acknowledgement races the nudge; no native-wire cell exercises it now.
Owned-worker terminal settlement and explicit question/worker/CI waits retain
their existing policies.

**H1–H5** (hearsay-tools/cezarion#486, H4–H5 hearsay-tools/cezarion#1112) live in `core/workflow-followup-cells.testkit.ts`
and the same parity guard. A human follow-up sent via `manager.sendMessage` while a
turn is running must reach the agent without a resend when that turn calls
`cezar_done` (H1), must be dropped when the same turn parks on `cezar_ask` (H2), and a
done-less hold-style turn must not park or nudge between the follow-up and the next
turn (H3). H3 is a guard that the run does not park or nudge in that
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
  POST, once the running turn ends. (c) `discardQueuedMessages`, or a server start that
  fails. The hold starts at `sendMessage`, before the server is ready. A follow-up sent
  while a question reply is in flight stays held until that reply succeeds, then posts
  like any other.
- **Cursor print**: (a) the `system`/`init` frame of the print process that carries
  the follow-up, which the mapper turns into `turn.started`. (c)
  `discardQueuedMessages`, which drops the queue; for a spawned follow-up it drops
  only the hold, and that process can still run it. The queue shift and the spawn are
  not a release. A follow-up sent between turns is held from `sendMessage` the same way,
  and a held follow-up stays held through a model-admission retry. Before the print qualification check passes, the wrapper holds the
  follow-up itself and hands it to the print runner.
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

`discardQueuedMessagesOnAsk` still runs first, so a `cezar_ask` park drops the waiter on
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
and runs as a fresh turn after the `cezar_ask` park while the card is pending — the inverted
H2 assertion does not pin that.

**Seam contract rows S36–S44** (hearsay-tools/cezarion#2991) live in
`core/seam-contract.testkit.ts` and run from each runner's
`harness-<runner>-contract-parity.test.ts`, on that runner's own native mock. They hold each
runner to its declared facts, never to its id:

- **S36** acknowledgement: `sendAgentMessage` resolves at the declared `acknowledgement`
  point. With the native process stopped, a `write` acknowledgement still resolves and a
  `response` one does not; a `model-work` one resolves only after the turn it opens has
  started. An `observable` runner reports every accepted input read or unread; a read
  follows the acknowledgement on a later native frame. An `unobservable` runner reports
  none. S12 holds steer admission and boundary refusal.
- **S37** turn start: a follow-up turn whose native start is late emits `turn.started`
  before its content, its `turn.completed` and its `turn-end`.
- **S38** held human input: `holdsHumanInput()` reads true as soon as `sendMessage`
  returns, and releases after the `turn.started` of the turn that carries the input and by
  that turn's end. It runs mid-turn, with H5's late acknowledgement, at an idle boundary
  and during startup, each with `mock:deferred-turn-start`.
- **S39** held input at finish: with `autoEndAfterFirstTurn`, a follow-up the turn did not
  read is held at its `turn-end`, and runs in a turn of its own before the session closes.
- **S40/S41** `humanInputAtTurnEnd`: a human message sent before (S40, `steer-tool`) or
  after (S41, `steer-late`) the turn's last model call is read in that turn or held for the
  next, as declared. `CEZ_MOCK_STEER_GATE` keeps the mock's steering window open until the
  message is on its wire, so no timer decides early or late. A boundary runner has no read
  point inside a turn, so it is exempt
  (`scenario-unconstructible`); `runner-facts.test.ts` ties the exemption to the mode.
- **S42** `systemPromptOnResume`: on a fresh and a resumed session, `spec.systemPrompt`
  travels outside the conversation when the runner declares `resent`, and is prepended to
  the opening turn when it declares `in-thread`. Both kinds send it again on a resume; the
  value tells Continue whether the thread already holds the skill (R53/R55).
- **S43** process report: every native process the mock starts (each mock appends its pid to
  `CEZ_MOCK_PID_FILE`) is reported while it runs, the first as `pid` when `startSession`
  returns and each later one through `onPidChange`, over an opening and a follow-up turn. The
  worker process ledger records exactly these pids, so worker-reboot (R43) and worker-restart
  (R47, R60) run on the shared runner set.
- **S44** provider failure: the mock's failure control raises a provider error at a resumed
  session's wake opening (`persistent`) and in a turn that runs until the test releases it
  (`gated-once`). The runner emits a v1 `error` with a message before any v1 `turn-end`, and a v2
  `session.error` or `turn.completed(error)` and never `end_turn`; after Cezar's interrupt (as
  `recordSessionFault` does) the session ends. Rows that raise the same failure through the
  control read Cezar's handling above it: their scenario is `provider-error-controlled`, classed
  shared, and U9, U9h, U9w, U9p, U14, R18 and R72–R76 run on the shared runner set. U14m stays on
  every runner: its Claude cell exits through Claude's own `unread` failure, and no failing
  opening turn may read a steered message, which S44 does not hold. `provider-error` itself stays
  `runner-code`.

A fix to runner lifecycle, input delivery, holds or resume inside a runner class extends
these rows, which run on every runner. Shared code above the seam (`run.ts` reading the
hold, Continue reading `systemPromptOnResume`) stays covered by the run-tier rows H1–H5 and
R53/R55.

No-wait nudge rows **F7–F11** live in
`core/workflow-final-message-cells.testkit.ts` and the same parity guard. They were written for the
final-message nudge (hearsay-tools/cezarion#544), which the no-wait nudge absorbed
(hearsay-tools/cezarion#1234): a silent tail is a turn end with no wait, so it gets the same one
nudge, reply bound and settled outcome. The turn-end decision reads no text and no tail shape
(`classifyTurnEnd`), so hearsay-tools/cezarion#2991 retired F1–F6, which repeated wait rows on
fresh and Continue paths: U5 and U27 pin the one nudge and the no-wait human wait, U7d and U6s
pin that a turn with an accepted `cezar_done` gets no nudge, and U15 and A1/A2 pin the autonomous
wording; `workflows/run/turn-boundary-timer-order.test.ts` pins that a delivered autonomous nudge
arms no idle bound. The silent-tail seam row (`describeSilentTail`) still pins each mapper's
reasoning-or-tool tail. F7 covers the park-after-ACK site: a silent-tail turn that ends while its agent-input ACK is
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
note, and a normal `cezar_done`. A user-authored
delivery resets the one-shot latch so the next silent tail can nudge; expiry does not. The one-shot
latch keeps #48 closed; completion comes only from the `cezar_done` call, never from reasoning. A pending autonomous retry is
never replaced by the no-wait nudge.

> Every criterion in the harness parity matrix MUST hold for **every** backend,
> or carry a declared exemption naming the wire limitation that prevents it. A row
> that tests runner code runs on every backend. A row that tests Cezar's shared
> logic above the seam runs on the derived runner set, which shows every declared
> value of each turn-path fact (hearsay-tools/cezarion#2991).

§6 pins what a mapper emits. This pins the rest of the contract in
`agent-runner.ts`: session lifecycle, provider-failure surfacing, `sendMessage`,
ask routing and park declarations. It exists because nine fixes (hearsay-tools/cezarion#2, hearsay-tools/cezarion#3, hearsay-tools/cezarion#4, hearsay-tools/cezarion#5,
hearsay-tools/cezarion#6, hearsay-tools/cezarion#46, hearsay-tools/cezarion#48, hearsay-tools/cezarion#53, hearsay-tools/cezarion#54) each repaired a failure mode on ONE backend that no
shared contract covered, so the same class of bug shipped again on the next one.

**Regression coverage belongs in the fixing PR.** A fix to runner lifecycle,
input delivery, attention, asks or completion MUST add or extend a parity row in
this matrix, or in an equivalent adapter loop such as
`workflows/worker-parent-attention.testkit.ts`. Do this when fixing the bug; a
separate parity issue is not a prerequisite. Keep a focused backend test when it
helps explain the wire, but it is not the shared regression proof. Where the fix
lives decides where its row runs (hearsay-tools/cezarion#2991):

- A fix inside a runner class extends the seam contract suite
  (`core/seam-contract.testkit.ts`) or that runner's own rows. They run on every
  runner.
- A fix above the seam extends a shared row. It runs on the derived runner set:
  the smallest set of runners that shows every declared value of
  `inputDelivery.mode`, `.consumption`, `.acknowledgement`,
  `.humanInputAtTurnEnd` and `systemPromptOnResume` (`SHARED_RUNNERS` in
  `core/parity-classes.testkit.ts`, ties broken by `RUNNER_IDS` order).
- A new runner declares its facts in `RUNNER_FACTS`. When it adds a value that no
  member of the set has, the set takes it in.

`core/parity-classes.testkit.ts` classes every parity family as `every-runner`,
`shared` or `no-session`. A shared family names the rows that still run on every
runner; a row any runner is exempt from, and a cell whose title has no row id and
whose kit passes no row key to `parityRunners`, run on every runner too. A kit that
passes a key (for example a mode name) runs that cell as a shared row. A `no-session` family runs once, on the set's first runner.
R1 and U1 are smoke rows on every runner. The guards: `core/parity-classes.test.ts`
fails when the set misses a declared value, or a parity file belongs to no
family; `cez/runner-fact-combination` fails when one function in
`packages/cezar/src/workflows/` touches a fact source and reads two different
declared fact keys from any object, because one runner per value cannot show a
combination. It tracks no value, so it over-approximates: a real combination
needs a combination row on every runner, and a same-named key of an unrelated
object needs an exception with its reason (`docs/sdlc/lint.md`).

Drive each real runner through its own native mock frames. Register each new
criterion in the total-coverage guard, and use a named, executable exemption only
when the wire cannot express the case. Prove the new test fails when the relevant
production fix is removed, then restore it and record the passing run in the PR.
An injected normalized event can test the manager in isolation; it cannot prove
that another runner constructs or attributes that event correctly.

**Two tiers.** The seam tier drives each real runner class against that
backend's own offline mock and asserts over the v1 and v2 streams plus the
settled result. It runs on every runner. The run tier drives a real `RunManager`
run in a temp git repo. `workflows/run/` (`human-waits.ts`, `turn-settler.ts`) emits
`ask.requested` for every runner's `cezar_ask` card, while codex and opencode also emit it
from the runner for a native ask (`codex-app-server-runner.ts`, `opencode-server-runner.ts`).
Whether a provider failure fails the run or parks it, and how a wait, an ask or a park
settles, is decided in the orchestrator. A run tier row whose outcome depends on runner code
(a provider error, a native ask on codex and opencode, a native wire recording) runs on every
runner; the rest run on the derived runner set (`core/parity-classes.testkit.ts`).

**Shared scenario names, per-backend spellings.** Every mock is already driven by
`mock:<scenario>` markers found in the prompt text. The matrix names a scenario
once and `HARNESS_ADAPTERS` maps that name onto whatever a backend already calls
it, so no existing marker is renamed. A new runner declares its own map:

| Scenario | The mock must |
| --- | --- |
| `baseline` | one text, one tool call and result, usage, then its terminal turn signal |
| `cezar-done` | the same, calling `cezar_done` before its final text so the run reaches its review gate |
| `hold` | acknowledge the prompt, then a timed pause before the content AND the terminal signal |
| `hold-gated` | like `hold`, but wait for `CEZ_MOCK_RELEASE_FILE` (or a fallback delay) so a mid-turn follow-up can be injected before content |
| `hold-cezar-done` | like `hold`, then call `cezar_done` so a mid-turn follow-up can race the close |
| `hold-cezar-ask` | like `hold`, then call `cezar_ask` so a mid-turn follow-up can race the park |
| `provider-error` | a runtime provider rejection in its own native error shape |
| `provider-error-controlled` | the same prompt as `provider-error`; a row that names it raises the error through `CEZ_MOCK_FAILURE_CONTROL`, as S44 does |
| `cezar-ask` | call `cezar_ask` with one question, then end the turn; the same tool call on every wire, fresh or resumed |
| `cezar-wait` | call `cezar_wait` for a 60 s timer, then end the turn; a declared monitoring park on every wire |
| `ask` | an ask: native where the wire has one (Codex, OpenCode), a `cezar_ask` call otherwise |
| `ask-resume` | ask, accept a human answer, then call `cezar_done` without another human prompt |
| `ask-bad` | a malformed native ask, and then still end the turn; only the wires with a native ask (Codex, OpenCode, Cursor) declare it |
| `ask-reply-late` | the same ask, with OpenCode SSE idle preceding the independent reply HTTP acknowledgement |
| `subagent` | child work and a child terminal signal the parent survives, then parent text after a `cezar_wait` timer, followed by child text before parent turn-end |
| `subagent-after-park` | wait for the manager to park, then emit native child updates without a new parent turn |

The full catalog, with each scenario's contract, is the `SCENARIOS` comment in
`core/harness-parity-core.testkit.ts`.

S9 also pins parent-only v1/result text while child messages remain nested on v2.
R12 asserts the `subagent` turn parks on its open `cezar_wait` timer (`waiting`, label
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

R36–R38 (hearsay-tools/cezarion#399) record the shared monitoring wrap-up contract on every native
prompt channel for fresh, Continue and restart-recovered sessions (R38 parks on a
`cezar-wait` timer before the restart). R39 fires a `cezar_wait` timer and pins that its wake
carries the timer's result and the next-step instruction (`register another wait if you are
still waiting`) on the native message channel, never as a user message. The monitoring wake
nudge now answers only Claude's `ScheduleWakeup` and the live-workers timer. Every runner honors `cezarTools`, so since
hearsay-tools/cezarion#1234 the contract names the tools: finished and verified work calls
`cezar_done`, pending work calls `cezar_wait`, and a question for the user calls
`cezar_ask`. Every session has the tools (hearsay-tools/cezarion#2397), so no marker form of
the contract or the wake remains; `human-waits.test.ts` pins that a marker line is ordinary
text. R40 keeps completion prose without `cezar_done` parked as waiting;
the harness does not infer completion from prose. Offline prompt recordings prove
delivery, not live model compliance.

R26 (hearsay-tools/cezarion#398) runs every `HARNESS_ADAPTERS.askResumeCases` entry for every
`RUNNER_IDS` backend: Claude, Pi, Cursor and OMP `cezar_ask`, Codex
`item/tool/requestUserInput`, and OpenCode `question.asked`.
One human answer must reach completion with no later `waiting` transition and no
second human prompt. R3 proves parking; R6 deliberately returns to done-less
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

**OMP exemptions** (`PARITY_EXEMPTIONS` in `harness-parity-core.testkit.ts`; each names a wire fact,
never "not implemented"):

| Row | Kind | Why |
| --- | --- | --- |
| A9 | capability-absent | v18.4.11 plain `--mode rpc` never constructs the ask tool: `sessionOptions.hasUI` is true only for interactive or `rpc-ui` (`src/main.ts`) and `AskTool.createIf` returns null without it. Asks go through `cezar_ask` (A3/A4). |
| S11, R4 | capability-absent, scenario-unconstructible | No native ask on this wire: `cezar_ask` is the workflow's human wait, so the runner admits non-human input and the run tier holds it (R6), and a malformed `cezar_ask` is refused to the agent as `invalid_request` before any card exists. Claude and Pi carry the same rows; Cursor carries S11. |
| I2 | capability-absent | `session_settled` requires `queuedMessageCount === 0` (`isRpcSessionSettled`, `modes/rpc/rpc-session-settle.ts`) and `agent_end` is rewritten to non-terminal while the agent has queued messages (`session/agent-session.ts`), so a steer accepted before settle is read in the same turn. Source-derived (no live turn). |
| A13, A14 | scenario-unconstructible | Same as every runner: no answer HTTP ACK retained after turn completion; the executable cell checks idle expiry and Continue instead. |
| H2 | capability-absent | Mid-turn human follow-up is steered immediately; `discardQueuedMessages` cannot unwrite it. OpenCode and Cursor queue and drop (H2 live rows). |

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

R20 (hearsay-tools/cezarion#661) completes an owned worker over each native mock wire, then commits a
cleanup checkpoint. The checkpoint reads only that worker's family, and the persisted
execution proof remains complete. R21 covered the retired `CEZ_DELEGATION` off path
(hearsay-tools/cezarion#2784) and is no longer a criterion.

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

R61–R66 (hearsay-tools/cezarion#934, `core/harness-autosave-settlement.testkit.ts`) drive
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

Monitoring turn rows (hearsay-tools/cezarion#772) live in the semantic `workflows/monitoring-turn-*.test.ts` suites
(shared rows: `workflows/monitoring-turn-rows.testkit.ts`)
and `workflows/worker-parent-attention.testkit.ts` and enter the shared parity guard. Every
`RUNNER_IDS` adapter carries multiple parent assistant text segments through its native wire on
fresh and Continue sessions. A turn monitors through a `cezar_wait` timer or live workers, asks
through `cezar_ask` and finishes through `cezar_done` (hearsay-tools/cezarion#2397).
M1 opens a `cezar_wait` timer that survives a same-turn acknowledgement, reads `monitoring`,
then fires the real timer wake. No prose is read (hearsay-tools/cezarion#1234): a later prose
question leaves the timer in place (M2), and a review request in prose leaves a turn with live
workers monitoring on the live-workers timer (M3). A later `cezar_ask` beats the timer (M4). A
later `cezar_done` reaches review, with or without a later acknowledgement (M5, M19). M7 closes
the actual idle session, keeps the unanswered question, then delivers its answer through Continue
and checks that a later monitoring turn carries no stale attention. M18 keeps a `cezar_ask` card
across a routine acknowledgement, idle close and delivered answer. M21 pins that `cezar_done` is
refused with `human_question_pending` while the turn's question is pending, and the question
stays. Ordinary done-less autonomous turns keep their nudge policy (M13/M14). M17 pins that a
clean session close with an accepted worker wait open parks the run on it. The autonomous
`cezar_ask` refusal is pinned once, by A3/A4 (hearsay-tools/cezarion#2991). M26/M27 extend owned-input ACK coverage with live workers;
the existing executable Claude/Cursor pipe-write exemptions keep their native
acceptance-before-response proof. The native rows also assert CLI attention-wait and webhook
projections. Cockpit grouping and notification transitions remain consumers of the same contract
attention rule.

No prose raises a gate: M2, M3 and U17 pin that a prose question beside a `cezar_wait` timer or
live workers leaves monitoring in place, and U17 that one with no wait takes the no-wait nudge.
The gate a human wait without a card raises, which keeps the `unstructured-human-gate` note
code, is pinned by `workflows/human-waits.test.ts`. The rows that read marker lines, quoted
or fenced marker examples, and the order of partial text channels were removed with the
markers (hearsay-tools/cezarion#2397): no lifecycle decision reads assistant text any more.

`worker-parent-attention.testkit.ts` (hearsay-tools/cezarion#249/#401) loops every runner for fresh and
Continue sessions: done-less turns with live workers stay monitoring, and a
`cezar_ask` still wins. Codex/OpenCode/Pi delay transport acknowledgement past turn-end.
Claude/Cursor acknowledge pipe writes, so their named executable exemptions hold
the provider response and prove acceptance precedes it. Its exhaustive ACK table
makes a new runner fail until its transport is classified and exercised.

Owned-input rows S11/S12 pin ask separation and each runner's declared delivery mode:
a `steer` runner admits busy input, a `boundary` runner refuses and retries at its
boundary, and a closed session refuses. Input rows I1/I2 (hearsay-tools/cezarion#505) pin that mid-turn
input is reported read before its turn ends, and that accepted input a finished turn
never read is reported; Cursor is scenario-unconstructible for both, and Claude,
Pi and OMP are capability-absent for I2 because they never leave acknowledged input unread.
Rows I3–I5 (hearsay-tools/cezarion#935), in `core/conversation-answer-delivery-{steering,declared-delivery,pending-question}.test.ts`, Continue a
worker's human answer after a restart closed its session and send a parent message through
`DelegationService.send`. I3: a steer runner reads it before the answer turn ends. I4: delivery
follows the declared mode while the answer is held: steer runners accept it in the turn, and Cursor
receives it only after the turn-end `human-input-delivered` checkpoint. I5: a genuinely unanswered
native question, and a newer one raised by the answer, hold the message until answered; beside a
`cezar_ask` question the message is delivered at once and the card stays answerable
(hearsay-tools/cezarion#1235 phase 3a). It is never the answer. The
answer's checkpoint stays at turn-end in every row. Cursor is scenario-unconstructible for I3. R6–R11 exercise durable queued/startup input, before/during/
after asks, restart with an unanswered ask, continuation asks, delayed native replies,
`cezar_done`/explicit-stop precedence and post-send checkpoint failure. R13 runs a persisted
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

hearsay-tools/cezarion#2279. In a governed session (every session the always-on delegation listener
provisions, hearsay-tools/cezarion#2784), root tasks and owned workers may
use the native subagents their runner supports, subject to the user's tool settings.
The two mechanisms have separate purposes: a native subagent does work that needs no
separate worktree (research, code reading, focused analysis) and needs no Cezar worker,
worktree, collection or destruction; a Cezar worker does work that needs its own
worktree, its own commits or a lifecycle Cezar tracks. Workers may use native subagents
but cannot spawn Cezar workers. An agent may message its own subagents with its runner's
tools; it reaches another Cezar task only through `cez message`, which the provisioned
root and worker instructions say.

D1 inspects real runner argv, JSON-RPC and HTTP boundaries on ordinary versus governed
start/Continue launches. A governed launch carries `restrictCrossSessionMessaging`, and
an adapter adds a control only where the runner's native tool for reaching another
session is separate from subagent messaging. These controls add no tool grants and
write no global harness configuration. `provision-intent-catalog.test.ts` covers every
backend's initial, nonfinal, Continue, recovery and disabled paths.

| Backend (locally verified version) | Per-invocation control | Evidence and limitation |
| --- | --- | --- |
| Claude Code 2.1.312 | None (`honored: false`) | `SendMessage` and `ListAgents` also reach the session's own subagents, background agents and teammates, so no outbound tool is separate from subagent messaging. Inbound messages from other sessions are refused on every launch (`crossSessionInbound: refuse`, D3), so a native send from one Cezar task to another ends as not sent. **Known limitation:** a session Cezar starts can still list and message Claude sessions that Cezar did not start, and sessions on other machines. |
| Codex 0.164.0 | `thread/start` and `thread/resume` `config: { "features.agent_message_board": false }` | The `multi_agent` tools (`spawn_agent`, `send_input`, `wait`) reach only agents of the same session and stay as the user configured them. The cross-thread `agent_message_board` feature is "under development" and off by default; a governed session keeps it off even when the user's config turns it on. `codex -c features.<unknown>=false features list` exits 0, so a renamed key does not fail a launch. Existing sandbox, approval, account and model settings remain unchanged. |
| OpenCode 1.19.4 | `scripts/opencode-task-scope.mjs`, appended to the `plugin` list of `OPENCODE_CONFIG_CONTENT` | The `task` tool starts the session's own subagents, and with `task_id` it resumes any session by ID without a parent check (installed `TaskTool.execute`), which can reach another Cezar task's session. The plugin's `tool.execute.before` hook walks `session.get` parent links and refuses a `task_id` whose session tree differs from the caller's, pointing at `cez message`; a `task_id` that names no session passes (OpenCode starts a fresh subagent), and a failed lookup is refused. OpenCode appends runtime plugins to the ones its config files name, so the user's plugins keep loading. A live 1.19.4 `opencode serve` with throwaway data directories loaded the plugin next to a second plugin; its client's `session.get` returned a child's `parentID`, and 404 for an unknown ID. No session permission rule is sent. **Known limitation:** an OpenCode session that an older Cezar created or resumed under delegation carries a `task` deny, and keeps it on Continue and restart recovery: OpenCode appends permission rules and has no remove. New OpenCode sessions allow subagents. The same-user shell can still reach another session directly (`opencode run --session <id>`). |
| Cursor 2026.10.22-27dcf5f | None (`honored: false`); print sends no `--allowed-tools` | The agent protocol defines `send_message` (to cloud agents); the CLI never sets `sendMessageEnabled` and has no handler. The native agent tools reach the session's own subagents. |
| OMP 18.13.1 | None (`honored: false`) | The default set (`get_state.dumpTools`) holds no cross-session tool. `irc` is an in-process bus (`irc/bus.ts`) that resolves recipients from the process's own agent registry, so it reaches only agents inside the same OMP process. `task`, `wait` and `eval` stay. |
| pi 1.4.0 | None (`honored: false`) | No built-in cross-session tool. An extension may add one, and its name cannot be discovered as messaging. The `subagent` extension stays. |

Each runner without a control carries a named `capability-absent` exemption in the D1
parity cell, pinned the other way round: its governed wire equals the ordinary one,
with no `--disallowedTools`, `--exclude-tools`, `--allowed-tools` or OMP overlay. The
day cezar adds a control for one, its exemption must go.

**Replaced guarantee.** Before hearsay-tools/cezarion#2279, D1 also suppressed native
subagents (Claude `Agent`/`Task`/`Workflow`, Codex multi-agent, OpenCode `task`, pi
`subagent`, Cursor native agent entries, OMP `task`/`wait`/`eval`), and D2 pinned the one
gap in that ban: a Claude skill with `context: fork` started a subagent anyway. The issue
dropped the subagent ban on purpose, and D2 with it. The other half of the old guarantee,
no unrecorded cross-task messages, is held by the controls above, Claude's inbound
refusal and the instructions. Native subagents are not Cezar tasks: Cezar does not own,
collect, wait on or clean them up.

### Native cross-session messaging at shipped defaults (D3)

Spec `.ai/specs/2026-10-27-task-communication-protocol.md` § 11 and
hearsay-tools/cezarion#1994. A runner's native cross-session messages bypass cezar's
recorded conversations: they carry no ledger, cockpit attribution, receipt or deadline,
and no protection for human questions. Cezar tasks talk through `cez message` when the
task's messaging setting is on (hearsay-tools/cezarion#2784). Every session's instructions (`handoffInstructions` in
`packages/cezar/src/handoff.ts`, "Messaging other tasks") say so at shipped defaults
and under D1. The table records each runner's entry points, as inspected on the
installed versions on 2026-10-27.

| Runner (inspected version) | Native cross-session entry points | Ungoverned session (listener unavailable) | Under D1 |
| --- | --- | --- | --- |
| Claude Code 2.1.311 | Outbound: `SendMessage` and `ListAgents`. They reach other local sessions, cloud and Remote Control sessions, and also the session's own subagents, background agents and teammates. Inbound: other sessions' `SendMessage`, governed by the `crossSessionInbound` setting (`accept`, `hold`, `refuse`; unset delivers when the sender's permission-mode class matches). | Inbound refused: every launch passes `--settings {"crossSessionInbound":"refuse"}`. Outbound tools stay callable, because a deny would also stop follow-ups to the session's own subagents and teammates, and break plugin agents and skills that call `SendMessage`. | Inbound refused, as at defaults. Outbound `SendMessage` and `ListAgents` stay callable, as at defaults, because they also reach the session's own subagents (hearsay-tools/cezarion#2279). |
| Codex 0.164.0 | None at defaults. The `multi_agent` tools (`spawn_agent`, `send_input`, `wait`) reach only agents of the same session. The cross-thread `agent_message_board` feature is "under development" and off by default. | No control: cezar sends no flag for an unstable feature key. | `features.agent_message_board` off (D1); multi-agent tools stay. |
| OpenCode 1.19.4 | No messaging tool and no inbound channel. The `task` tool with `task_id` resumes any session by ID without checking its parent. | No control. The `task` permission pattern matches only `subagent_type`, so no session rule blocks a foreign `task_id`, and a deny on `task` removes native subagents. Only the shell finds another session's ID, and the shell reaches that session directly (`opencode run --session <id>`); the same-user shell is outside hard isolation (spec § Out of scope). Blocking `task_id` alone would need a new OpenCode plugin and would not close the shell path. | The task-scope plugin refuses a `task_id` outside the caller's session tree (D1); `task` stays for the session's own subagents. |
| pi 1.4.0 | None built in. An extension may add a messaging tool. | No control: an extension's name cannot be discovered as messaging. | No control (D1 exemption). |
| Cursor 2026.10.22-27dcf5f | The agent protocol defines `send_message` (to cloud agents); the CLI never sets `sendMessageEnabled` and has no handler. | Unreachable; no control needed. | No control (D1 exemption). |
| OMP 18.13.1 | None in the default set (`get_state.dumpTools`: read, bash, edit, eval, glob, grep, find, task, wait, todo, web_search, write). `vibe_*` and `irc` are opt-in in the user's own config. | No control. | No control (D1 exemption); `irc` reaches only agents in the same OMP process. |

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
`restrictCrossSessionMessaging`. Claude's row is live: the argv carries the
`crossSessionInbound: refuse` settings and no `--disallowedTools`. The other runners
carry `capability-absent` exemptions naming the version inspected, pinned the other way
round: their default wire carries no cross-session control. The day cezar adds one,
that exemption must go.

**Compatibility (2026-10-27, deliberate).** The one changed default is Claude's inbound
refusal. Every Claude launch, governed or not, passes the setting, so
the user's other Claude sessions can no longer send `SendMessage` text into a cezar task.
That path was never a cezar surface: the text bypassed the cockpit, the ledger and the
handling of human questions. Human input still reaches a task through the cockpit and
`cez task send` outside a task. Outbound `SendMessage` and `ListAgents` stay callable at
shipped defaults and, since hearsay-tools/cezarion#2279, under D1 too. No runner's MCP servers, plugins or tool
grants change, and the other runners send no new flag. The "Messaging other tasks"
section is prose, not a marker: an older cezar never parses it. The setting is per launch
and writes no file, so a revert restores the old behavior on the next launch, and no state
migrates.

Provisioning supplies the bundled absolute CLI invocation and fresh environment
credentials for both parent and worker sessions; it never copies the parent's
credential to a worker. With the listener unavailable, the intent is absent
and ordinary execution keeps its prior settings. Start/Continue/recovery share the
same provisioner, including nonfinal workflow steps.

The governed command protocol is documented with runnable forms in [README](README.md#owned-workers).
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
Finish refuses unmet readiness. Continue a settled parent before its worker (hearsay-tools/cezarion#2410).

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

`packages/cezar/src/core/__fixtures__/<backend>/` holds pairs: `<name>.ndjson` is the
backend's wire output, and `<name>.expected.json` is the exact `UiEvent[]` that its mapper
must produce. `<backend>-ui-mapper.test.ts` replays each pair the way the runner drives the
mapper. §6 reads the same expected files.

- Take every fixture from the upstream wire: a live capture, or the upstream schema or
  source. Never encode a shape that you assume.
- Cite the upstream source and version in the fixture directory's `README.md`. Label each
  constructed frame as constructed, and say what you could not run live.

## 9. Persistence & transport

Each run has one append-only NDJSON event file that holds v1 and v2 events together
(`docs/areas/runs-store.md`). Never rewrite, reorder or renumber it. The per-run SSE route
replays it, then streams live, under the event names `run-event` (v1) and `ui-event` (v2).
The multiplex route has its own envelope: `packages/cezar/src/server/live-routes.ts` and
`docs/areas/realtime-events.md` hold it. A Cezar-owned event such as
`provider-auth-required` never carries vendor error text or credentials.

---

<a id="10-adding-a-new-runner-the-387-pi-checklist"></a>

## 10. Adding a new runner (the open-mercato/cezar#387 `pi` checklist)

A new backend is one class behind the seam, its mapper, its fixtures and its rows in both
parity matrices. No backend-specific type leaves `packages/cezar/src/core/`.

Add the id to `RUNNER_IDS` (`agent-runner.ts`) first. The compiler and the guard tests
then name most of the missing pieces. The items below are the steps that they do not
force, or force only in part. The item numbers are stable: code cites them.

1. **Runner** — `core/<runner>-runner.ts` implements `AgentRunner` / `AgentSession`.
   Declare `specSupport` and the `RUNNER_FACTS` row from what the wire does, not from a
   similar runner. Probe mid-turn input live for `inputDelivery`. Probe a resumed session
   for `systemPromptOnResume`; when you cannot, declare `resent`. Use
   `prependSystemPrompt` when the backend has no system-prompt channel. For a fork of an
   existing runner's wire, read the fork's own protocol documents for the turn boundary,
   the session id and the tool flags before you copy code.
2. **Factory** — the compiler and the guard tests name each place: the `case` in
   `createRunner`, `runnerSchema` (`packages/contract/src/health.ts`), and `UiBackend` in
   `ui-events.ts` and in its api-client copy (§3).
3. **Detection** — add the runner's probe to `RUNNER_PROBES` (`core/backend-detect.ts`).
   An absent CLI never fails the boot.
4. **Mapper** — `core/<runner>-ui-mapper.ts` emits the v2 stream (§4).
5. **v1 alongside v2** — emit v2 through `SessionOptions.onUiEvent` and keep the v1
   stream.
6. **Golden fixtures** — follow §8, and cover every §6 capability that the wire supports.
7. **Parity** — every §6 row passes or carries a named exemption.
8. **Harness parity** — add the runner to `HARNESS_ADAPTERS`
   (`core/harness-parity-core.testkit.ts`) and make its offline mock a wire encoder over
   `packages/cezar/scripts/mock-scenario.mjs`. That module owns scenario selection and scripts; the mock
   emits the backend's native frames. A wire gap is a `PARITY_EXEMPTIONS` entry; the guard
   tests of the matrix hold what an entry may say.
   Choose the ask path: `cezar_ask` alone, or also a native bridge onto `ask.requested`. A
   native bridge keeps its pending request in the session and routes the next human answer
   back through it. It answers a malformed native request with an error and never leaves
   the turn blocked. Each native ask kind that a human can answer needs an entry in
   `askResumeCases`. Prove the Cezar tools as
   [Waits](#ci-wait-tool-contract-474) requires.
9. **Plumbing** — Settings → Agent config ships with the runner: the doc comment of
   `packages/web/src/routes/settings/agent-descriptors.ts` holds the rules. Add the composer
   presets and the Settings → Agents entry. Keep every change additive, so that old run
   records still parse.
10. **Model selection** — `BACKEND_MODEL_MAP` and `core/model-identity.test.ts` hold the
    rules.
11. **Host model discovery** — ships in the runner's PR. `model-discovery-guard.test.ts`
    forces the contract enum, the adapter module and the catalog registration, or a
    `MODEL_DISCOVERY_EXEMPTIONS` entry with the wire reason. It does not force these
    rules. The adapter calls the CLI's own model-listing surface under the runner's child
    environment, with bounds, and throws when it cannot read the model list. It never
    reads the CLI's config or cache files and never runs a model turn. Add the runner to
    `models-api.test.ts`, which also holds what a failure may report.
12. **Credentials** — the runner's entry in `BACKEND_ALLOW_PREFIXES` (`core/agent-env.ts`)
    lists a prefix for every provider that its model ids can name. Never widen another
    backend's entry.

<a id="11-the-plan-channel-pr-443"></a>

## 11. The plan channel (PR open-mercato/cezar#443)

`plan.updated` is a full replacement (`UiPlanUpdatedEvent`). In a new mapper, find the
backend's real plan channel on its wire: it is not always a todo tool. The mapper tests of
the existing backends hold their channels.

---

## Compatibility

v1 `AgentEvent` `type` strings, v2 `UiEvent` dotted types and the names `run-event` and
`ui-event` (§9) are additive-only: saved runs and shipped clients read them. A
test pins the shipped type strings. To remove or rename one, or to break the parity
requirement (§6, §7), is a breaking change under `BACKWARD_COMPATIBILITY.md`.

## Related documents

- `docs/areas/runners.md` — how a runner change is tested.
- `.ai/specs/2026-09-04-harness-parity-matrix.md` — design record of the harness parity
  matrix (§7).
- `.ai/specs/2026-07-14-cockpit-ui-redesign.md` and
  `.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md` — design record of protocol
  v2.
- `.ai/specs/2026-10-02-omp-runner.md` and
  `packages/cezar/src/core/__fixtures__/omp/README.md` — OMP design record and wire
  evidence.
