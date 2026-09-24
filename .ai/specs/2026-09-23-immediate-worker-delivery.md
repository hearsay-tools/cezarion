# Immediate worker delivery and parent-routed questions — #505

Parent/worker messages waited for the recipient's whole turn to end. In task
`45914a6c-564d-4792-bdad-c84eb09cf8ec` the median parent → worker delay was 31
minutes, the worst 77 minutes. Two requests expired before delivery, and an API
correction arrived after the worker had committed. Worker questions went to the
human, although the parent owns them.

This change submits coordination messages through each harness's native input
mechanism as soon as they are accepted, and routes worker questions to the owning
parent. It ships as two pull requests against #505: **A** (delivery) first, then
**B** (question routing), which closes the issue.

## Where the delay lives

Two gates, not one:

- Every runner's `sendAgentMessage` refuses while a turn runs: `agentInputReady`
  (Codex, Claude, Pi), `turnActive` plus the serialized `prompt` (OpenCode),
  `busy` (Cursor).
- `flushAgentInputs` refuses everything while `openingAgentInputId` is set, so a
  resumed worker's opening turn blocks all later input until it ends.

`deliverMessage` also never flushes after a live human answer, so worker messages
queued behind a human question wait for the answer's whole turn as well.

## Probe evidence

Real-harness probes on 2026-09-23. Each ran one short session: a prompt runs a
40-second foreground tool (`node -e "setTimeout(…, 40000)"`; Claude Code blocks a
leading `sleep`), a message is sent 8 seconds into the tool, and the event timeline
is recorded. Logs are local run evidence and are not copied into the repository.

| Backend | Version | Mid-turn submission | Model sees it | Consumption signal |
| --- | --- | --- | --- | --- |
| Claude | 2.1.280 | stdin `user` line | Same turn, first model call after the tool | `--replay-user-messages` echoes the line **at consumption** (44.0 s, not at the 11.7 s write), carrying the caller's `uuid`; `result.user_message_uuids` lists every input the result covered |
| Codex | 0.155.1 | `turn/steer` | Same turn, after the tool | `item/started` `userMessage` at 43.8 s; its `clientId` echoes `turn/steer.clientUserMessageId` |
| Pi | 0.87.0 | `prompt`, `streamingBehavior: "steer"` | Same turn, after the tool | `queue_update` (pending steering texts) then a user `message_start`; no id field |
| OpenCode V1 | 1.18.32 | `prompt_async` POSTed directly while the session is busy | Same turn, after the tool | The user message is created at the POST (13.8 s); the first assistant message whose `parentID` is that user message is created at 46.1 s, when the tool ends |
| Cursor | 2026.09.18 | A second `session/prompt` | Never: it **cancels the running turn**, cutting off the tool | None usable |

A first OpenCode probe went through the runner's `prompt`, whose client-side `while (this.turnActive)` wait held the message for the next turn. That measured cezar's own gate, not the server; the direct POST above is the server's behavior.

Final-evidence probes on 2026-09-24 (`.ai/scripts/probe-steering.ts`, the shipped path):
Claude, Pi and OpenCode reported the read right after the tool ended, with one turn-end
and the token in the reply. Codex reported its `userMessage` item 0.8 s and 26.7 s after
the steer in two runs, both before the tool ended: with `clientUserMessageId` the item
marks the input entering the thread's history, which the next model call reads, not the
model sampling it. Cursor refused the busy input and accepted it at the turn boundary.

One existing bug surfaced: Claude merges a mid-turn message into the running turn
and emits one `result`, but `pendingPromptTurns` counts two, so `agentInputReady`
stays false after a human follow-up.

## Approved behavior — PR A: delivery

### Runner seam

- `sendAgentMessage(content, inputIds)` still reserves synchronously and returns
  `false` or a Promise. The Promise means the harness **accepted** the input, not
  that the harness was idle and not that the model consumed it.
- A new `SessionOptions.onAgentInputConsumed(inputIds)` fires when the harness
  shows the model received those inputs, at most once per ID. It is never
  inferred from an HTTP, RPC or pipe acknowledgement.
- `turn-end` gains `unconsumedInputIds`: inputs accepted in that turn that the
  model never consumed before the turn ended idle. Where only a quiet window can
  tell (OpenCode), the runner reports them afterwards with the out-of-turn event
  `input-unconsumed`.
- Each runner declares `inputDelivery` beside `specSupport` (which is keyed by
  `AgentRunSpec` fields and cannot carry it), and its sessions expose it:
  `steer` (accepted mid-turn, consumed inside the running turn) or `boundary`
  (refused while busy), plus whether consumption is observable. An absent
  declaration means `boundary`, which is what every runner did before.
  `harness-parity.test.ts` pins each declaration against the runner's behavior.

