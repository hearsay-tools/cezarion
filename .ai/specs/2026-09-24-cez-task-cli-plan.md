# `cez task` Implementation Plan — #504

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `cez task` JSON CLI that starts, watches and steers tasks in the running cockpit, plus an idempotent `POST /runs`.

**Architecture:** One additive server change (`clientRequestId` → store-side dedupe, `200`/`201`/`409`). Everything else is a loopback `fetch` client under `packages/cezar/src/task-cli/`, dispatched from `src/index.ts` before `parseArgs`, like `cez worker`.

**Tech Stack:** TypeScript ESM, Node ≥20 `fetch`, zod contract schemas from `@open-mercato/cezar-contract`, Hono (server), vitest.

**Spec:** `.ai/specs/2026-09-24-cez-task-cli.md` (requirements record: issue #504).

## Global Constraints

- The service may import contract VALUES; it must not import `@open-mercato/cezar-api-client` at runtime.
- Every new record field is optional; old `runs.json` must parse.
- The contract describes exactly what the route sends; fix the source, never widen the schema.
- Routes stay chained in `runsRoutes`; validation stays middleware.
- `CEZ_URL` documented in `.env.example` and the README env table in the same commit that adds it.
- All CLI output is JSON except explicit `--help` text. Nothing reads or prints `CEZ_DELEGATION_*`.
- Exit codes: 0 ok · 1 run failed/cancelled or not delivered · 2 no cockpit / server refused · 3 timeout · 64 usage.
- Probe range 4321–4370. `wait` polls `GET /runs` every 1.5 s. `--timeout-seconds` 1–1800.
- Conventional Commits; `Co-Authored-By` trailer on each commit.

## Review Focus

1. **A run id the cockpit does not know** (`status bogus`) → server `404 { error: "not found" }` passed through, exit 2 — not a crash or exit 1. Test in Task 4.
2. **A cockpit that is up but serves a different repo** → `no-cockpit`, exit 2, never "use whatever answered". Test in Task 3.
3. **`--task-file -` with empty stdin** → usage error exit 64, no run created. Test in Task 4.
4. **`wait` on an id that disappears (deleted) mid-wait** → reported as `missing`, counted as failure (exit 1) rather than polling until timeout. Test in Task 5.
5. **Same `--request-id` reused with a different task** → the server's 409 passes through, exit 2, and no second run exists. Test in Task 2 (route) and Task 4 (CLI).

---

### Task 1: Contract fields and request hash

**Files:**
- Modify: `packages/contract/src/runs.ts` (`runRecordSchema`, `createRunInputSchema`)
- Modify: `packages/cezar/src/runs/store.ts` (store `runRecordSchema`, `createRun` input + `buildRun`, new `findRunByClientRequestId`)
- Modify: `packages/cezar/src/server/server.ts:580` (`startRunSchema` gains `clientRequestId` + refine)
- Create: `packages/cezar/src/runs/client-request.ts`
- Test: `packages/cezar/src/runs/client-request.test.ts`, `packages/cezar/src/runs/store.test.ts`

**Interfaces:**
- Produces: `clientRequestHash(body: ClientRequestPayload): string`; `RunStore.findRunByClientRequestId(id: string): RunRecord | undefined`; `createRun({... clientRequestId?, clientRequestHash? })`.

- [ ] Step 1: failing tests — hash is stable under key order and `undefined` keys, differs on `task`/`workflow`/`steps`/`runner`/`model`/`effort`/`agentProfile`/`autonomous`/`worktree`/`systemPrompt`, ignores `images`/`todoId`/`variants`/`generateFollowups`/`clientRequestId`; store round-trips both fields through `flush` + reopen; a record without them still loads; `findRunByClientRequestId` finds archived runs.

```ts
import { clientRequestHash } from './client-request.ts';
it('is independent of key order and undefined keys', () => {
  expect(clientRequestHash({ task: 'a', workflow: 'w', model: undefined }))
    .toBe(clientRequestHash({ workflow: 'w', task: 'a' }));
});
it('changes with the task', () => {
  expect(clientRequestHash({ task: 'a', workflow: 'w' })).not.toBe(clientRequestHash({ task: 'b', workflow: 'w' }));
});
```

- [ ] Step 2: run `npm test -- packages/cezar/src/runs/client-request.test.ts` → FAIL (module missing).
- [ ] Step 3: implement.

```ts
import { createHash } from 'node:crypto';
const KEYS = ['task', 'workflow', 'steps', 'runner', 'model', 'effort', 'agentProfile', 'autonomous', 'worktree', 'systemPrompt'] as const;
export type ClientRequestPayload = Partial<Record<(typeof KEYS)[number], unknown>>;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  }
  return value;
}
export function clientRequestHash(body: ClientRequestPayload): string {
  const picked = Object.fromEntries(KEYS.map((k) => [k, body[k]]));
  return createHash('sha256').update(JSON.stringify(canonical(picked))).digest('hex');
}
```

Contract: `clientRequestId: z.string().uuid().optional()` and `clientRequestHash: z.string().optional()` on `runRecordSchema`; `createRunInputSchema = createRunInputBaseSchema.extend({ clientRequestId: z.string().uuid().optional() }).refine(xor).refine(b => !(b.clientRequestId && (b.variants ?? 1) > 1), { message: 'clientRequestId names one run; it cannot be combined with variants > 1' })`. Mirror the same key and refine on the server's `startRunSchema`. Store schema, `createRun` input and `buildRun` gain both fields; `findRunByClientRequestId` scans `this.runs.values()`.

- [ ] Step 4: tests pass; `npm run typecheck` green.
- [ ] Step 5: commit `feat(runs): record an optional client request id on runs (#504)`.

### Task 2: Idempotent `POST /runs`

**Files:**
- Modify: `packages/cezar/src/workflows/run.ts` (`StartRunInput` unchanged; new `startRunIdempotent`)
- Modify: `packages/cezar/src/server/server.ts` (`POST /runs` handler)
- Modify: `packages/cezar/src/server/contract-parity.runs.test.ts` (add the `200` branch)
- Modify: `BACKWARD_COMPATIBILITY.md` (§2/§3 note)
- Test: `packages/cezar/src/server/start-run-idempotent.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `RunManager.startRunIdempotent(workflow, input, request: { id: string; hash: string }): { run: RunRecord; created: boolean } | { conflict: true }`.

- [ ] Step 1: failing route tests with a real `RunManager` (`new RunManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) })`, so runs stay `queued`):
  - first post → 201; repeat → 200 with same `id`; `store.listRuns()` length 1;
  - repeat with a different `task` → 409 `{ error: 'request id payload conflict' }`, still one run;
  - `Promise.all([post(body), post(body)])` → statuses `[201, 200]` in some order, one run;
  - archived match → 200;
  - `variants: 2` + id → 400;
  - no id → two posts make two runs (unchanged behaviour).
- [ ] Step 2: run → FAIL (second post answers 201).
- [ ] Step 3: implement.

```ts
startRunIdempotent(workflow: WorkflowDef, input: StartRunInput, request: { id: string; hash: string }):
  { run: RunRecord; created: boolean } | { conflict: true } {
  const existing = this.store.findRunByClientRequestId(request.id);
  if (existing) return existing.clientRequestHash === request.hash ? { run: existing, created: false } : { conflict: true };
  return { run: this.startRun(workflow, input, undefined, request), created: true };
}
```

`startRun` gains an optional 4th parameter `clientRequest?: { id: string; hash: string }` passed to `createRun` as `clientRequestId`/`clientRequestHash`. Route: after the provider/account gates and before the variants branch,

```ts
if (parsed.data.clientRequestId) {
  const result = manager.startRunIdempotent(workflow, input, { id: parsed.data.clientRequestId, hash: clientRequestHash(parsed.data) });
  if ('conflict' in result) return c.json({ error: 'request id payload conflict' }, 409);
  if (!result.created) return c.json(result.run, 200 as const);
  if (parsed.data.todoId) await noteTodoStarted(dataDir, parsed.data.todoId, result.run.id);
  return c.json(result.run, 201 as const);
}
```

Parity test: add `type RunCreate200 = InferResponseType<Runs['$post'], 200>` and `Assert<Exact<z.infer<typeof runRecordSchema>, RunCreate200>>`.

- [ ] Step 4: `npm test -- packages/cezar/src/server/start-run` green; `npm run typecheck` green.
- [ ] Step 5: prove red: `git stash push -m cez504-t2 -- packages/cezar/src/server/server.ts packages/cezar/src/workflows/run.ts`, run the new test → FAIL, `git stash apply` + drop by sha.
- [ ] Step 6: commit `feat(server): make POST /runs idempotent on clientRequestId (#504)`.

### Task 3: HTTP client and cockpit discovery

**Files:**
- Create: `packages/cezar/src/task-cli/http.ts`, `packages/cezar/src/task-cli/discovery.ts`
- Test: `packages/cezar/src/task-cli/discovery.test.ts`

**Interfaces:**
- Produces:
  - `class TaskCliError extends Error { constructor(readonly exitCode: number, readonly body: Record<string, unknown>) }`
  - `type Cockpit = { origin: string; projectId: string; api: string /* `${origin}/api/v1/p/${projectId}` */ }`
  - `threadUrl(c: Cockpit, runId: string): string` → `${origin}/p/${projectId}/tasks/${runId}`
  - `request(c: Cockpit, method, path, body?, opts?: { timeoutMs?: number }): Promise<{ status: number; data: unknown }>` — bounded body (3 MiB), `redirect: 'error'`, `AbortSignal.timeout`, JSON or text; transport failure → `TaskCliError(2, { code: 'unavailable', error })`.
  - `refuse(status, data): never` → `TaskCliError(2, { code: 'refused', status, error: data.error ?? … })`.
  - `discoverCockpit(opts: { url?: string; repoDir: string; ports?: number[]; timeoutMs?: number }): Promise<Cockpit>`; `checkoutRoot(dir: string): Promise<string>`.

- [ ] Step 1: failing tests using real `node:http` servers on port 0 serving `/api/v1/health` (via `healthResponseSchema`-valid fixture) and `/api/v1/projects`:
  - matches the cockpit whose project `root` equals the repo root; returns that project's id;
  - two cockpits, the one serving another repo is skipped;
  - `repoDir` inside a `git worktree add` of the repo resolves to the main checkout's project;
  - no match → `TaskCliError` exit 2 with `code: 'no-cockpit'` and a `hint` naming the root;
  - `url` with no root match → boot project id from `/projects.bootProject`.
- [ ] Step 2: run → FAIL.
- [ ] Step 3: implement. `checkoutRoot` runs `git -C dir rev-parse --path-format=absolute --git-common-dir` (execFile, never throws: falls back to `realpath(dir)`), takes `dirname` when it ends in `.git`, then `realpath`. Discovery probes all ports with `Promise.all`, validates with `healthResponseSchema.safeParse`, then `projectsResponseSchema.safeParse` of `/api/v1/projects`, picks the lowest port whose project root (realpath) equals the checkout root.
- [ ] Step 4: tests pass.
- [ ] Step 5: commit `feat(cli): discover the cockpit serving this checkout (#504)`.

### Task 4: `cez task` commands (start, list, status, open, stop, finish, diff, send)

**Files:**
- Create: `packages/cezar/src/task-cli/projections.ts`, `packages/cezar/src/task-cli/cli.ts`
- Test: `packages/cezar/src/task-cli/cli.test.ts`, `packages/cezar/src/task-cli/projections.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces: `runTaskCommand(argv: string[], env: NodeJS.ProcessEnv, io?: { stdout(line: string): void; stdin?: () => Promise<string>; discover?: typeof discoverCockpit }): Promise<number>`; `projectStatus(run: ApiRun, url: string, question?: unknown)`, `projectListRow(run: ApiRun)`.

- [ ] Step 1: failing tests. The harness serves a `createApp` (real `RunStore`, real `RunManager` with `maxParallel: 0`, `connectedProviderAuth()`) through `@hono/node-server` on port 0 and injects `discover` returning that origin with project `default`:
  - `start 'do x'` → exit 0, JSON `{ id, url, status: 'queued', created: true }`; store has the run;
  - `start --request-id <uuid> 'do x'` twice → second `created: false`, same id;
  - same id, different task → exit 2, `error: 'request id payload conflict'`;
  - `start --task-file -` with stdin `'multi\n"quoted"'` → run `task` equals it; empty stdin → exit 64;
  - `status <id>` → only the slim keys; `--full` → `apiRunSchema` parses it;
  - `status bogus` → exit 2, `error: 'not found'`;
  - `list` excludes archived unless `--all`; `--status queued` filters; `--limit 1`;
  - `send <id> 'hi'` on a queued run → `{ delivery: 'queued' }` exit 0;
  - `send` on a `done` run → `{ delivery: 'not-delivered', reason: 'session closed', next }` exit 1; with `--resume` → `{ delivery: 'resumed' }` exit 0 (dry-run continue);
  - `stop <id>` → `{ cancelled: true }`; `finish` on a queued run → exit 2 with the server's reason verbatim;
  - `open <id> --no-open` → `{ url }`;
  - unknown op / unknown flag → exit 64 `{ code: 'invalid_input', error, usage }`; `--help` and `start --help` print text, exit 0, and never call `discover`.
- [ ] Step 2: run → FAIL.
- [ ] Step 3: implement. Parse with `node:util` `parseArgs` per op (strict). `start` body: `{ task, workflow ?? 'quick-task', runner, model, effort, autonomous, worktree: noWorktree ? false : undefined, clientRequestId: requestId ?? randomUUID() }`; `created` = `status === 201`. `send` ladder: `/messages` → map `delivered|queued|deferred`; `409` whose `error === 'session closed'` → not-delivered or, with `--resume`, `/continue { text }`. `diff --stat` → `/changes` summarised to `{ files: [{ path, additions, deletions }], additions, deletions }`; otherwise `/diff` text as `{ diff }`. `status.question` from `/history-context` `contextEvents` last `ask.requested` when `hasPendingHumanAsk`.
- [ ] Step 4: tests pass.
- [ ] Step 5: commit `feat(cli): add cez task start/status/list/send/stop/finish/diff/open (#504)`.

### Task 5: `wait`, `log`, `log --follow`, `start --wait`

**Files:**
- Modify: `packages/cezar/src/task-cli/cli.ts`
- Create: `packages/cezar/src/task-cli/watch.ts`
- Test: `packages/cezar/src/task-cli/watch.test.ts`

**Interfaces:**
- Produces: `waitForRuns(c, ids, { mode: 'any' | 'all'; until: 'settled' | 'attention'; timeoutMs; pollMs? }): Promise<{ exitCode: number; runs: Array<{ id; status; activity?; hasPendingHumanAsk? } | { id; status: 'missing' }>; timedOut: boolean }>`; `followLog(c, id, { sinceSeq, maxChars, timeoutMs, print }): Promise<number>`; `logLine(event): object | undefined`.

- [ ] Step 1: failing tests: `wait` exits 0 after the store flips a run to `review`, 1 on `failed`, 3 on timeout with statuses printed; `--mode any` returns on the first settled; `--until attention` stops on `waiting`; a deleted run → `missing`, exit 1; `log` prints only the six event kinds, newest last, bounded by `--max-chars`; `log --follow` against a fake SSE server exits 0 on a terminal `run` frame and 3 at the timeout, deduping repeated `seq`.
- [ ] Step 2: run → FAIL.
- [ ] Step 3: implement. Polling via `GET /runs` every `pollMs` (1500). SSE: `fetch` the stream, split on blank lines, parse `event:`/`data:`, abort at deadline. Exit code per spec table.
- [ ] Step 4: tests pass.
- [ ] Step 5: commit `feat(cli): wait for and follow cez task runs (#504)`.

### Task 6: Wiring, docs, `cez run` hint

**Files:**
- Modify: `packages/cezar/src/index.ts` (dispatch before `parseArgs`, HELP line, `run` hint)
- Modify: `.env.example`, `README.md`, `BACKWARD_COMPATIBILITY.md` if not done in Task 2

- [ ] Step 1: dispatch `if (process.argv[2] === 'task') { const { runTaskCommand } = await import('./task-cli/cli.ts'); process.exitCode = await runTaskCommand(process.argv.slice(3), process.env); return; }`; HELP gains `  cez task                  start/watch/steer cockpit tasks from the terminal (see: task --help)`.
- [ ] Step 2: in the `run` case, before executing, `discoverCockpit({ repoDir: repoRoot, timeoutMs: 300 }).then(c => console.error(`a cockpit is running at ${c.origin}; use "cez task start" to run this task there instead`)).catch(() => {})`, awaited with a 500 ms cap so it never blocks.
- [ ] Step 3: `.env.example`: `CEZ_URL` entry; README env table row and a "From the terminal" section.
- [ ] Step 4: `npm run typecheck && npm test` green.
- [ ] Step 5: commit `feat(cli): wire cez task into the CLI and document CEZ_URL (#504)`.

### Task 7: Packaged e2e

**Files:**
- Create: `packages/cezar/test/e2e/task-cli.test.ts` (pattern: `packages/cezar/test/e2e/delegation.test.ts` / `package-cli.test.ts`)

- [ ] Step 1: test boots the installed tarball's `cez --no-open --port <free>` with `CEZ_DRY_RUN=1`, `CEZ_HOME` sandbox, in a temp git repo; waits for health; runs `cez task start 'e2e' --wait --timeout-seconds 120` → exit 0, `status` in `done|review`; `cez task status <id>` → slim JSON; `GET /api/v1/runs` contains the id; `cez task send <id> 'again' --resume` → exit 0; `cez task stop <id>` → exit 0; with the server killed, `cez task list` → exit 2 `no-cockpit`.
- [ ] Step 2: `npm run build && TMPDIR=/tmp npm run test:package` green.
- [ ] Step 3: commit `test(e2e): drive cez task against a dry-run cockpit (#504)`.
