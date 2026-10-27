# Task communication protocol — hearsay-tools/cezarion#1933

Status: the owner approved the design decisions on 2026-10-27, at the design gate of
hearsay-tools/cezarion#1933, and approved this spec in review the same day. It changes no
code. Implementation is tracked in hearsay-tools/cezarion#1989 to hearsay-tools/cezarion#1996:
see [Follow-ups](#14-follow-ups).

## Why

A Codex coordinator task used `cez task send` to contact another task. `cez task send` is
human input. Cezar delivered the coordinator's text as a human message, and that message
retired an unanswered human question. Claude coordinators had used a runner-native
messaging tool, so the same workflow did not show the problem on Claude. Tasks need one
communication protocol that works on every runner and keeps who sent each message.

The incident, on 2026-10-26 (UTC), in one project:

| Time | Task | Event |
| --- | --- | --- |
| 22:11:45.615 | Recipient `04a258b0` | `ask.requested` with two human questions ("Ignored file", "Show paths") |
| 22:12:03.976 | Sender `474cc4f5` (Codex) | Shell call `cez task send 04a258b0-… '<coordination message>'` |
| 22:12:04.376 | Recipient | `user-message`: "Coordinator 474cc4f5 continues 017 wave 2 …", about version reservations and file ownership, not about either question |
| 22:12:04.427 | Recipient | `human-input-delivered` with `askSeq: 50545`: the human question was retired in durable state |

The evidence is host-local run history. It is not a repository fixture.
[R1](#13-regression-scenarios) rebuilds the sequence as a self-contained test.

The governed parent–worker channel was not involved. It already keeps human questions
open when an agent message arrives (`deliverMessage`, `packages/cezar/src/workflows/run.ts:6465`:
only `userAuthored` input reaches `applyHumanMessageDelivery`). The failure was that two
independent tasks had no governed channel, so an agent used the human one.

## Decisions

The owner took these at the design gate.

| Question | Decision |
| --- | --- |
| Mechanism | Reuse the parent–worker conversation protocol. Abstract only the step that decides who may talk to whom. |
| Ledger for a peer message | A new request or progress message lives in its sender's family ledger. A follow-up or reply lives with the request it names. |
| `cez task send` run by an agent inside a task | Refused, exit 64. `cez task send` stays human input. |
| Consent | Any root task may message any other root task in the same project. No opt-in, no setting. |
| CLI | A new family, `cez message`. `cez worker` keeps only the lifecycle verbs. |
| Compatibility | The `cez worker` message verbs are removed, with no aliases. The delegation CLI is an agent-facing surface inside the cockpit, not a user-facing one; agents get the new instructions. |
| Waiting for a peer | A new wait kind, `peer`. It always names its peers. A message from a named peer, or that peer settling, closes it. A human message or a family message does not. |
| Waiting for a reply | Agents register the wait themselves (`cez message wait --request`, or `cezar_wait` kind `request`). Cezar opens no implicit wait at a turn end. |
| Done with open requests | Open requests a root task sent block its completion, the way live workers do today. |
| Done with unanswered incoming requests | A root task's first done is refused once, as a nudge. The second done passes, and the requests settle `completed-without-reply`. |
| A peer recipient at `review` | Its open requests settle `completed-without-reply` at once, because no peer can resume it. |

## Terms

- **Task**: a run.
- **Root task**: a run that is not an owned worker. With `CEZ_DELEGATION=1` its record
  carries `delegation.role: 'root'` (`packages/cezar/src/delegation/provision.ts:46`).
- **Family**: a root task and its owned workers.
- **Peer**: another root task in the same project. This replaces the meaning
  hearsay-tools/cezarion#114 gave the word (lateral workers inside one family); that issue
  was closed as not planned.
- **Ledger**: a family's durable conversation state, `root.delegation.conversation`
  (`conversationStateSchema`, `packages/contract/src/conversations.ts`).
- **Human input**: text a person, or an outside operator program, gives a task. It is the
  only input that answers a human question.

## 1. Three channels

| Channel | Sender | Recipient | Sender identity | Can answer a human question | Path |
| --- | --- | --- | --- | --- | --- |
| Human input | A person in the cockpit, or a person or outside bot running `cez task` outside any task | Any task in the project | None recorded; the cockpit treats it as the user | Yes | Cockpit composer; `cez task send`; `POST /api/v1/p/:projectId/runs/:id/messages` |
| Family conversation | A root task or its owned worker | The other end of that pair | The session credential | Only the parent's reply to its own worker's routed question | `cez message …` over `/api/v1/delegation/*` |
| Peer conversation (new) | A root task | A peer | The session credential | Never | `cez message …` over `/api/v1/delegation/*` |

Outside the protocol:

- **Runner-native messaging**, such as Claude's cross-session `SendMessage`. It is
  untracked, like native workers. See [§ 11](#11-runner-native-messaging-and-other-channels).
- **Webhooks** (`cez task notify`). A webhook delivers events to an outside program. That
  program answers through human input.
- **The same-user shell.** An agent can reach the cockpit's HTTP API with `curl`. Cezar
  does not claim hard isolation from it. The guard in [§ 6](#6-human-questions-and-human-input)
  protects the supported CLI path.

## 2. Reuse and the one abstraction

The parent–worker protocol ([parent and worker conversations](2026-09-08-parent-worker-conversations.md),
[worker message delivery](2026-09-22-worker-message-delivery.md),
[immediate worker delivery](2026-09-23-immediate-worker-delivery.md)) already has every part
the issue asks for:

- an authenticated sender, from the session credential, never from a request field;
- message kinds `request`, `progress`, `follow-up` and `reply`, with caller-chosen message IDs
  and payload-hash deduplication;
- receipts that keep acceptance (`queued`), provider delivery (`delivered`), model read
  (`consumed`) and request settlement apart;
- request deadlines, cancellation, request waits, late replies (`replied-late`);
- one atomic write for the message, its obligation and the recipient's queued input
  (`RunStore.commitConversation`);
- caps: 100,000 characters per message, 32 undelivered inputs per recipient, 1,024 ledger
  messages, 32 open requests;
- delivery through `sendAgentInput` at safe boundaries, batching, inbox reads, restart
  reconciliation and `conversation-message` / `request-outcome` projections;
- the rule that agent input never answers a human question.

Peer conversations keep all of it. They change one step: deciding whether two runs may
talk, and which ledger holds the message.

### The relationship resolver

`conversationPair` (`packages/cezar/src/delegation/service.ts:298`) admits only a root and
its direct owned worker. It becomes a **relationship resolver**. It returns
`{ relationship, sender, recipient, ledgerRootId }`, where `relationship` is `family` or
`peer`.

| Pair | Relationship | Admitted when |
| --- | --- | --- |
| Root ↔ its owned worker | `family` | Today's checks, unchanged: the worker's `parentRunId` and workspace owner match, a receipt exists and is not deleted, no history deletion is pending |
| Root ↔ root | `peer` | Both are root tasks in the caller's project, the two IDs differ, and neither family has a history deletion pending |
| Anything else | — | Refused with `denied_scope`, with the same text for absent, unrelated, wrong-project and malformed records, as `denyScope` does today |

The resolver checks history deletion after the relationship, and both failures return
`denied_scope`, as `conversationPair` does today (`service.ts:306`).

The resolver has two levels:

- **New sends** (`request`, `progress`, `follow-up`, `reply`) need the live pair from the
  table above.
- **Operations on the caller's own durable records** need only the caller's participation,
  for a `peer` pair:
  - history: messages in an existing ledger where the caller is the sender or the recipient;
  - wait and cancel: a request the caller sent, held in its own family ledger;
  - inbox reserve: inputs addressed to the caller that it can claim, in the caller's
    authenticated session generation. Reserve creates the receipt;
  - inbox acknowledge and release: the same, plus the live receipt that reserve returned.

  A deleted peer, or one whose family has a history deletion pending, does not block these.
  Inbox acknowledge and release check each member against the caller's own record, so a
  sender deleted between reserve and acknowledge does not refuse the batch. Family pairs
  keep today's checks for both levels.

A top-level task with no delegation record yet counts as a root task. This covers a task
that has not started a session under `CEZ_DELEGATION=1`. The first accepted message writes
its root record, as provisioning does. The record grants the recipient nothing it would not
get at its first session.

### Which ledger holds a message

| Message | Ledger |
| --- | --- |
| A new `request` or `progress` | The sender's family ledger: the sender itself when it is a root, its parent when it is a worker |
| A `follow-up` or `reply` | The ledger that holds the request it names |

For a family pair, both rules name the same ledger, so family behavior does not change. For
a peer pair, a request and its reply stay together in the requester's ledger. That is where
the requester waits on the outcome. A two-way peer exchange can therefore use two ledgers.
`cez message conversation <peer>` reads both and merges them in `(createdAt, id)` order.

Two full ledgers can hold 2,048 messages for one pair, while the history response keeps its
bound of 1,024 messages and 1,024 outcomes (`conversationStateSchema`,
`packages/contract/src/conversations.ts`). The merged response therefore returns the newest
1,024 messages and the outcomes of the requests among them. Two messages can share a
`createdAt` millisecond, so the order is `(createdAt, id)`, a total order, and the cursor
carries both. When older messages exist, the response adds `nextBefore`, an opaque cursor for
the oldest message returned. `cez message conversation <peer> --before <cursor>` returns the
messages strictly before it in that order, so no message is skipped or repeated at a page
boundary. Both fields are new and optional in the contract.

### Message identity

Today a message ID is unique inside one ledger only: `send` looks up the ID in that ledger
(`service.ts:337`). The recipient's queued input, its delivery and read checkpoints, inbox
receipts and the `conversation-message:<id>:<step>` projections all use the message ID with
no ledger in it. Within one family that is safe, because one family has one ledger. With
peers it is not: two peers can each pick the same UUID for a message to one recipient, and
both messages are valid in their own ledgers.

So a new message ID must be unused at every place it reaches:

- a message in the ledger that will hold it, unless it is an exact retry (same ID, same
  payload hash), which returns the existing receipt as today;
- an input of the recipient;
- a projection on the sender's or the recipient's run (`RunStore.hasProjection`, an indexed
  read).

The check runs inside the same `commitConversation` write that stores the message and the
input. The store writes synchronously, so two senders on two ledgers cannot both pass it for
one recipient. A refused send returns `invalid_input`, "Message ID already in use; use a new
message ID", and writes nothing. IDs stay caller-chosen UUIDs, so a refusal means a reused ID,
never a random clash.

`AgentInput.parentRunId` keeps its name and holds the ledger owner. Inbox, acknowledge,
release, cancel and wait find the ledger through that field or through the request ID. They
never trust it alone: the resolver checks the pair again on every call.

### Rules that stay family-only

- `--resume` of a settled run. It is control, not messaging (`cez worker resume`, [§ 10](#10-cli-and-api-paths)).
- Routed questions: a worker's question goes to its parent (hearsay-tools/cezarion#505). A
  root task's question never goes to a peer.
- The `destroyed` and `human-fallback` request outcomes, park notices
  (hearsay-tools/cezarion#1327) and worker fallback questions (hearsay-tools/cezarion#1301).

## 3. Endpoint matrix

**Discover** means the caller can list the recipient. **Message** means it can send a new
request or progress message. **Reply** means it can reply to the recipient's request.
**Answer** means it can answer the recipient's human question. **Control** means steer, stop,
resume, inspect, collect, diff or destroy.

### At shipped defaults (`CEZ_DELEGATION` unset)

| Sender → recipient | Discover | Message | Reply | Answer | Control |
| --- | --- | --- | --- | --- | --- |
| Person in the cockpit → any task in the project | Task list | Human input | — | Yes | Cockpit controls |
| Person or outside bot, `cez task` outside any task → any task in the project | `cez task list` | Human input | — | Yes | `cez task stop`, `finish`, `send --resume`, … |
| Agent in any task → any task | No agent path | No: `cez task send` exits 64 ([F1](#14-follow-ups)); there is no agent channel | No | No | Outside this protocol (see below) |

With delegation off, agents have no supported channel to another task. Enabling
`CEZ_DELEGATION=1` is the remedy, and the exit-64 message says so. The other `cez task`
commands are operator commands. An agent that runs them acts with the operator's authority
through the shell. This spec does not change them. A guard for them would be a separate
decision.

### With `CEZ_DELEGATION=1`

| Sender → recipient | Discover | Message | Reply | Answer | Control |
| --- | --- | --- | --- | --- | --- |
| Root → its owned worker | `cez worker list` | Yes | Yes | Its worker's routed question only, through `reply` | `cez worker` lifecycle verbs |
| Worker → its parent | The parent ID is in its instructions | Yes | Yes | No | None |
| Root → peer | `cez message tasks` | Yes (new) | Yes (new) | No | None |
| Root → a worker of another family | Not listed | `denied_scope` | `denied_scope` | No | None |
| Worker → peer, or another family's run | Not listed | `denied_scope` | `denied_scope` | No | None |
| Any agent → a task in another project | Not listed | `denied_scope` | `denied_scope` | No | None |
| Any agent → itself | — | `denied_scope` | — | — | — |

Permission to message never grants control. The resolver's result carries no grant that
`authorizeWorker` (`packages/cezar/src/delegation/policy.ts`) reads.

## 4. Message schema

Every field already exists unless the table says **new**.

| Field | Meaning | Source |
| --- | --- | --- |
| `id` | Message ID, chosen by the sender. The request ID of a request | Caller; a retry reuses it with the same payload |
| `senderRunId` | Who sent it | The session credential, never the request body |
| `recipientRunId` | Who receives it | Request body, checked by the resolver |
| `relationship` (**new**, optional) | `family` or `peer` | The resolver. Absent on old records, which read as `family` |
| `kind` | `request` (creates one reply obligation), `progress`, `follow-up`, `reply` | Request body |
| `requestId` | The request a `follow-up` or `reply` names | Request body; required for those two kinds only |
| `text` | At most 100,000 characters, secrets redacted before storage | Request body |
| `createdAt`, `deadline` | Acceptance time; a request's deadline (1–1,800 s, default 600; up to 86,400 s for a worker resume) | Cezar |
| `requestHash` | SHA-256 of sender and payload, for retry deduplication | Cezar |
| `state` | `accepted`, `continuation-required`, `destroyed`, `late` | Cezar |
| `instruction` | Why a message was not delivered, and the next command | Cezar |
| `resumed`, `question` | Family-only: a resume, a routed worker question | Cezar |

The send result adds `delivery`: `queued`, `delivered`, `consumed` or `not-delivered`. It adds
`outcome` once the request settles. Request outcomes are `replied`, `replied-late`,
`completed-without-reply`, `failed`, `cancelled`, `destroyed`, `timed-out`, `sender-closed`,
`human-fallback`, and **new** `deleted`: a peer recipient's record was deleted while the
request was open. `destroyed` keeps its meaning: an owned worker and its resources were
destroyed.

Human input has no conversation record. It is a `user-message` event. When it answers a
question, a `human-input-delivered` event with that question's `askSeq` follows it.

## 5. Recipient lifecycle

This table is for a peer recipient. A family recipient keeps its current behavior. Each
"pending" request below still ends at its deadline at the latest.

| Recipient state | Accepted? | Delivery | Wake | An open request to it | Sender's next step |
| --- | --- | --- | --- | --- | --- |
| `queued`, never started | Yes | `queued`; the opening session receives it | Starts with its normal turn | Pending | Wait on the request, or on the peer |
| `queued`, a continuation | Yes | `queued` | Its continuation takes it | Pending | As above |
| `running`, turn in progress | Yes | `delivered` at the next safe boundary in the turn, as steering | No new turn | Pending | As above |
| `waiting`, parked on waits, session open | Yes | `delivered` when the wake turn starts | Wakes through the wait list's admission; its waits stay open, except a `peer` wait this sender satisfies ([§ 7](#waiting-for-a-peer)) | Pending | As above |
| `waiting`, session closed (idle) | Yes | `queued` until the continuation | The scheduler continuation reopens it (`waiting.wake-no-session` in `run-states.ts`) | Pending | As above |
| `waiting` on a portable human question (`cezar_ask`) | Yes | Delivered beside the card; the card stays answerable and keeps its `askSeq` | Yes | Pending | As above |
| `waiting` on a native question | Yes | Held until the answer's turn ends (`owesWake`, `run.ts`) | After the human answers | Pending | As above |
| `waiting`, usage-limit hold | Yes | `queued` | When the hold's resume or a Continue reopens it | Pending | As above |
| `waiting` on Cezar's `budget` human wait | Yes | `queued` | No: the wake budget is spent ([§ 8](#8-bounds)) | Pending | The human resets it |
| `review`, `done`, `failed`, `cancelled`, or stopping | Not delivered: a durable `continuation-required` receipt with no input, deadline or obligation | `not-delivered` | No | A request accepted before this settles: `done` → `completed-without-reply`; `failed` → `failed`; `cancelled` → `cancelled`; `review` → `completed-without-reply` (a peer recipient only; [§ 7](#done-with-unanswered-incoming-requests)) | The instruction says: "Not delivered: task is `<status>`. Only its human can continue it." A peer cannot resume it |
| Archived | Same as its status | | | | `cez message tasks` hides it unless `--all` |
| Deleted | `denied_scope`, indistinguishable from an unrelated ID | — | — | **New** outcome `deleted` | Pick another recipient. The sender can still read its history, wait on and cancel its request ([§ 2](#the-relationship-resolver)) |
| History deletion pending on its family | `denied_scope`, as above | — | — | Pending | Retry later |
| Controller restart | Durable state is kept | Undelivered inputs replay; an input the provider accepted just before a crash, before its delivery checkpoint, may replay once, as documented today | Recovery re-arms deadlines and reconciles outcomes | Kept | Retry with the same message ID; a retry never creates a second message |

The sender must be `running` or `waiting`, as today. A sender that closes settles its open
requests as `sender-closed`.

When the sender is deleted, its ledger goes with it. An input it already queued for the
recipient stays in the recipient's own record and is still delivered, with the attribution
the input carries. A reply to one of its requests has no ledger to go to, so it is refused
with `denied_scope`. The recipient's history shows only what remains in existing ledgers.

## 6. Human questions and human input

1. Agent messages never answer a human question. A peer message reaches the recipient as
   agent input, through `submitAgentInput`. It creates no `user-message` and no
   `human-input-delivered`, and the ask card stays answerable.
2. A parent's reply answers only its own worker's routed question, through the answer seam
   (`answerRoutedQuestion`). A peer cannot reply to a routed question: the request is not
   addressed to it, so the resolver refuses with `denied_scope`.
3. A root task's question never routes to a peer. It stays with the human.
4. `cez task send` stays human input. When its environment has `CEZ_TASK_ID` (set for every
   agent session by `agentEnv`, `run.ts:1649`), it refuses before any request with exit 64:

   ```json
   { "code": "invalid_input",
     "error": "cez task send is human input. An agent inside a task cannot use it to message another task.",
     "next": "cez message progress <task-id> '<text>' --id <message-UUID> (needs CEZ_DELEGATION=1)" }
   ```

   A person or an outside bot outside any task sees no change. The guard protects the
   supported path, not the HTTP route: see [§ 1](#1-three-channels).

## 7. Waiting and finishing

### Waiting for a peer

Today a task that waits for a peer to write has no wait that fits. It can poll with timer
waits, or end its turn with none: then it gets the no-wait nudge, then Cezar's `no-wait`
human wait, and it reads **Needs you**. A message does wake it
(hearsay-tools/cezarion#1235), but the attention label is wrong, and the human may think
they must act. A request wait covers only "wake me on the reply to my request".

The **`peer`** wait kind fills that gap.

- **Register:** `cez message wait --peer <task-id> [--peer <task-id> …] [--timeout-seconds <1-1800>]`,
  or `cezar_wait` with `{ "kind": "peer", "peer_ids": [...], "timeout_seconds": 600 }`. It names
  1–32 peers. Every named peer must pass the resolver as a `peer`; otherwise registration is
  refused with `denied_scope`. Workers cannot register it.
- **No "any peer" form.** A wait "in case someone asks" has no exit but its deadline, so each
  timeout would cost a turn to wait again: polling that spends the wake budget. A named peer
  can settle, which gives the wait a real exit. A task that waits for coordination knows its
  coordinator, or finds it with `cez message tasks`. A task with nothing left to do ends.
- **Deadline:** required, 1–1,800 s, default 600. It is the wait's liveness bound.
- **What closes it:**
  - a message of any kind from a named peer;
  - a named peer reaching `review`, `done`, `failed` or `cancelled`, or being deleted, so a
    peer that finishes without writing does not leave the waiter asleep;
  - the deadline.
- **What does not close it:** a human message, a message from the run's own parent or
  workers, and any other wait resolving. Each of these wakes the run as today, and the wait
  stays open. This is the one wait a message closes: "messages close no wait"
  (hearsay-tools/cezarion#1235) still holds for every other kind.
- **At registration:** a matching message the run has not yet received, or a named peer
  already settled, resolves the wait at once. This is how request waits read durable outcomes.
- **Result:** `result.reason` is `message`, `settled` or `timeout`, with `peerRunId` and
  `messageId` when they apply.
- **Capacity:** a run parked on a `peer` wait holds no slot, like a worker wait. The idle
  timer is armed.
- **Attention:** `waitingOn` gains `{ kind: 'peers', count }`. The label reads "waiting on
  N tasks". The bucket is `none`, not Needs you. Wait order: human > usage limit > workers >
  peers > PR > process > timer.

### Waiting for a reply

A request wait already covers "I asked, wake me on the reply". It stays explicit: the agent
registers it with `cez message wait --request <UUID>`, or `cezar_wait` with
`{ "kind": "request", "request_ids": [...], "mode": "any", "timeout_seconds": 600 }`. The new
`request` kind of `cezar_wait` takes the `request_ids` field from the `worker` kind, so the
tool does not say "worker" for a peer's reply. The stored entry does not change: it stays a
`worker` entry with `requestIds` (`workerWaitEntrySchema`, `packages/contract/src/waits.ts`).
Its attention label reads "waiting on worker replies" today
(`packages/contract/src/attention.ts:109` and `:154`). When any selected request goes to a
peer, it reads "waiting on replies".

Cezar opens no implicit wait at a turn end. Session instructions tell every agent to end
its turn with a cezar tool call, so a turn that ends with no wait is rare. When one does,
the existing no-wait nudge applies. Its text also names the run's open requests and the
command that waits on them.

### Done with open requests

The completion gate (`completionGate`, `packages/cezar/src/workflows/run.ts`) applies to
root tasks. Today it blocks done only on live workers, uncollected results and a pending
human question (`parentCompletionBlockers`). A root task that finishes with an open peer
request therefore finishes, and the request settles `sender-closed`. The peer may still be
working on an answer that nobody reads.

Open requests the root sent join the blockers, the same way live workers do. "Open" means
`state: accepted` with no outcome yet. The rule covers family and peer requests. A family
request to a live worker is already blocked by that worker, so nothing changes there.

- **The first `cezar_done`** with open requests is refused. The refusal names each request,
  its recipient and its deadline. It gives the two ways forward:
  `cez message wait --request <UUID>`, or `cez message cancel-request <UUID>` for a reply the
  agent no longer needs.
- **A second `cezar_done`** on the refusal turn makes Cezar open its completion wait on those
  requests (`source: 'cezar'`, `via: 'completion'`, `requestIds`), as it does for live workers
  (hearsay-tools/cezarion#1301). Like the worker completion wait, it has no deadline of its
  own. It still always ends: every request has a deadline, and each ledger's request-deadline
  timer (`requestDeadlineTimers`, `run.ts`) settles a request `timed-out` when its deadline
  passes. A resume request's deadline can reach 86,400 s, which a Cezar wait's 1,800 s
  `timeoutSeconds` could not hold; this is why the wait takes none.
- When the requests settle, the run wakes and can call `cezar_done` again.
- A human's Finish is not blocked by open requests: the human decides. The requests settle
  `sender-closed`.
- `progress` messages create no obligation. A task that wants "send and forget" sends
  progress, and its done is not blocked.
- Workers are out of this rule. The gate does not apply to them today, and a worker's open
  request to its parent settles `sender-closed` when the worker finishes, as now.

### Done with unanswered incoming requests

The rule above covers requests a task sent. The other side is a task that received a
request and calls done without replying. Today its done passes, and the requester learns
of it only from the outcome. When the recipient rests at `review`, which is common after it
changed files, the request even stays pending until its deadline: up to 30 minutes for
nothing.

- **The first `cezar_done`** of a root task with unanswered requests addressed to it is
  refused, once in the completion cycle. The refusal names each request and its sender, and
  says: reply (a short "I cannot answer this" counts), or call `cezar_done` again to finish
  without replying.
- **The second `cezar_done` passes.** The open requests settle `completed-without-reply`
  when the task settles.
- **Not a hard block.** A hard block would let one peer keep another alive by sending
  requests, which gives a peer control over another task's lifecycle
  ([§ 3](#3-endpoint-matrix): message permission never grants control). No wait fits
  either: a task cannot wait on its own reply.
- **Scope:** root tasks, where the gate runs. For family pairs nothing changes in practice:
  an open request from a live worker already blocks the parent's done through that worker.
  A worker's own done is unchanged, because its parent can resume it.
- **A peer recipient at `review`** settles open requests `completed-without-reply` at once,
  not at their deadline. For a worker, review stays "not completion" because its parent can
  resume it. No peer can resume a task at review; only its human can. If the human continues
  it and it replies later, the reply is recorded `late`, as today, and wakes no settled
  sender.
- A request accepted while the recipient already rests at `review` cannot happen: the send
  returns `continuation-required` ([§ 5](#5-recipient-lifecycle)).

### Transitions out

New park: `waiting:peer`. The new `FiredBy` value `peer` marks a trigger fired by another
root task. [F7](#14-follow-ups) and [F8](#14-follow-ups) declare these rows in
`workflows/run-states.ts` first.

| State | Trigger | Who or what fires it | Behavior at shipped defaults |
| --- | --- | --- | --- |
| `running` | The turn ends with an open `peer` wait as the top wait | runner | `waiting:peer`; the slot is freed; the idle timer is armed |
| `waiting:peer` | A named peer sends a message | peer | The wait resolves `message`; the wake joins the line; `running` |
| `waiting:peer` | A named peer settles or is deleted | watcher | Resolves `settled`; wakes as above |
| `waiting:peer` | The deadline passes | timer | Resolves `timeout`; wakes as above |
| `waiting:peer` | A human message | human | Wakes; the wait stays open; the turn end parks again |
| `waiting:peer` | A message from its parent or a worker | parent / worker | Wakes; the wait stays open |
| `waiting:peer` | Another wait resolves | watcher / timer | Wakes with that result; the `peer` wait stays open |
| `waiting:peer` | 15 minutes idle | timer | The session closes; the run stays `waiting`; a wake reopens it through the scheduler |
| `waiting:peer` | A resolution arrives with the wake budget spent | watcher / peer | Not admitted; Cezar's `budget` human wait opens; Needs you ([§ 8](#8-bounds)) |
| `waiting:peer` | Stop | human | `cancelled`; the wait is cancelled |
| `waiting:peer` | Controller restart | recovery | The wait list is re-read; the deadline is re-armed; a message committed before the crash resolves it on reconcile |
| `running` | The turn ends on a done that open requests block, the first time in the cycle | runner | A refusal nudge that names each request and both ways forward; stays `running` (as `running.completion-nudge`) |
| `waiting:*` | A human presses Finish while requests are open | human | Not blocked by open requests: the human decides. Done; the open requests settle `sender-closed`. Live workers and an open question still block Finish, as today (`waiting.finish`) |
| `running` | The refusal turn ends on a blocked done again, with open requests | runner | Cezar's completion request wait; `waiting:workers`, labelled "waiting on replies" (as `running.completion-wait`). With the wake budget spent, Cezar's `budget` human wait instead (`running.budget`) |
| `waiting:workers` (completion request wait) | Every named request settles: reply, cancellation, recipient lifecycle, or its own deadline | peer / worker / timer | Resolves; the wake joins the line; `running`; the next `cezar_done` passes the gate |
| `waiting:workers` (completion request wait) | A human message | human | Wakes; the wait stays open |
| `running` | The turn ends on a done while requests addressed to it are unanswered, the first time in the cycle | runner | A refusal nudge that names each request and its sender; stays `running` |
| `running` | The refusal turn ends on done again, with incoming requests still unanswered | runner | Done passes (or rests at `review`); the requests settle `completed-without-reply` |

The `peer` wait's deadline is an automatic exit, so `run-states.test.ts` accepts the state. The
completion request wait has no deadline of its own. Its automatic exit is the request
deadlines, which the per-ledger timer fires.

## 8. Bounds

All existing caps apply unchanged ([§ 2](#2-reuse-and-the-one-abstraction)). Peer messages
count toward the ledger that holds them and toward the recipient's 32 undelivered inputs. A
pair's merged history is paged at 1,024 messages
([§ 2](#which-ledger-holds-a-message)).

A family has a parent that can stop a loop. Two peers do not: two coordinators that reply to
each other could run until their ledgers fill, up to 1,024 messages each, and every message
can start a turn. So peer messages charge the existing automatic-wake budget:

- A peer message, or a `peer` wait resolution, that **starts a new turn** on the recipient
  charges one unit of its automatic-wake budget (`MAX_AUTO_CONTINUES`, 40, `run.ts:540`).
  Today `chargesBudget` (`packages/cezar/src/workflows/waits.ts:40`) charges only timer and
  process waits.
- A message taken inside a running turn, as steering, charges nothing.
- With the budget spent, peer messages stay `queued` and wake nothing. Cezar opens its
  `budget` human wait, as it does today, and the run reads Needs you. A human message
  resets the budget.
- Family messages do not charge. Their behavior does not change.

Worst case: 40 automatic turns per task for each human touch.

## 9. Discovery

`cez message tasks [--all] [--offset <n>]` lists the caller's peers:

```json
{ "tasks": [
  { "id": "04a258b0-…", "title": "Migrate to pnpm", "runner": "claude", "status": "waiting",
    "attention": "waiting", "attentionLabel": "needs you", "accepts": true },
  { "id": "6f1c…", "title": "Release notes", "runner": "pi", "status": "review",
    "attention": "waiting", "attentionLabel": "needs review", "accepts": false,
    "reason": "review: only its human can continue it" } ],
  "nextOffset": 32 }
```

- It lists root tasks in the caller's project and leaves out the caller, workers and other
  projects. It leaves out archived tasks unless `--all` is given. A page holds at most 32
  rows, like `cez worker list`.
- `attention` and `attentionLabel` come from `deriveAttention`
  (`packages/contract/src/attention.ts`), the function the cockpit and `cez task` read.
- `accepts` is false for the states in [§ 5](#5-recipient-lifecycle) that return
  `continuation-required`, and `reason` says why.
- The route is `POST /api/v1/delegation/discover` with `{ "kind": "tasks" }`, under the
  existing private listener and credential. Workers get `denied_scope`.

## 10. CLI and API paths

Every `cez message` verb uses the existing `/api/v1/delegation/*` routes. The server decides
the relationship. No request field carries it.

| Action | Command | Route |
| --- | --- | --- |
| Human input | Cockpit composer; `cez task send <id> '<text>'` outside any task | `POST /api/v1/p/:projectId/runs/:id/messages` |
| Ask for a reply | `cez message request <task-id> '<text>' --id <UUID> [--timeout-seconds <1-1800>]` | `POST /api/v1/delegation/send`, `kind: request` |
| Give an update | `cez message progress <task-id> '<text>' --id <UUID>` | `…/send`, `kind: progress` |
| Clarify your request | `cez message follow-up <task-id> '<text>' --id <UUID> --request-id <UUID>` | `…/follow-up` |
| Answer a request | `cez message reply <task-id> '<text>' --id <UUID> --request-id <UUID>` | `…/reply` |
| Read history | `cez message conversation <task-id> [--before <cursor>]` | `…/conversation` |
| Read unread input mid-turn | `cez message inbox` | `…/inbox`, `…/inbox/ack`, `…/inbox/release` |
| Cancel your request | `cez message cancel-request <UUID>` | `…/cancel-request` |
| Wait on requests | `cez message wait --request <UUID> [--request …] [--mode one\|any\|all]`, or `cezar_wait` kind `request` | `…/wait` |
| Wait on peers | `cez message wait --peer <task-id> [--peer …]`, or `cezar_wait` kind `peer` | `…/wait` |
| Cancel a wait | `cez message cancel-wait <wait-id>`, or `cezar_cancel_wait` | `…/cancel-wait` |
| List peers | `cez message tasks` | `…/discover`, `kind: tasks` |
| Resume a settled worker | `cez worker resume <worker-id> '<instruction>' --id <UUID> [--timeout-seconds <1-86400>]` | `…/send` with `resume: true` |

Each verb names one message kind, so `request` replaces today's `send --kind request`. The
recipient is a run ID for both relationships.

`cez worker` keeps `spawn`, `list`, `inspect`, `collect`, `steer`, `stop`, `destroy`, `diff`,
`wait <worker-id>`, `cancel-wait`, and gains `resume`. Its message verbs (`send`, `progress`,
`follow-up`, `reply`, `conversation`, `inbox`, `cancel-request`, `wait --request`) are removed.
An agent that types one gets exit 64 with the `cez message` verb to use. `cez message
request --resume` is refused and names `cez worker resume`.

## 11. Runner-native messaging and other channels

- With `CEZ_DELEGATION=1`, every runner's `restrictNativeDelegation` blocks its native
  delegation entry points. For the Claude CLI runner that includes `SendMessage` and
  `ListAgents` (`--disallowedTools Agent,Task,Workflow,SendMessage,ListAgents`,
  `packages/cezar/src/core/claude-cli-runner.ts:750`).
- With delegation off, a runner's native cross-session tools may be available. Messages sent
  through them are untracked: no ledger, no cockpit attribution, no receipts, no deadline,
  and no protection for human questions beyond the runner's own. The protocol does not use
  them, and session instructions name `cez message` as the only supported path.
  [F6](#14-follow-ups) decides whether to restrict native cross-session tools at shipped
  defaults. That decision must hold for every user's plugins and setup, not one host's.
- Runner-native subagents inside one session are not tasks and are out of scope.

## 12. Examples

The runner of each task does not change the commands: every runner calls `cez message`
through its shell tool, or `cezar_wait` for the `peer` wait.

**A Codex coordinator asks a Claude task a question.**

```console
codex$ cez message tasks
{"tasks":[{"id":"04a258b0-…","title":"Migrate to pnpm","runner":"claude","status":"running","accepts":true,…}]}

codex$ cez message request 04a258b0-… 'Which package versions have you reserved? Reply with a list.' \
         --id 7d0c… --timeout-seconds 900
{"message":{"id":"7d0c…","senderRunId":"474cc4f5-…","recipientRunId":"04a258b0-…",
  "relationship":"peer","kind":"request","state":"accepted","deadline":"…"},"delivery":"queued"}

codex$ cez message wait --request 7d0c…
{"wait":{"id":"…","deadline":"…"},"instruction":"Wait … registered … End your turn now …"}
```

The Claude task receives the request as agent input, attributed to the Codex task. It
answers:

```console
claude$ cez message reply 474cc4f5-… 'Reserved: zod 4.1.x, hono 4.9.x.' --id 91aa… --request-id 7d0c…
{"message":{…,"kind":"reply","requestId":"7d0c…","state":"accepted"},"delivery":"queued",
 "outcome":{"requestId":"7d0c…","status":"replied","replyId":"91aa…"}}
```

The Codex task's request wait resolves, and it wakes with the reply.

**A pi task waits for a coordinator's go-ahead.**

```console
pi$ cez message wait --peer 474cc4f5-… --timeout-seconds 1800
```

The pi task ends its turn and reads "waiting on 1 task", not Needs you. The coordinator sends
`cez message progress <pi-task> 'Wave 2 is merged; start the migration.' --id …`. The `peer`
wait resolves `message`, and the pi task wakes.

**An OpenCode coordinator sends progress to a task with an open question.**

The recipient has a pending `cezar_ask` card. The progress message is delivered beside the
card. The card stays answerable, and its `askSeq` is not retired. The thread shows a peer
message card, not a user message. This is the incident, made safe.

**A coordinator tries to finish with a request still open.**

The Codex coordinator above calls `cezar_done` before the Claude task replies. The refusal
names request `7d0c…` to `04a258b0-…`, its deadline, and both ways forward:
`cez message wait --request 7d0c…`, or `cez message cancel-request 7d0c…`. The coordinator
registers the wait and ends its turn. The reply wakes it, and its next `cezar_done` passes.

**A Codex agent tries the human-input command.**

```console
codex$ cez task send 04a258b0-… 'Coordinator 474cc4f5 continues 017 wave 2 …'
{"code":"invalid_input","error":"cez task send is human input. …","next":"cez message progress …"}
codex$ echo $?
64
```

## 13. Regression scenarios

Each follow-up proves its scenarios fail without its change (AGENTS.md § Prove the
regression test fails without the fix).

| ID | Scenario | Expected | Follow-up |
| --- | --- | --- | --- |
| R1 | The incident, self-contained: a task with an open `cezar_ask`; a peer sends progress | The ask stays pending; no `user-message`, no `human-input-delivered`; the card is answerable; the thread shows a peer card | F2 |
| R2 | `cez task send` with `CEZ_TASK_ID` set | Exit 64; no request reaches the cockpit (a fake cockpit records none) | F1 |
| R3 | `cez task send` without `CEZ_TASK_ID` | Unchanged: it answers the open question | F1 |
| R4 | Worker → peer root; root → another family's worker; worker discovery | `denied_scope` each; family pairs behave as before | F2, F3 |
| R5 | Root → a task in another project, and a forged recipient ID | `denied_scope`, with text identical to an unrelated ID | F2 |
| R6 | A peer replies to another task's routed worker question | `denied_scope`; the question stays pending | F2 |
| R7 | Peer request, reply, then restart | Request and reply are in the requester's ledger; the recipient's ledger is unchanged; projections replay without new inputs | F2 |
| R8 | Peer recipient in each [§ 5](#5-recipient-lifecycle) state, including deletion after acceptance and a pending history deletion | The row's acceptance, delivery, wake and outcome; `deleted` for the deleted case; `denied_scope` for a pending history deletion | F2 |
| R9 | A `peer` wait: matching message, non-matching peer, human message, family message, peer settles, deadline, restart | Each [Transitions out](#transitions-out) row | F7 |
| R10 | Peer messages past the wake budget | The 41st wake opens the `budget` human wait; a human message resets it; family messages never charge | F2 |
| R11 | `RUNNER_IDS` parity: peer attribution and a pending human question on every native wire | Every runner keeps the question and shows the peer sender | F2, F7 |
| R12 | `cez message request --resume`, and a removed `cez worker` message verb | Exit 64, naming the replacement command | F3 |
| R13 | A root calls `cezar_done` with an open peer request; then again; then the peer replies. Separately: it cancels the request first; it sent only progress; a human presses Finish | First done: a refusal nudge naming the request. Second: Cezar's completion request wait, and the reply wakes the run. Cancel first, progress only, or Finish: done passes; Finish settles the request `sender-closed` | F8 |
| R14 | Peers B and C send a message with the same ID to A, in both orders and concurrently | The second is refused with `invalid_input` and writes nothing; A gets the first once; projections on A stay intact; an exact retry of the first returns its receipt | F2 |
| R15 | A peer is deleted after A's request to it was accepted; a sender is deleted before A's first inbox reserve, and another between reserve and acknowledge | A can still read its history, wait on and cancel its request; the request settles `deleted`; the reserve returns a receipt; the acknowledge succeeds for the whole batch; a reply to the deleted sender's request is refused | F2 |
| R16 | A pair whose two ledgers are both full, with several messages sharing the `createdAt` at the page boundary | The history returns the newest 1,024 messages with `nextBefore`; `--before` returns the rest; every message appears exactly once across the pages; no response passes the schema bound | F2, F3 |
| R17 | B has an unanswered request from peer A and calls `cezar_done`; then again. Separately: B replies first; B ends at `review` with A's request open; B's human continues B and B replies | First done: a refusal nudge naming A's request. Second: done passes; A's request settles `completed-without-reply` and A's wait wakes. A reply first: done passes on the first call. At `review`: the request settles at once, not at its deadline. The late reply is recorded `late` and wakes nothing | F2, F8 |

## 14. Follow-ups

The owner approved this spec on 2026-10-27, and each follow-up is filed as one issue. F1 is
independent and closes the incident path. F2 comes before F3, F4, F7 and F8. F5 travels with
the change it documents.

| ID | Issue | Scope | Scenarios |
| --- | --- | --- | --- |
| F1 | hearsay-tools/cezarion#1989 | `cez task send` refuses with exit 64 when `CEZ_TASK_ID` is set, and names the remedy | R2, R3 |
| F2 | hearsay-tools/cezarion#1990 | The relationship resolver with its two levels; peer conversations in the service, ledger and outcomes (`relationship`, `deleted`, `review` settling a peer request); message identity across ledgers; merged, paged history (`nextBefore`, `before`); peer wakes charge the wake budget; parity cells | R1, R4–R8, R10, R11, R14–R17 |
| F3 | hearsay-tools/cezarion#1991 | The `cez message` CLI family (including `conversation --before`), `cez message tasks` discovery, `cez worker resume`; removal of the `cez worker` message verbs; new session instructions in `delegation/provision.ts` | R4, R12 |
| F4 | hearsay-tools/cezarion#1992 | Cockpit: peer message cards name and link the peer task; thread and relationship views; light and dark themes; 360 px width | R1 (thread) |
| F5 | hearsay-tools/cezarion#1993 | `AGENT_PROTOCOL.md`, `BACKWARD_COMPATIBILITY.md` (the delegation CLI is agent-facing and not a protected surface; the new optional fields and the `peer` wait), README | — |
| F6 | hearsay-tools/cezarion#1994 | Runner-native cross-session messaging at shipped defaults: decide, per runner, whether to restrict it, and update instructions | — |
| F7 | hearsay-tools/cezarion#1995 | The `peer` wait kind: contract, `run-states.ts` rows, `waitingOn` and attention (including "waiting on replies" for peer requests), `cezar_wait` kinds `peer` and `request`, `cez message wait --peer`, parity cells | R9, R11 |
| F8 | hearsay-tools/cezarion#1996 | The completion gate and requests: open requests a root sent block its done (`parentCompletionBlockers`, Cezar's completion request wait); unanswered incoming requests refuse its first done once; the refusal and no-wait nudge texts; `run-states.ts` rows; parity cells | R13, R17 |

## Migration

- **Agents.** New sessions get the new instructions. The removed `cez worker` message verbs
  exit 64 with the replacement, so an agent that follows old habits finds the new verb in one
  step. `cez worker send --resume` becomes `cez worker resume`.
- **Coordinators that used `cez task send`.** With delegation off, they now get exit 64. The
  remedy is `CEZ_DELEGATION=1`, then `cez message`. With delegation on, they use `cez message`
  directly.
- **People and outside bots.** No change. `cez task send` outside a task is human input, as
  before.
- **Stored records.** `relationship` is optional and absent on old messages, which read as
  `family`. The `deleted` outcome and the `peer` wait are additive. F5 records what an older
  cezar does with a record that carries them: its strict schemas do not know them, and F7
  tests the store's behavior on that read.
- **`cezar_wait`.** Request waits move from kind `worker` with `request_ids` to kind
  `request`. The `worker` kind keeps `worker_ids` only. Stored wait entries do not change.
- **HTTP routes.** The `/api/v1/delegation/*` paths do not change. `discover` gains
  `{ "kind": "tasks" }`, and `wait` gains the peer selection.

## Out of scope

- Implementing any of this before the spec is reviewed.
- Treating permission to message as permission to control another task or its workspace.
- Hard isolation from the same-user shell.
- Peers across projects or across cockpits.
- Lateral messaging between workers of one family (hearsay-tools/cezarion#114, not planned).
