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