| Backend | `inputDelivery` | Busy submission | Consumed when |
| --- | --- | --- | --- |
| Claude | `steer`, observable | stdin line with `uuid` = input ID; argv gains `--replay-user-messages`. `pendingPromptTurns` is replaced by tracking `result.user_message_uuids` | The replay echo with that uuid |
| Codex | `steer`, observable (in history) | `turn/steer` with `expectedTurnId` and `clientUserMessageId`. A definitive `expectedTurnId` mismatch (the turn just ended) falls back to `turn/start`. An ambiguous RPC failure or timeout rejects and is never retried by the runner | `item/started` `userMessage` whose `clientId` matches |
| Pi | `steer`, observable | `prompt` with `streamingBehavior: "steer"`, busy or idle. Cezar's `follow-up` kind is never mapped to Pi's `followUp` | A user `message_start` whose text equals the submitted text, oldest pending submission first |
| OpenCode V1 | `steer`, observable | `prompt_async` POSTed at once; the client-side idle waits in both `sendAgentMessage` and `prompt` are removed for agent input | The first assistant `message.updated` whose `parentID` is the user message carrying the submitted text. Steered input still unanswered 2 s after idle is reported as `input-unconsumed` (the upstream lost-wake case); a later server run that answers it opens its own turn |
| Cursor | `boundary` | Refused while busy, as today | The turn it opens |

OpenCode V2's durable admission and explicit `delivery: "steer"` need an API and
event migration and are not installed locally. V1 already steers, so V2 is a
follow-up issue, not part of #505.

### Orchestrator (`workflows/run.ts`)

- **Gates.** `openingAgentInputId` no longer blocks `flushAgentInputs`; later
  inputs can steer the opening turn of a fresh task or a continuation. The opening
  input records `deliveredAt` when its prompt is accepted. The replay-prompt
  retirement (`continuationMessage`) stays at the first successful turn end, as a
  separate checkpoint. Neither timestamp is falsified.
- **Submission.** `submitAgentInput` passes the batch IDs to the runner.
  Unchanged: one flight reservation, FIFO batches bounded to 32 inputs and 100,000
  formatted characters, a single message is never split, lifecycle inputs remain
  barriers, CI wakes own their turn, current-session acknowledgement authority.
  A `boundary` runner keeps flushing on `onAgentInputReady`.
- **Receipts.** `agentInputSchema` gains optional `consumedAt`; old files parse.
  Harness acceptance writes `deliveredAt`; `onAgentInputConsumed` writes
  `consumedAt` atomically for the batch, only while the session is still current.
  Deadlines are never extended. Conversation receipts, the thread and the CLI show
  queued, delivered and consumed (when observable) separately; a reply stays its
  own request outcome.
- **Accepted but never consumed.** A `turn-end` carrying `unconsumedInputIds`
  clears those inputs' `deliveredAt` — the turn is over, so non-consumption is
  definitive — and flushes them as the next turn. DONE, auto-end, monitoring park
  and worker-wait park treat them as queued work through `hasQueuedAgentInputs`,
  so the idle event of the original turn cannot finish unconsumed work. Both
  turn-end handlers (`runAgentStep`, `runContinuation`) share one helper for this.
  Input that opened a turn counts as read when that turn completes; a turn that
  fails reports it unconsumed. A session that closes with unread input returns it
  to the queue.
- **Liveness bound.** Unread input cannot hold a run forever: when a turn ends with
  input still unread and the harness produces no content for 30 s, cezar
  resubmits it once; after a second quiet window it stays delivered but
  unconfirmed, and the run settles its idle boundary normally.
- **Crash recovery.** Acceptance on an observable session writes `awaitingRead`,
  cleared when the input is read. On restart, input still `awaitingRead` is
  replayed. Its text keeps the input ID, so a repeat is recognizable: the
  guarantee is at-least-once, not exactly-once. Records written before #505 never
  carry the marker, so nothing historical replays; unobservable backends keep
  today's semantics, where acceptance means delivered.
- **Human answers first.** No agent input is submitted while a human question is
  pending, so worker messages never answer it. Right after a live human answer is
  accepted, `deliverMessage` flushes pending conversation input:
  - an answer that starts a new turn (a `CEZ:ASK` answer, an idle session) carries
    the pending messages in the same submission, after the answer;
  - an answer through a native reply (Codex `requestUserInput`, an OpenCode
    question, Pi, Claude) continues the turn, and the messages steer immediately
    behind it; the model may make one call on the answer alone first;
  - on a `boundary` backend (Cursor) the messages arrive on the turn after the
    answer's turn.
- **Unchanged.** Finish and cancellation precedence, scheduler admission,
  identity-based retries, accepted grants, the cooperative `worker inbox` as a
  supplemental read, and no tool interruption for routine messages.

