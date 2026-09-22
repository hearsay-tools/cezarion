# Worker message delivery and continuation — #475

The parent received queued worker messages one per turn, extending an already
long first-turn delay. It also failed to register a worker wait while executing
the human's approval, and received an unhelpful rejection when addressing a
completed worker. This change fixes all three paths.

## Incident evidence

Times below are UTC on 2026-09-22. Evidence is the local run NDJSON and persisted
recipient input checkpoints under `.ai/cezar/`. Sequence numbers identify events;
the historical logs are not copied into the repository.

Parent: `3cbb9ea8-4720-4f62-a5d6-85149f3ca114`.

| Event | Time | Evidence |
| --- | --- | --- |
| Human approves the plan | 13:27:12.234 | Parent seq 532 |
| Approved continuation begins | 13:27:15.952 | Parent seq 537 |
| Parent attempts `worker wait` | 14:05:39.014 | Parent seq 1931 |
| Wait refused: `parent cannot register a worker wait` | 14:05:39.195 | Parent seq 1933, exit 1 |
| Parent ends with `CEZ:MONITORING` | 14:05:58.207 | Parent seq 1960 |
| Turn ends; old human answer finally checkpoints | 14:05:58.305 | Parent seq 1964–1966 |
| Oldest queued message acknowledged | 14:05:58.390 | Recipient input `071ebc2a-66c8-49db-972c-d2763015b4bb` |
| Next parent turn starts | 14:05:59.500 | Parent seq 1968 |

The wait guard read durable unanswered-question history. The prior ask (seq 527)
remained pending there until the opening turn finished, even though its explicit
answer was already executing. Registration failed, so no worker wait existed to
park. Queued input then started another turn before ordinary monitoring could
park the parent. `CEZ:MONITORING` itself is not a registered worker wait.

Worker `9912ac0a-37b2-4228-862f-48b546944a17` illustrates the queue:

| Message created | Delivered projection recorded |
| --- | --- |
| 13:30:27 | 14:27:19 |
| 13:34:18 | 14:30:32 |
| 13:37:50 | 14:31:23 |
| 13:38:23 | 14:31:37 |
| 13:42:35 | 14:32:12 |
| 14:10:39 | 14:36:50 |

These arrivals align with separate parent turn boundaries, interleaved with other
workers. The worker had finished at 14:11:30.233. This was delayed delivery to the
parent, not continued execution by the worker.

Message `885b52ca-4cce-4fa2-9b12-0c7c88c0bdd5` from worker
`bf2abb46-0389-422d-9dc3-72cee1ea5b8f` was created at 13:45:02.697, before that
worker finished at 13:45:14.269. Its recipient input records delivery at
14:32:54.554; both participants' projections appeared at 14:32:54.648 (parent
seq 3310, worker seq 641). The 94 ms projection delay does not explain the
47-minute queue delay. Request `36ff45bf-bbdf-4c87-bc9a-257b26aee91d` was cancelled
at 13:42:58.298, then delivered at 14:30:53.347; delivery did not reopen it.

Worker `f48a5fc6-703c-43e8-866f-9b5733f8d2bf` finished at 13:47:21.737. Parent
message `509d6204-ac99-4c83-9db4-e0d7739c25b9`, created at 13:47:39.980, received
`not-delivered` / `continuation-required`. The parent saw that JSON in seq 1107
at 13:47:41.204, but it lacked a reason or remedy. No input was queued. The old
CLI treated a successfully parsed rejected receipt as exit 0.

## Approved behavior

- An executing human answer exempts only its exact old ask from wait admission.
  The durable checkpoint stays at the successful turn boundary for crash recovery;
  newer asks retain their human gate. Wait errors explain cause and remedy.
- Pending conversations share the next safe provider turn, bounded to 32 inputs
  and 100,000 formatted characters. A single valid message is never split.
  Lifecycle inputs remain barriers. Each ID receives its own durable receipt;
  one ACK atomically confirms the whole submitted batch. Later enqueues remain.
- An active owning parent explicitly sends `worker send --resume` with a new
  instruction to continue a settled done/review/failed child. Acceptance atomically
  records the message, input and continuation revision, using existing identity,
  capacity and recovery machinery. Rejected receipts give the exact next command.
  Retrying the same accepted message never starts another execution.
- The opening message's receipt stays queued until its successful opening turn
  confirms delivery. Its receipt and replay-prompt retirement checkpoint together.
  Regular queued messages retain backend transport-ACK semantics. The thread shows
  creation, delivery confirmation and projection times separately.
- Stopped/destroyed workers, reviewing parents and genuine human asks retain their
  existing boundaries. No new dependency, configuration or automatic root resume.

## Verification mapping

`worker-wait-continuation.test.ts` reproduces the stale-ask refusal and checks
registered → parked capacity release and newer asks. `conversation-batch.test.ts`
reproduces one-message-per-turn with several completed senders and a timed-out
request. `input.test.ts` covers aggregate bounds and lifecycle barriers.
`conversation-delivery.test.ts` exercises batching through all backend protocols.
`conversation-resume.test.ts` covers parent-driven continuation and restart through
those protocols. Service/store tests cover retry identity, atomic persistence and
refusal instructions; CLI and thread tests cover visible feedback and timestamps.

The default path gains batching and usable wait admission without another knob.
Active-turn and human-input priority remain. Queue persistence still cannot prove
exactly-once execution across a crash between provider acceptance and local receipt.
