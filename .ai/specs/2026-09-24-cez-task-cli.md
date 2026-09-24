# `cez task` — operator/bot CLI over the cockpit's run routes — #504

An operator, or an LLM bot driving a shell, cannot start a task that appears in
the running cockpit, watch it and steer it from a terminal. `cez run` keeps its
own in-process store, so a live `cez serve` never sees the run. `cez worker`
needs a provisioned delegation session. Raw HTTP works but costs a bot quoting
bugs, whole-record polls and an SSE stream that never ends.

`cez task` is a thin JSON client over routes that already exist. It adds no
scheduler, no daemon and no state that must be authored. The issue body is the
requirements record; this spec records the design decisions taken on top of it.

## Server change: idempotent start

The only API change. Everything else is client-side.

- **Contract.** `createRunInputSchema` gains an optional `clientRequestId`
  (UUID). A refine rejects it together with `variants > 1`: a request id names
  one run. `createRunInputBaseSchema` is NOT widened, so automation task
  definitions do not inherit the key. `runRecordSchema` gains optional
  `clientRequestId` and `clientRequestHash`; both are absent on every existing
  record, so old `runs.json` files parse unchanged.
- **Hash.** `packages/cezar/src/runs/client-request.ts` computes sha256 over the
  canonical JSON (sorted keys, `undefined` dropped) of `task`, `workflow` or
  `steps`, `runner`, `model`, `effort`, `agentProfile`, `autonomous`, `worktree`,
  `systemPrompt`, `images` and `generateFollowups`, taken from the validated
  request body. Attachments and follow-up generation affect agent behavior, so
  changed values conflict too. The record stores the hash, never the payload.
- **Dedupe.** `RunManager.startRunIdempotent(workflow, input, { id, hash })`
  reads the project store for a run carrying that `clientRequestId`, and creates
  one when there is none, on one synchronous path. The route's awaits
  (workflow load, provider gate, account check) all happen before that call, so
  two concurrent retries serialise on the event loop and exactly one creates.
  - same hash → `{ run, created: false }`, whatever the run's state, archived
    included;
  - different hash → a conflict;
  - a deleted run's id is gone with its record, so a retry creates a fresh run.
- **Route.** After body validation, `POST /runs` checks for an existing id/hash
  before mutable start prerequisites (workflow, provider, account and model
  policy). A retry can retrieve an accepted run even when those prerequisites
  no longer hold. New starts still pass every check and the synchronous manager
  call rechecks dedupe after the awaits. The route answers `201` with a new run,
  `200` with a matched one, and `409 { error: "request id payload conflict" }`.
  Both success statuses are `as const` so hono's inference keeps the split. The response body shape is
  unchanged (`createRunResponseSchema`).
- **Scope** is the project store, not the workspace.

## CLI: `packages/cezar/src/task-cli/`

Dispatched in `src/index.ts` before the global `parseArgs`, as `worker` is.
Plain `fetch`; responses validated with contract schemas; no runtime import of
the api-client. Requests retain deadlines. Successful `GET /runs` responses are
exempt from the ordinary 3 MiB byte cap: that existing endpoint returns the full,
unpaginated history, which can legitimately exceed the cap. Like the cockpit,
`list` and `wait` currently materialize that history in memory; error responses
and other JSON requests retain the byte cap. No new API route is introduced.

### Discovery (`discovery.ts`)

1. `--url <origin>` or `CEZ_URL` → that origin, no probe.
2. Otherwise probe `http://127.0.0.1:<port>/api/v1/health` for every port in
   4321–4370 in parallel, each with a short timeout.
3. For each healthy cockpit, read `GET /api/v1/projects` and compare each
   project `root` with this checkout's root: the realpath of `--repo` or cwd,
   resolved to the main checkout through `git rev-parse --git-common-dir` so a
   task worktree finds its parent project. For submodules, whose shared Git dir
   is under `.git/modules/`, resolve the main checkout's `core.worktree` against
   that Git dir. Lowest matching port wins.
4. No match → `{ code: "no-cockpit", error, hint }`, exit 2. No headless
   fallback, no server started, nothing written.

With `--url` and no root match (a remote cockpit's paths are not local paths)
the boot project is used. The API scope is `/api/v1/p/<projectId>`; the thread
URL is `<origin>/p/<projectId>/tasks/<runId>`.

The plain client passes the #426 origin guard as-is (loopback `Host`, no
`Origin`). Nothing reads, prints or forwards `CEZ_DELEGATION_*`.

### Commands (`cli.ts`)

`start`, `list`, `status`, `log`, `wait`, `send`, `stop`, `finish`, `diff`,
`open`, with the flags the issue lists. `--help` on the family and on each
operation prints text without a server. `--full` returns the contract shape.

- `start` generates a `clientRequestId` when `--request-id` is omitted and
  prints `{ id, url, status, created, branch? }`. `--task-file -` reads stdin.
- `status` is the slim projection; `question` comes from
  `GET /runs/:id/history-context`'s pending ask, fetched only when
  `hasPendingHumanAsk` is true.
- `log` prints one JSON line per `text`/`tool-call`/`tool-result`/`step-start`/
  `error`/`user-message` event from `GET /runs/:id/history`, bounded by
  `--max-chars`. `--follow` reads `GET /runs/:id/events` from the last printed
  `seq`, dedupes by `seq`, and exits on a terminal `run` frame or at
  `--timeout-seconds`.
- `wait` **polls** `GET /runs` every 1.5 s (owner decision, 2026-09-24): one
  call covers any number of runs and holds no socket. `--until settled` waits
  for `done`/`review`/`failed`/`cancelled`; `--until attention` also stops on
  `waiting` or a pending human ask.
- `send` posts to `/messages`. A `409 { error: "session closed" }` without
  `--resume` prints `{ delivery: "not-delivered", reason, next }`, exit 1; with
  `--resume` it posts the text to `/continue`. Any other 409 passes through,
  exit 2.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | success; `wait`/`start --wait`: every awaited run ended `done` or `review` (`--mode all`) or one did (`--mode any`) |
| 1 | run ended `failed`/`cancelled`, or a send was not delivered |
| 2 | no cockpit/project, or the cockpit refused (its `{ error }` passed through) |
| 3 | `wait`/`log --follow` timed out; partial outcomes printed |
| 64 | usage error: `{ code: "invalid_input", error, usage }` |

## Around the edges

- `CEZ_URL` in `.env.example` and the README env table; default unset.
- README: a short "From the terminal" section (`start` → `wait` → `status` →
  `send`).
- `cez --help` gains one line for `cez task`.
- `cez run` prints one stderr hint when discovery finds a cockpit serving the
  repo. Short probe timeout; a failure prints nothing and never blocks the run.
- BACKWARD_COMPATIBILITY.md notes the optional `clientRequestId` on the start
  body and the two optional record fields.

## Testing

- Vitest: discovery (fake health/projects servers, worktree → parent match,
  `--url` fallback, no-cockpit), projections, the `send` ladder and exit codes
  against an in-process app.
- Store/route: same id and payload → 200 and one run; changed payload → 409;
  two concurrent retries → one run; a record without the fields still parses;
  `variants > 1` with an id → 400.
- Packaged e2e (`packages/cezar/test/e2e/task-cli.test.ts`): the built CLI
  against a `CEZ_DRY_RUN=1` cockpit — `start --wait`, `status`, `send --resume`,
  `stop`, the run present in that server's `GET /runs` — and exit 2 with no
  server up.