## Approved behavior — PR B: questions go to the parent

- **Raising.** A worker's native ask (`ask.requested`) or trailing `CEZ:ASK` parks
  the worker as today: `waiting`, slot released, other input held. Cezar records a
  worker → parent conversation `request` carrying the structured question — a new
  optional `question` (`AskRequest`) on `conversationMessageSchema` in
  `packages/contract`. The worker then records a `worker-question-routed` event
  (`askSeq`, `messageId`, `parentRunId`); the message ID derives from the worker
  and the ask seq, so routing again after a restart finds the same message. A
  question has no deadline. A question the parent cannot take (parent not live,
  no `steer` grant, inbox or conversation at capacity) records
  `worker-question-fallback` instead and stays with the human.
- **Reaching the parent.** The request travels the ordinary conversation queue, so
  it steers an active parent immediately and wakes a parked parent through the
  existing message wake. Its formatted text shows the questions and options and the
  exact command: `worker reply <worker> '<answer>' --id <uuid> --request-id
  <question-id>`. While the parent has its own human question pending, the
  worker's question is held like any worker message and flushes right behind the
  human answer.
- **Answering.** Only a `reply` whose `requestId` matches the pending question
  answers it; a reply to a settled question is refused. The answer enters the
  worker's answer seam — `sendMessage` on a live session, or a continuation that
  answers that ask after a restart (the `openingAnswerAskSeq` path) — and records
  `human-input-delivered` with `source: 'parent'`. The request outcome becomes
  `replied`. Progress, follow-ups and other requests to the worker stay queued and
  flush right behind the answer; none of them answers the question.
- **Escalation.** The parent asks the human with its own `CEZ:ASK` or native ask,
  then replies to the worker. An unanswered worker question counts as parent
  completion attention, so the parent cannot reach DONE past it; the completion
  note names the question, and no automatic wait on that worker is registered
  (the two would wait on each other).
- **Human fallback.** The worker's question card reads "Routed to parent" with no
  answer box; a human message or Continue on the worker is refused with a note
  pointing at the parent. When the parent cannot receive the question at ask time,
  or later settles `done`, `review`, `failed` or `cancelled` (including a parent
  found closed on recovery), the worker records `worker-question-fallback` with
  reason `parent-<status>`, the question becomes an ordinary human ask with an
  answerable card, and its request outcome is a new `human-fallback` status.
  History deletion destroys the workers with it, so it needs no fallback.
- **Instructions.** `delegation/provision.ts` tells workers that questions go to
  their parent, and tells parents that worker questions arrive as requests, are
  answered with `reply`, and escalate through the parent's own question. The
  "next safe turn boundary" wording is replaced.

## Verification mapping

Every new regression is proven red against the old gates before the fix lands.

- `harness-parity.test.ts`: an `inputDelivery` row per runner — busy submission,
  consumption ID matching, `unconsumedInputIds` at an idle turn end, definitive
  and ambiguous acknowledgement failures. Cursor's `boundary` is a declared
  exemption, never a skip.
- Runner tests: Claude argv and uuid matching, one `result` covering several
  inputs, the `pendingPromptTurns` fix; Codex `clientUserMessageId` and the
  `expectedTurnId` fallback; Pi busy steer and text matching; OpenCode busy
  admission through both guards, `parentID` consumption and the lost wake.
- `run.ts` integration with fake runners, both directions: a long tool-using first
  turn, a resumed opening turn with later messages, burst ordering and batch spill,
  busy-to-idle races, unconsumed-at-turn-end resubmission holding DONE, auto-end
  and park, crash replay of delivered-but-unconsumed input, a human answer bundled
  with pending messages, scheduler capacity, finish/cancel precedence, rejected and
  ambiguous acknowledgements.
- PR B: native and `CEZ:ASK` questions reach the parent on every applicable runner;
  a correlated reply unblocks the worker live and after restart; progress never
  answers; the parent's human question holds the worker's question; escalation;
  fallback on a stopped or finished parent; the DONE block; parked-parent wake
  within scheduler limits.
- Existing ordinary completion, human input and cancellation suites stay green
  unchanged.
- Real harness: `.ai/scripts/probe-steering.ts`, manual and never in CI
  because it spends paid sessions, runs once per backend against each finished PR
  (slow tool plus mid-turn message for A; worker question plus parent reply for
  B). Its timelines go in the PR body.
- `AGENT_PROTOCOL.md` records the `inputDelivery` contract, each backend's
  consumption signal, and the limitations above.

## Out of scope

Interrupting running tools for coordination messages; conversation-card and
transcript presentation (#484, #485); human follow-up repair (#486); OpenCode V2;
wider worker permissions or workers answering the root parent's human questions.
