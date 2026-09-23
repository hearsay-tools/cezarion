# Immediate Worker Delivery and Parent-Routed Questions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Submit parent/worker messages through each harness's native steering the moment they are accepted, record harness acceptance and model consumption separately, and route worker questions to the owning parent.

**Architecture:** Each runner declares an `inputDelivery` mode and reports per-input consumption through a new session callback; `RunManager` stops gating on turn boundaries, records `consumedAt`, resubmits inputs a finished turn never consumed, and replays delivered-but-unconsumed inputs after a crash. PR B turns a worker's native or `CEZ:ASK` question into a worker → parent conversation request whose correlated reply is fed into the worker's answer seam.

**Tech Stack:** TypeScript (ESM, Node ≥20), zod contract in `packages/contract`, Hono server, vitest, offline mock CLIs in `packages/cezar/scripts/mock-*.mjs`, React 19 cockpit.

**Spec:** `.ai/specs/2026-09-23-immediate-worker-delivery.md`

## Global Constraints

- No new dependency, no new `CEZ_*` flag, no configuration knob; every change is on by default (AGENTS.md § Zero config).
- Every new record field is optional so old `runs.json` / NDJSON parse (`runs/store.ts` rule; BACKWARD_COMPATIBILITY.md §7 append-only events).
- Every API shape is a zod schema in `packages/contract` with an inferred type; `contract-parity*.test.ts` must stay green.
- Batch bounds stay 32 inputs and 100,000 formatted characters; a single message is never split; lifecycle inputs remain barriers; CI wakes own their turn.
- No tool interruption for routine messages. Never map cezar's `follow-up` kind to Pi's `followUp`.
- Deadlines are never extended. Consumption is never inferred from an HTTP/RPC/pipe acknowledgement.
- Both turn-end handlers (`runAgentStep` ~`workflows/run.ts:5232`, `runContinuation` ~`:4290`) and both `startSession` sites (`:4569`, `:5404`) change together, through shared helpers.
- Every new regression test is proven red against the old code: `git stash push -m "cez505-<task>" -- <source files>`, run the test, confirm FAIL, `git stash apply <sha>`, drop that entry by tag. Never bare `git stash`/`pop`.
- Run vitest through npm only: `npm test -- <path>`, never `npx vitest`.
- Commits: Conventional Commits, body `Refs #505` (PR A) or `Closes #505` (last PR B commit), trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `CLAUDE.md` is a symlink to `AGENTS.md`; edit `AGENTS.md` if it needs a change.

## Review Focus

1. **A message accepted in the last model call of a turn** (steer lands after the final assistant message) — the user expects it still reaches the model, never silently dropped: pinned by Task A3/A4/A5 `steer-late` tests and Task A9.
2. **A burst of 40 messages while a 30-minute tool runs** — expected: two submissions in FIFO order (32 + 8), none lost, none duplicated: Task A8 burst test.
3. **Restart while a steered message is accepted but unconsumed** — expected: it is replayed once after restart and marked consumed once read: Task A10.
4. **A human answers the parent while three worker messages wait** — expected: the answer is read first, the messages right behind it, and no message is taken as the answer: Task A11.
5. **A worker asks while its parent is itself waiting on the human** — expected: the worker question is held, then reaches the parent right after the human answers; the parent's answer, not the human's, unblocks the worker: Task B4.

## File map

| File | Change |
| --- | --- |
| `packages/contract/src/delegation.ts` | `agentInputSchema.consumedAt` |
| `packages/contract/src/conversations.ts` | `delivery: 'consumed'`; PR B: `question`, `human-fallback` |
| `packages/contract/src/events.ts` | `conversation-message` `consumed`; PR B: routed/fallback events, `human-input-delivered.source` |
| `packages/cezar/src/core/agent-runner.ts` | `InputDelivery`, `sendAgentMessage(content, inputIds)`, `onAgentInputConsumed`, `turn-end.unconsumedInputIds`, `inputDeliveryOf` |
| `packages/cezar/src/core/{claude-cli,codex-app-server,pi,opencode-server,cursor-acp}-runner.ts` | Native steering + consumption per spec table |
| `packages/cezar/src/core/input-submissions.ts` (new) | Shared per-session submission ledger (accepted → consumed / unconsumed) used by every steer runner |
| `packages/cezar/scripts/mock-{claude,codex-app-server,pi-rpc,opencode-serve}.mjs` | `mock:steer-tool`, `mock:steer-late` scenarios with native consumption signals |
| `packages/cezar/src/core/harness-parity.test.ts` + `.testkit.ts` | `inputDelivery` rows, Cursor exemption |
| `packages/cezar/src/runs/store.ts` | `commitAgentInputsConsumed`, `requeueUnconsumedAgentInputs` |
| `packages/cezar/src/workflows/run.ts` | Gate removal, consumption wiring, unconsumed requeue, crash replay, human-answer bundling; PR B routing |
| `packages/cezar/src/delegation/service.ts` | Receipt `consumed`; PR B question replies |
| `packages/cezar/src/delegation/questions.ts` (new, PR B) | Question message + text formatting, reply matching |
| `packages/cezar/src/delegation/provision.ts` | Instruction text |
| `packages/web/src/routes/task-thread/{thread-state.ts,ask-card.tsx}` | Consumed label; PR B routed card |
| `AGENT_PROTOCOL.md` | `inputDelivery` contract and per-backend signals |
| `.ai/scripts/probe-steering.ts` (new) | Manual paid real-harness probe; never in CI, never packed |

---

# PR A — Immediate delivery

### Task A1: Seam types and the `consumedAt` field

**Files:**
- Modify: `packages/contract/src/delegation.ts:219-229`
- Modify: `packages/cezar/src/core/agent-runner.ts` (AgentEvent `turn-end`, `SessionOptions`, `AgentSession.sendAgentMessage`, `AgentRunner`)
- Create: `packages/cezar/src/core/input-submissions.ts`
- Test: `packages/cezar/src/core/input-submissions.test.ts`, `packages/cezar/src/runs/store.test.ts` (add one case)

**Interfaces:**
- Produces:
  - `agentInputSchema.consumedAt?: string (iso datetime)`
  - `type InputDelivery = { readonly mode: 'steer' | 'boundary'; readonly consumption: 'observable' | 'unobservable'; readonly via: string }`
  - `AgentRunner.inputDelivery?: InputDelivery`; `inputDeliveryOf(runner: AgentRunner): InputDelivery` (absent → `BOUNDARY_INPUT_DELIVERY`)
  - `AgentSession.sendAgentMessage(content: ContentBlock[], inputIds?: readonly string[]): false | Promise<void>`
  - `SessionOptions.onAgentInputConsumed?: (inputIds: readonly string[]) => void`
  - AgentEvent `{ type: 'turn-end'; unconsumedInputIds?: readonly string[] }`
  - `class InputSubmissions { accept(submissionId: string, inputIds: readonly string[], text: string): void; consume(submissionId: string): readonly string[]; consumeOldestByText(text: string): readonly string[]; takeUnconsumed(): readonly string[]; readonly pending: number }`

- [ ] **Step 1: Write the failing ledger test**

```ts
// packages/cezar/src/core/input-submissions.test.ts
import { describe, expect, it } from 'vitest';
import { InputSubmissions } from './input-submissions.ts';

describe('InputSubmissions', () => {
  it('consumes once by submission id and reports the rest as unconsumed', () => {
    const ledger = new InputSubmissions();
    ledger.accept('s1', ['a', 'b'], 'batch one');
    ledger.accept('s2', ['c'], 'batch two');
    expect(ledger.consume('s1')).toEqual(['a', 'b']);
    expect(ledger.consume('s1')).toEqual([]);
    expect(ledger.takeUnconsumed()).toEqual(['c']);
    expect(ledger.pending).toBe(0);
  });
  it('matches the oldest pending submission with identical text', () => {
    const ledger = new InputSubmissions();
    ledger.accept('s1', ['a'], 'same'); ledger.accept('s2', ['b'], 'same');
    expect(ledger.consumeOldestByText('same')).toEqual(['a']);
    expect(ledger.consumeOldestByText('other')).toEqual([]);
    expect(ledger.takeUnconsumed()).toEqual(['b']);
  });
  it('ignores a submission without input ids', () => {
    const ledger = new InputSubmissions();
    ledger.accept('s1', [], 'nudge');
    expect(ledger.pending).toBe(0);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (module missing)**

Run: `npm test -- packages/cezar/src/core/input-submissions.test.ts`
Expected: FAIL `Cannot find module './input-submissions.ts'`

- [ ] **Step 3: Implement the ledger and seam types**

```ts
// packages/cezar/src/core/input-submissions.ts
/** Accepted agent input whose model consumption has not been observed yet.
 * One instance per session; FIFO so text matching takes the oldest first. */
export class InputSubmissions {
  private readonly entries: { id: string; inputIds: readonly string[]; text: string }[] = [];
  get pending(): number { return this.entries.length; }
  accept(submissionId: string, inputIds: readonly string[], text: string): void {
    if (inputIds.length) this.entries.push({ id: submissionId, inputIds: [...inputIds], text });
  }
  consume(submissionId: string): readonly string[] {
    const at = this.entries.findIndex(entry => entry.id === submissionId);
    return at < 0 ? [] : this.entries.splice(at, 1)[0]!.inputIds;
  }
  consumeOldestByText(text: string): readonly string[] {
    const at = this.entries.findIndex(entry => entry.text === text);
    return at < 0 ? [] : this.entries.splice(at, 1)[0]!.inputIds;
  }
  takeUnconsumed(): readonly string[] {
    return this.entries.splice(0).flatMap(entry => entry.inputIds);
  }
}
```

In `agent-runner.ts`:

```ts
/** How a runner admits non-human input while a turn runs (#505). */
export interface InputDelivery {
  /** `steer`: accepted mid-turn, consumed inside the running turn. `boundary`: refused while busy. */
  readonly mode: 'steer' | 'boundary';
  /** Whether the wire tells us when the model actually received the input. */
  readonly consumption: 'observable' | 'unobservable';
  /** The native mechanism, for AGENT_PROTOCOL.md and the parity matrix. */
  readonly via: string;
}
export const BOUNDARY_INPUT_DELIVERY: InputDelivery = { mode: 'boundary', consumption: 'unobservable', via: 'next idle turn' };
/** Absent means the pre-#505 behavior every runner had. */
export function inputDeliveryOf(runner: Pick<AgentRunner, 'inputDelivery'>): InputDelivery {
  return runner.inputDelivery ?? BOUNDARY_INPUT_DELIVERY;
}
```

Change the `turn-end` member of `AgentEvent` to `| { type: 'turn-end'; unconsumedInputIds?: readonly string[] }`, add to `SessionOptions`:

```ts
  /** The model received these inputs (replay echo, userMessage item, …). Fires at most
   * once per ID and never from a transport acknowledgement (#505). */
  onAgentInputConsumed?: (inputIds: readonly string[]) => void;
```

change the session signature and doc:

```ts
  /** Synchronous non-human reservation: false refuses without writing; a Promise
   * confirms the HARNESS ACCEPTED the input — mid-turn on a `steer` runner — not that
   * the model consumed it (#505). Reject retains caller ownership for replay.
   * `inputIds` correlate `onAgentInputConsumed` and `turn-end.unconsumedInputIds`.
   * Never fall back to the human-answer seam. */
  sendAgentMessage(content: ContentBlock[], inputIds?: readonly string[]): false | Promise<void>;
```

and to `AgentRunner`: `readonly inputDelivery?: InputDelivery;`.

In `packages/contract/src/delegation.ts` add after `deliveredAt`:

```ts
  /** The model received it, when the harness can show that (#505). Absent on
   * unobservable backends and on records written before #505. */
  consumedAt: z.iso.datetime().optional(),
```

- [ ] **Step 4: Add the store parse case**

In `packages/cezar/src/runs/store.test.ts` add a case that writes a `runs.json` whose run has `agentInputs: [{ …, deliveredAt }]` (no `consumedAt`) and one with `consumedAt`, loads a fresh `RunStore`, and expects both to round-trip unchanged (`toEqual`). Copy the file-writing pattern of the nearest existing "old file still parses" case in that test file.

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm test -- packages/cezar/src/core/input-submissions.test.ts packages/cezar/src/runs/store.test.ts && npm run typecheck`
Expected: PASS. Existing runners still compile because `inputIds` is optional.

- [ ] **Step 6: Commit**

```bash
git add packages/contract/src/delegation.ts packages/cezar/src/core/agent-runner.ts packages/cezar/src/core/input-submissions.ts packages/cezar/src/core/input-submissions.test.ts packages/cezar/src/runs/store.test.ts
git commit -m "feat(runners): declare input delivery and consumption seam" -m "Refs #505" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A2: Claude — steer on stdin, consume on replay

**Files:**
- Modify: `packages/cezar/src/core/claude-cli-runner.ts:150-200` (sendMessage), `:255-320` (stdout loop), `:374-395` (sendAgentMessage), `buildClaudeArgs` (~`:418`)
- Modify: `packages/cezar/scripts/mock-claude.mjs` (replay + `mock:steer-tool`)
- Test: `packages/cezar/src/core/claude-cli-runner.test.ts`

**Interfaces:**
- Consumes: `InputSubmissions`, `InputDelivery` (Task A1)
- Produces: `ClaudeCliRunner.inputDelivery = { mode: 'steer', consumption: 'observable', via: 'stream-json stdin line with uuid; --replay-user-messages echo' }`

Behavior to implement (from the probe, Claude 2.1.280):
- Every stdin line carries `uuid: randomUUID()`. Keep `unsettled = new Set<string>()` of written uuids; a `result` removes every uuid in `result.user_message_uuids`, or — when the field is absent (older CLI) — the oldest one. `agentInputReady = unsettled.size === 0`. This replaces `pendingPromptTurns`.
- `claudeTurnStarted` is emitted only when `unsettled` was empty before the write (a mid-turn line joins the running turn; today it emits a phantom `turn_2`).
- `turnTextStart`/`pendingMarkerAsk` reset only when the write opens a new turn.
- A stdout `{ type: 'user', isReplay: true, uuid }` frame calls `opts.onAgentInputConsumed(submissions.consume(uuid))` when non-empty, and is otherwise ignored by both mappers (it has no `tool_result`).
- `sendAgentMessage` refuses only when `!stdinOpen || pendingMarkerAsk || agentWritePending`; it is allowed while a turn runs.
- `buildClaudeArgs` appends `--replay-user-messages`.
- Claude reports no `unconsumedInputIds`: a line written after the last model call produces its own following `result` (probe: `queued_turn_count`).

- [ ] **Step 1: Add the mock scenario**

In `mock-claude.mjs`: parse `msg.uuid` in the line handler. Add a module-level `let steering = null` (an array while a `mock:steer-tool` turn is inside its tool). In the line handler, before `queue = queue.then(...)`:

```js
  if (steering) { steering.push({ userText, uuid }); return; }
```

When `process.argv.includes('--replay-user-messages')`, `respond` first emits `{ type: 'user', isReplay: true, uuid, message: { role: 'user', content: [{ type: 'text', text: userText }] } }` for the prompt it is answering. Add the scenario at the top of `respond`:

```js
  if (userText.includes('mock:steer-tool')) {
    steering = [];
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_steer', name: 'Bash', input: { command: 'wait' } }] } });
    await sleep(Number(process.env.CEZ_MOCK_STEER_MS ?? 600));
    const steered = steering; steering = null;
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_steer', content: 'waited' }] } });
    for (const s of steered) if (replay) emit({ type: 'user', isReplay: true, uuid: s.uuid, message: { role: 'user', content: [{ type: 'text', text: s.userText }] } });
    const text = ['steer tool done', ...steered.map(s => `saw: ${s.userText}`)].join('\n');
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
    emit({ type: 'result', subtype: 'success', result: text, user_message_uuids: [uuid, ...steered.map(s => s.uuid)], usage: { input_tokens: 20, output_tokens: 10 } });
    return;
  }
```

(`respond` gains a `uuid` parameter; `replay` is the argv check.) Lines arriving after `steering = null` queue as ordinary turns — the late-write case.

- [ ] **Step 2: Write the failing runner tests**

In `claude-cli-runner.test.ts`, using the file's existing mock-binary harness (`CEZ_CLAUDE_BIN` pointed at `scripts/mock-claude.mjs`, as its other session tests do):

```ts
it('steers agent input into the running turn and reports consumption by uuid (#505)', async () => {
  const consumed: string[][] = []; const events: AgentEvent[] = []; const ui: UiEvent[] = [];
  const session = new ClaudeCliRunner().startSession({ userPrompt: 'mock:steer-tool', cwd, sessionId: randomUUID(), timeoutMs: 30_000 },
    event => events.push(event), { onAgentInputConsumed: ids => consumed.push([...ids]), onUiEvent: event => ui.push(event) });
  await waitFor(() => events.some(e => e.type === 'tool-call'));
  const ack = session.sendAgentMessage([{ type: 'text', text: 'mid-turn update' }], ['in-1']);
  expect(ack).not.toBe(false);
  await ack;
  expect(consumed).toEqual([]); // the pipe write is not consumption
  await waitFor(() => events.some(e => e.type === 'turn-end'));
  expect(consumed).toEqual([['in-1']]);
  expect(events.filter(e => e.type === 'turn-end')).toHaveLength(1);
  expect(ui.filter(e => e.type === 'turn.started')).toHaveLength(1);
  expect(events.some(e => e.type === 'text' && e.text.includes('saw: mid-turn update'))).toBe(true);
  // One result settled both writes, so the runner is idle again.
  expect(session.sendAgentMessage([{ type: 'text', text: 'next' }], ['in-2'])).not.toBe(false);
  session.end(); await session.result;
});

it('keeps accepting agent input after a human follow-up merged into the turn (#505)', async () => {
  // Pre-#505 pendingPromptTurns counted 2 here and agentInputReady stayed false.
  const events: AgentEvent[] = [];
  const session = new ClaudeCliRunner().startSession({ userPrompt: 'mock:steer-tool', cwd, sessionId: randomUUID(), timeoutMs: 30_000 }, e => events.push(e));
  await waitFor(() => events.some(e => e.type === 'tool-call'));
  expect(session.sendMessage([{ type: 'text', text: 'human follow-up' }])).toBe(true);
  await waitFor(() => events.some(e => e.type === 'turn-end'));
  expect(session.sendAgentMessage([{ type: 'text', text: 'after' }], ['in-3'])).not.toBe(false);
  session.end(); await session.result;
});

it('passes --replay-user-messages', () => {
  expect(buildClaudeArgs({ userPrompt: 'x', cwd: '/tmp' }, {})).toContain('--replay-user-messages');
});
```

- [ ] **Step 3: Run — expect FAIL**

Run: `npm test -- packages/cezar/src/core/claude-cli-runner.test.ts -t "#505|replay-user-messages"`
Expected: FAIL — `sendAgentMessage` returns `false` mid-turn; no `--replay-user-messages`.

- [ ] **Step 4: Implement**

Replace `pendingPromptTurns` with the uuid set as described above. The core of the new write path:

```ts
    const unsettled = new Set<string>();
    const submissions = new InputSubmissions();
    const sendMessage = (content: ContentBlock[], acknowledge?: (error?: Error | null) => void, inputIds: readonly string[] = []): boolean => {
      if (!stdinOpen) return false;
      const opensTurn = unsettled.size === 0;
      agentInputReady = false;
      if (opensTurn) { pendingMarkerAsk = false; turnTextStart = textChunks.length; }
      if (autoEndTimer) { clearTimeout(autoEndTimer); autoEndTimer = undefined; }
      const uuid = randomUUID();
      const line = JSON.stringify({ type: 'user', uuid, message: { role: 'user', content }, session_id: spec.sessionId });
      try {
        child.stdin.write(`${line}\n`, acknowledge);
        unsettled.add(uuid);
        submissions.accept(uuid, inputIds, '');
        if (opensTurn) emitUi(claudeTurnStarted); // a mid-turn line joins the running turn (#505)
        return true;
      } catch (err) { /* unchanged note */ return false; }
    };
```

In the stdout loop, before `emitUi(...)`:

```ts
          if (msg.type === 'user' && (msg as { isReplay?: unknown }).isReplay === true) {
            const ids = typeof msg.uuid === 'string' ? submissions.consume(msg.uuid) : [];
            if (ids.length) opts.onAgentInputConsumed?.(ids);
            continue; // presentation-free: the user's own text, echoed at consumption
          }
```

In the `result` branch replace the counter:

```ts
            const settledIds = Array.isArray(msg.user_message_uuids) ? msg.user_message_uuids : [unsettled.values().next().value];
            for (const id of settledIds) if (typeof id === 'string') unsettled.delete(id);
            agentInputReady = unsettled.size === 0;
```

`sendAgentMessage` drops the `!agentInputReady` guard and passes `inputIds` through: `sendMessage(content, callback, inputIds)`. Declare `readonly inputDelivery: InputDelivery = CLAUDE_INPUT_DELIVERY` on the runner. Extend `ClaudeStreamMessage` with optional `uuid`, `isReplay`, `user_message_uuids`.

- [ ] **Step 5: Prove red without the fix, then green**

```bash
git stash push -m "cez505-A2" -- packages/cezar/src/core/claude-cli-runner.ts
npm test -- packages/cezar/src/core/claude-cli-runner.test.ts -t "#505|replay-user-messages"   # expect FAIL
SHA=$(git stash list --format='%H %gs' | awk '/cez505-A2/{print $1; exit}'); git stash apply "$SHA"
git stash drop "$(git stash list --format='%gd %gs' | awk '/cez505-A2/{print $1; exit}')"
npm test -- packages/cezar/src/core/claude-cli-runner.test.ts packages/cezar/src/core/claude-ui-mapper.test.ts   # expect PASS
```

- [ ] **Step 6: Commit**

```bash
git add packages/cezar/src/core/claude-cli-runner.ts packages/cezar/src/core/claude-cli-runner.test.ts packages/cezar/scripts/mock-claude.mjs
git commit -m "feat(claude): steer agent input mid-turn and observe consumption" -m "Refs #505" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A3: Codex — `turn/steer` with `clientUserMessageId`

**Files:**
- Modify: `packages/cezar/src/core/codex-app-server-runner.ts:348-366` (sendAgentMessage), `:530-553` (startOrSteerTurn), `:602-680` (handleNotification)
- Modify: `packages/cezar/scripts/mock-codex-app-server.mjs` (`turn/steer`, `mock:steer-tool`, `mock:steer-late`)
- Test: `packages/cezar/src/core/codex-app-server-runner.test.ts`

**Interfaces:**
- Produces: `CodexAppServerRunner.inputDelivery = { mode: 'steer', consumption: 'observable', via: 'turn/steer clientUserMessageId; item/started userMessage clientId' }`

Behavior:
- `sendAgentMessage(content, inputIds)` refuses only when `!open || pendingUserInput || agentSubmissionPending`. It creates `submissionId = randomUUID()`, records it in an `InputSubmissions`, and calls `startOrSteerTurn(text, submissionId)`.
- `startOrSteerTurn` sends `clientUserMessageId: submissionId` on both `turn/steer` and `turn/start`. When a `turn/steer` rejects with a JSON-RPC **error response** and `turnBoundaryVersion` advanced since the request was sent (the turn ended under us — definitive), it retries once as `turn/start`. A timeout, a closed transport, or an error with no boundary change rejects without retry.
- `item/started` with `item.type === 'userMessage'` and a string `item.clientId` calls `onAgentInputConsumed(submissions.consume(clientId))` when non-empty. The opening prompt carries no ids.
- On main-thread `turn/completed|failed`: `emit({ type: 'turn-end', unconsumedInputIds })` with `submissions.takeUnconsumed()` when non-empty.

- [ ] **Step 1: Extend the mock**

In `mock-codex-app-server.mjs` handle `turn/steer`: when a turn is active and `params.expectedTurnId` equals it, respond `{ id, result: {} }` and push `{ clientId: params.clientUserMessageId, text }` onto `steered`; otherwise respond `{ id, error: { code: -32600, message: 'no active turn matching expectedTurnId' } }`. `mock:steer-tool` emits `item/started` for a `commandExecution`, waits `CEZ_MOCK_STEER_MS` (default 600), emits its `item/completed`, then for each steered entry `item/started` + `item/completed` `{ type: 'userMessage', id, clientId, content: [{ type: 'text', text }] }`, then an `agentMessage` echoing `saw: <text>`, then `turn/completed`. `mock:steer-late` accepts steers during a 300 ms window after its final `agentMessage`, then emits `turn/completed` without any `userMessage` item for them. Echo `clientUserMessageId` from `turn/start` as the opening `userMessage.clientId`.

- [ ] **Step 2: Write the failing tests**

```ts
it('steers agent input into the active turn and correlates consumption (#505)', async () => {
  const consumed: string[][] = []; const events: AgentEvent[] = [];
  const session = startMockSession('mock:steer-tool', events, { onAgentInputConsumed: ids => consumed.push([...ids]) });
  await waitFor(() => events.some(e => e.type === 'tool-call'));
  const ack = session.sendAgentMessage([{ type: 'text', text: 'mid-turn update' }], ['in-1']);
  expect(ack).not.toBe(false); await ack;
  expect(consumed).toEqual([]);
  await waitFor(() => events.some(e => e.type === 'turn-end'));
  expect(consumed).toEqual([['in-1']]);
  expect(events.filter(e => e.type === 'turn-end')).toEqual([{ type: 'turn-end' }]);
  session.end(); await session.result;
});

it('reports a steer the finished turn never consumed (#505)', async () => {
  const events: AgentEvent[] = [];
  const session = startMockSession('mock:steer-late', events);
  await waitFor(() => events.some(e => e.type === 'text'));
  await session.sendAgentMessage([{ type: 'text', text: 'too late' }], ['in-late']);
  await waitFor(() => events.some(e => e.type === 'turn-end'));
  expect(events.find(e => e.type === 'turn-end')).toEqual({ type: 'turn-end', unconsumedInputIds: ['in-late'] });
  session.end(); await session.result;
});

it('falls back to turn/start only when the steered turn ended first (#505)', async () => {
  // Drive: accept, then make the mock end the turn before answering turn/steer
  // (scenario mock:steer-race). Expect exactly one turn/start with the same clientUserMessageId.
});
```

Write the third test concretely against a `mock:steer-race` branch in the mock: on `turn/steer` it first emits `turn/completed`, then answers the steer with the mismatch error; the test asserts the mock's `CEZ_MOCK_ARGS_FILE`-style request log (add `CEZ_MOCK_RPC_LOG=<path>` appending each request method + params) contains `turn/steer` then `turn/start` with the same `clientUserMessageId`, and that the ack resolves.

`startMockSession(prompt, events, opts?)` is a local helper in the test file wrapping `new CodexAppServerRunner().startSession({ userPrompt: prompt, cwd, timeoutMs: 30_000 }, e => events.push(e), opts)` with `CEZ_CODEX_BIN` set to the mock, following the file's existing setup.

- [ ] **Step 3: Run — expect FAIL**

Run: `npm test -- packages/cezar/src/core/codex-app-server-runner.test.ts -t "#505"`
Expected: FAIL — `sendAgentMessage` returns `false` while `agentInputReady` is false.

- [ ] **Step 4: Implement**

```ts
  private readonly submissions = new InputSubmissions();

  sendAgentMessage(content: ContentBlock[], inputIds: readonly string[] = []): false | Promise<void> {
    if (!this.open || this.pendingUserInput || this.agentSubmissionPending) return false;
    this.agentInputReady = false;
    this.agentSubmissionPending = true;
    if (this.autoEndTimer) clearTimeout(this.autoEndTimer);
    this.autoEndTimer = undefined;
    const submissionId = randomUUID();
    this.submissions.accept(submissionId, inputIds, '');
    return this.startOrSteerTurn(textOf(content), submissionId).catch((err: unknown) => {
      this.submissions.consume(submissionId); // not accepted: caller keeps ownership
      if (this.stdinOpen) this.emit({ type: 'error', message: `codex: agent input failed: ${String(err)}` });
      throw err;
    }).finally(() => { /* unchanged readiness/auto-end block */ });
  }

  private async startOrSteerTurn(text: string, clientUserMessageId?: string): Promise<void> {
    this.assertOpen();
    if (!this.threadId) throw new Error('codex app-server did not return a thread id');
    this.agentInputReady = false;
    const input = [{ type: 'text', text, text_elements: [] }];
    const ids = clientUserMessageId ? { clientUserMessageId } : {};
    if (this.activeTurnId) {
      const boundary = this.turnBoundaryVersion;
      try {
        await this.rpc.request('turn/steer', { threadId: this.threadId, input, expectedTurnId: this.activeTurnId, ...ids });
        return;
      } catch (err) {
        // Definitive only: the server answered with an error AND the turn ended meanwhile.
        if (!isRpcErrorResponse(err) || this.turnBoundaryVersion === boundary || this.activeTurnId) throw err;
      }
    }
    const boundaryVersion = this.turnBoundaryVersion;
    const res = await this.rpc.request('turn/start', { threadId: this.threadId, input, ...ids, ...codexTurnStartExtras(this.spec) });
    if (this.turnBoundaryVersion === boundaryVersion) this.activeTurnId = turnIdOf(res) ?? this.activeTurnId;
  }
```

`isRpcErrorResponse(err)` checks the error type the existing JSON-RPC client throws for an `{ error }` response (read `codex-rpc` / the `rpc.request` implementation and use its class or a `code` field; never match on a timeout or close error). Human `sendMessage` keeps calling `startOrSteerTurn(text)` with no id. In `handleNotification` `item/started`:

```ts
        if (type === 'userMessage' && !this.isForeignThreadTurn(params)) {
          const clientId = stringField(item, 'clientId');
          const ids = clientId ? this.submissions.consume(clientId) : [];
          if (ids.length) this.opts.onAgentInputConsumed?.(ids);
        }
```

In `turn/completed|failed` replace `this.emit({ type: 'turn-end' })` with:

```ts
        const unconsumedInputIds = this.submissions.takeUnconsumed();
        this.emit(unconsumedInputIds.length ? { type: 'turn-end', unconsumedInputIds } : { type: 'turn-end' });
```

An in-flight steer (still `agentSubmissionPending`) at turn completion stays in the ledger: its RPC outcome decides. Move `takeUnconsumed` to exclude the in-flight submission id (`this.inFlightSubmissionId`) so the race fallback owns it.

- [ ] **Step 5: Prove red, then green**

Stash `codex-app-server-runner.ts` as in Task A2 Step 5 (tag `cez505-A3`), confirm the three `#505` tests FAIL, restore, then run `npm test -- packages/cezar/src/core/codex-app-server-runner.test.ts packages/cezar/src/core/codex-ui-mapper.test.ts` — PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cezar/src/core/codex-app-server-runner.ts packages/cezar/src/core/codex-app-server-runner.test.ts packages/cezar/scripts/mock-codex-app-server.mjs
git commit -m "feat(codex): steer agent input with clientUserMessageId" -m "Refs #505" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A4: Pi — native steer, consumption by text

**Files:**
- Modify: `packages/cezar/src/core/pi-runner.ts:165-215` (sendMessage), `:300-365` (event loop), `:409-417` (sendAgentMessage)
- Modify: `packages/cezar/scripts/mock-pi-rpc.mjs` (`mock:steer-tool`, `mock:steer-late`)
- Test: `packages/cezar/src/core/pi-runner.test.ts`

**Interfaces:**
- Produces: `PiRunner.inputDelivery = { mode: 'steer', consumption: 'observable', via: 'prompt streamingBehavior steer; user message_start text' }`

Behavior:
- `sendAgentMessage` refuses only when `!open || pendingMarkerAsk || agentAck || humanPromptAcks`; busy is allowed. It records `submissions.accept(id, inputIds, message)` where `message` is the exact `toPiPrompt(content).message` sent.
- `sendMessage` resets `turnTextStart`/`pendingMarkerAsk` only when `!piUi.turnId` (a steer joins the turn).
- `message_start` with `message.role === 'user'`: take its text (join the `text` content parts, or `message.content` when a string) and call `onAgentInputConsumed(submissions.consumeOldestByText(text))` when non-empty.
- `agent_settled`: emit `turn-end` with `unconsumedInputIds: submissions.takeUnconsumed()` when non-empty.

- [ ] **Step 1: Extend the mock** — `mock:steer-tool`: `tool_execution_start`, wait `CEZ_MOCK_STEER_MS`, `tool_execution_end`, then for each `prompt` received with `streamingBehavior: 'steer'` during the wait emit `message_start` `{ role: 'user', content: [{ type: 'text', text }] }` and `message_end`, then assistant text `saw: <text>`, then `agent_settled`. `mock:steer-late`: accept steers for 300 ms after the final assistant message, then `agent_settled` with no user `message_start`.

- [ ] **Step 2: Write the failing tests** — same shape as Task A3's first two tests, with `new PiRunner()` and `CEZ_PI_BIN` pointed at the mock, asserting `consumed` is `[['in-1']]` after `turn-end` and `unconsumedInputIds: ['in-late']` for `mock:steer-late`. Add:

```ts
it('never maps a cezar follow-up to Pi followUp (#505)', async () => {
  // CEZ_MOCK_STDIN_FILE captures every RPC command the mock received.
  // After a busy sendAgentMessage, the captured prompt must carry streamingBehavior 'steer'
  // and no command of type 'follow_up' may appear.
});
```

Implement that third test concretely with the mock's stdin capture file (add `CEZ_MOCK_STDIN_FILE` support to `mock-pi-rpc.mjs` mirroring `mock-claude.mjs`).

- [ ] **Step 3: Run — expect FAIL** (`npm test -- packages/cezar/src/core/pi-runner.test.ts -t "#505"`; busy `sendAgentMessage` returns `false`).

- [ ] **Step 4: Implement** as described; the user-message branch:

```ts
          } else if (value.type === 'message_start' && isRecord(value.message) && value.message.role === 'user') {
            const ids = submissions.consumeOldestByText(piMessageText(value.message));
            if (ids.length) opts.onAgentInputConsumed?.(ids);
```

with `piMessageText(message)` returning `message.content` when a string, else the `\n`-joined `text` of `type: 'text'` parts. In `agent_settled`:

```ts
            const unconsumedInputIds = submissions.takeUnconsumed();
            onEvent?.(unconsumedInputIds.length ? { type: 'turn-end', unconsumedInputIds } : { type: 'turn-end' });
```

- [ ] **Step 5: Prove red (stash `pi-runner.ts`, tag `cez505-A4`), then green** — `npm test -- packages/cezar/src/core/pi-runner.test.ts packages/cezar/src/core/pi-ui-mapper.test.ts`.

- [ ] **Step 6: Commit** — `feat(pi): steer agent input and observe user message start`.

### Task A5: OpenCode V1 — busy `prompt_async`, consumption by `parentID`

**Files:**
- Modify: `packages/cezar/src/core/opencode-server-runner.ts:298-313` (sendAgentMessage), `:484-552` (prompt), `:554-571` (finishTurn), `:704-730` (handleEvent)
- Modify: `packages/cezar/scripts/mock-opencode-serve.mjs`
- Test: `packages/cezar/src/core/opencode-server-runner.test.ts`

**Interfaces:**
- Produces: `OpencodeServerRunner.inputDelivery = { mode: 'steer', consumption: 'observable', via: 'prompt_async while busy; assistant message parentID' }`

Behavior (probe, OpenCode 1.18.32):
- Agent input POSTs `prompt_async` immediately even while `turnActive`. `prompt(text, 'agent', signal, inputIds)` skips the `while (this.turnActive) await this.turnFinished` wait and, when a turn is active, does not open a new turn (no `turnActive` reset, no `opencodeTurnStarted`). When idle it opens a turn as today. Human prompts keep the client-side wait (no change to human semantics in this issue).
- `sendAgentMessage` refuses only when `!serverOpen || pendingQuestion || questionReply || agentRequest`.
- Record `submissions.accept(submissionId, inputIds, text)`. A `message.part.updated` text part whose text equals a pending submission's text, on a `user` message (`msgRole`), maps `userMessageId → submissionId` (keep a `Map`). A `message.updated` for an `assistant` whose `parentID` is a mapped user message id calls `onAgentInputConsumed(submissions.consume(submissionId))`.
- `finishTurn` emits `turn-end` with `unconsumedInputIds: submissions.takeUnconsumed()` when non-empty — the upstream lost-wake case (opencode#46842).

- [ ] **Step 1: Extend the mock** — `mock:steer-tool`: on the opening prompt, emit a tool part, keep the turn open `CEZ_MOCK_STEER_MS`; every `prompt_async` POSTed meanwhile gets a `message.updated { info: { id: 'msg_u<n>', role: 'user' } }` plus a text `message.part.updated` immediately, and after the tool ends a `message.updated { info: { id: 'msg_a<n>', role: 'assistant', parentID: 'msg_u<n>' } }` with a `saw: <text>` part, then one `session.idle`. `mock:steer-late`: after the last assistant part, accept POSTs for 300 ms (user message only, no assistant with that parentID), then `session.idle`.

- [ ] **Step 2: Write the failing tests** — Task A3's two shapes against `OpencodeServerRunner` (`CEZ_OPENCODE_BIN`), plus:

```ts
it('does not open a second turn for busy agent input (#505)', async () => {
  // After a busy sendAgentMessage on mock:steer-tool, exactly one opencodeTurnStarted
  // (v2 turn.started) and exactly one v1 turn-end are observed.
});
```

- [ ] **Step 3: Run — expect FAIL** (`-t "#505"`; busy refusal).

- [ ] **Step 4: Implement** as described. Keep `pendingPromptRequests` semantics for human prompts. Readiness after an agent POST: `agentInputReady` becomes true again as soon as the POST resolves (acceptance), so a burst drains without waiting for idle.

- [ ] **Step 5: Prove red (tag `cez505-A5`), then green** — `npm test -- packages/cezar/src/core/opencode-server-runner.test.ts packages/cezar/src/core/opencode-ui-mapper.test.ts`.

- [ ] **Step 6: Commit** — `feat(opencode): admit busy agent input and observe parentID consumption`.

### Task A6: Cursor — declare `boundary`

**Files:**
- Modify: `packages/cezar/src/core/cursor-acp-runner.ts:53`
- Test: `packages/cezar/src/core/cursor-acp-runner.test.ts`

- [ ] **Step 1: Test** — `expect(new CursorAcpRunner().inputDelivery).toEqual({ mode: 'boundary', consumption: 'unobservable', via: expect.stringContaining('session/prompt') })` and that a busy `sendAgentMessage` still returns `false`.
- [ ] **Step 2: Run — FAIL** (`inputDelivery` undefined).
- [ ] **Step 3: Implement**

```ts
  /** A second ACP session/prompt cancels the running turn (probe 2026-09-23, cursor-agent
   * 2026.09.18), so agent input waits for the turn boundary; routine messages never cancel tools. */
  readonly inputDelivery: InputDelivery = { mode: 'boundary', consumption: 'unobservable', via: 'next session/prompt after end_turn' };
```

- [ ] **Step 4: Run — PASS.** **Step 5: Commit** — `feat(cursor): declare boundary input delivery`.

### Task A7: Harness parity row for `inputDelivery`

**Files:**
- Modify: `packages/cezar/src/core/harness-parity.testkit.ts` (scenarios `steer-tool`, `steer-late`; adapter prompts; exemption `D1`-style entry for Cursor)
- Modify: `packages/cezar/src/core/harness-parity.test.ts`

- [ ] **Step 1: Add scenarios** `'steer-tool'` and `'steer-late'` to `SCENARIOS`; map them to `mock:steer-tool` / `mock:steer-late` for claude, codex, opencode, pi. Cursor declares neither prompt. Add exemptions:

```ts
  { criterion: 'I1', backend: 'cursor', kind: 'scenario-unconstructible',
    reason: 'Cursor ACP 2026.09.18: a second session/prompt cancels the running turn (live probe 2026-09-23), so mid-turn agent input cannot be constructed without cancelling tools. inputDelivery is boundary.' },
  { criterion: 'I2', backend: 'cursor', kind: 'scenario-unconstructible', reason: 'Same as I1: no mid-turn admission to leave unconsumed.' },
  { criterion: 'I3', backend: 'claude', kind: 'capability-absent',
    reason: 'Claude 2.1.280 runs a line written after the last model call as its own following result (queued_turn_count), so nothing is left unconsumed at turn-end.' },
```

- [ ] **Step 2: Write the rows** in `harness-parity.test.ts`, following the file's existing `for (const backend of RUNNER_IDS)` + `exemptionFor` pattern:

```ts
// I1: a steer runner accepts agent input mid-turn and reports consumption before turn-end.
// I2: a steer runner reports an input the finished turn never consumed in turn-end.unconsumedInputIds.
// I3 (Claude inverted): no unconsumedInputIds ever.
// I0: inputDeliveryOf(createRunner(backend)) matches the declared mode; boundary runners refuse busy input.
```

Each row uses `driveSeam(backend, 'steer-tool', { sessionOptions: { onAgentInputConsumed }, whileOpen })` where `whileOpen` waits for the first `tool-call`, calls `session.sendAgentMessage([{ type: 'text', text: 'parity steer' }], ['parity-1'])`, then waits for `turn-end`; assert consumed `['parity-1']`, one `turn-end`, and that `turn-end` precedes nothing else of that turn.

- [ ] **Step 3: Run** `npm test -- packages/cezar/src/core/harness-parity.test.ts` — PASS (rows are green on Tasks A2–A6 code). Prove the I1 row red by stashing `codex-app-server-runner.ts` alone (tag `cez505-A7`), then restore.
- [ ] **Step 4: Commit** — `test(parity): pin input delivery and consumption per runner`.

### Task A8: RunManager — pass IDs, record consumption, drop the opening gate

**Files:**
- Modify: `packages/cezar/src/runs/store.ts` (new `commitAgentInputsConsumed(runId, ids, at)`)
- Modify: `packages/cezar/src/workflows/run.ts`: `submitAgentInput` (`:3505`), `flushAgentInputs` (`:3596-3616`), both `startSession` option blocks (`:4600`, `:5440`), opening checkpoint (`:4227`, `:4296-4313`), `providerOwnsInboxInput` (`:3051`)
- Test: `packages/cezar/src/workflows/immediate-delivery.test.ts` (new), `packages/cezar/src/runs/store.test.ts`

**Interfaces:**
- Consumes: `sendAgentMessage(content, inputIds)`, `onAgentInputConsumed` (Task A1)
- Produces: `RunStore.commitAgentInputsConsumed(runId: string, ids: readonly string[], at: string): void` (sets `consumedAt` only on inputs that have `deliveredAt` and no `consumedAt`; atomic save); `RunManager.handleAgentInputConsumed(runId, state, session, ids)` (private)

- [ ] **Step 1: Write the failing integration tests**

Create `packages/cezar/src/workflows/immediate-delivery.test.ts` on the `worker-wait.testkit.ts` fixture (`useWorkerWaitFixture`, `parent`, `worker`, `store`, `manager`, `until`) — the same harness as `conversation-batch.test.ts`, which runs the real Claude runner against `mock-claude.mjs`. Add a `steerTurn` helper that starts the parent/worker with task text `mock:steer-tool` and `CEZ_MOCK_STEER_MS=1500`.

```ts
it('delivers a parent message into a worker\'s long first turn and records consumption (#505)', async () => {
  const p = await parent(); const w = await worker(p.id, { task: 'mock:steer-tool' });
  await until(() => store.readEvents(w.id).some(e => e.type === 'tool-call'));
  const id = randomUUID();
  commitMessage(p.id, w.id, id, 'progress', 'API correction: use v2');
  manager.deliverConversationInput(w.id);
  await until(() => !!store.getRun(w.id)?.agentInputs?.find(i => i.id === id)?.deliveredAt);
  expect(store.getRun(w.id)!.agentInputs!.find(i => i.id === id)!.consumedAt).toBeUndefined();
  expect(store.readEvents(w.id).some(e => e.type === 'turn-end')).toBe(false); // still the first turn
  await until(() => !!store.getRun(w.id)?.agentInputs?.find(i => i.id === id)?.consumedAt);
  expect(store.readEvents(w.id).filter(e => e.type === 'text' && String(e.text).includes('API correction'))).toHaveLength(1);
});

it('delivers a worker message into the parent\'s running turn (#505)', async () => { /* mirror, worker → parent */ });

it('steers later input into a resumed opening turn (#505)', async () => {
  // Settle a worker, resume it with send --resume (conversation-resume-wait.test.ts pattern) whose
  // instruction is mock:steer-tool; while its opening tool runs, commit a second message; expect it
  // delivered and consumed before the opening turn-end, and the opening input's deliveredAt set at
  // turn start (before turn-end), with continuationMessage retired only at turn-end.
});

it('drains a 40-message burst as two FIFO submissions (#505)', async () => {
  // 40 progress messages of 10 chars while the tool runs; spy sendAgentMessage; expect accepted
  // calls to carry 32 then 8 ids in creation order, every input delivered exactly once.
});
```

`commitMessage(root, recipient, id, kind, text)` is a local helper wrapping `store.commitConversation` exactly as `conversation-batch.test.ts:20-27` does.

- [ ] **Step 2: Run — expect FAIL** (`npm test -- packages/cezar/src/workflows/immediate-delivery.test.ts`): the runner accepts now, but `run.ts` passes no ids and nothing writes `consumedAt`; the resumed-opening test fails on the `openingAgentInputId` gate.

- [ ] **Step 3: Implement**

`store.ts`:

```ts
  /** Model consumption observed by the current session (#505). Never un-sets deliveredAt. */
  commitAgentInputsConsumed(id: string, ids: readonly string[], at: string): void {
    const run = this.runs.get(id);
    if (!run?.agentInputs || !ids.length) return;
    this.commitAgentInputs(id, run.agentInputs.map(input => ids.includes(input.id) && input.deliveredAt && !input.consumedAt
      ? { ...input, consumedAt: at } : input));
  }
```

`run.ts` `submitAgentInput`: `acknowledgement = session.sendAgentMessage(content, inputIds);`. Add, next to `handleAgentInputReady`:

```ts
  /** Only the current session's observation writes consumedAt. An ID reported before its
   * acceptance checkpoint lands is held until that checkpoint commits. */
  private handleAgentInputConsumed(runId: string, state: ActiveRun, session: AgentSession | undefined, ids: readonly string[]): void {
    if (!session || this.active.get(runId) !== state || state.session !== session) return;
    const pending = state.agentInputFlight?.inputIds ?? [];
    const early = ids.filter(id => pending.includes(id));
    if (early.length) { state.consumedBeforeAck ??= new Set(); for (const id of early) state.consumedBeforeAck.add(id); } // flushed in submitAgentInput's then()
    const now = ids.filter(id => !pending.includes(id));
    try { if (now.length) this.store.commitAgentInputsConsumed(runId, now, new Date().toISOString()); }
    catch (error) { console.warn(`[cez] consumption checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
```

Add `consumedBeforeAck?: Set<string>` to `ActiveRun`; in `submitAgentInput`'s acceptance `then`, after the `deliveredAt` commit, commit `consumedAt` for `inputIds ∩ consumedBeforeAck` and delete them. Wire `onAgentInputConsumed: ids => this.handleAgentInputConsumed(runId, state, session, ids)` in **both** `startSession` option blocks.

Opening gate: in `flushAgentInputs` delete `if (state.openingAgentInputId) return false;` and exclude the opening input from batches instead — `agentInputBatch(run.agentInputs.filter(input => input.id !== state.openingAgentInputId), …)`. Record opening acceptance at the session's first `turn.started` UI event (in `runContinuation`'s `onUiEvent`, before `handleRunnerUiEvent`):

```ts
          if (event.type === 'turn.started' && state.openingAgentInputId && !openingAccepted) {
            openingAccepted = true;
            const id = state.openingAgentInputId, at = new Date().toISOString();
            this.store.commitAgentInputs(runId, (this.store.getRun(runId)?.agentInputs ?? []).map(input =>
              input.id === id && !input.deliveredAt ? { ...input, deliveredAt: at } : input));
          }
```

and keep the turn-end block at `:4298-4313` as the replay-retirement checkpoint — it still calls `commitAgentInputs(..., id)` (the input already has `deliveredAt`, which the store's opening check requires) and then clears `openingAgentInputId`. `providerOwnsInboxInput` keeps treating the opening id as provider-owned.

- [ ] **Step 4: Run — PASS**; also `npm test -- packages/cezar/src/workflows packages/cezar/src/core/conversation-*.test.ts packages/cezar/src/delegation`. Tests that pinned the old turn-boundary gate now fail by design — e.g. `conversation-batch.test.ts` expects nothing delivered before `release`. For each: rewrite its assertion to the new contract (delivered during the turn, consumed at the observed point) and state in the test comment which #505 behavior replaced the gate. Do not delete coverage: batching, identity and outcomes assertions stay.

- [ ] **Step 5: Prove red** — stash `workflows/run.ts runs/store.ts` (tag `cez505-A8`), run `immediate-delivery.test.ts`, confirm FAIL, restore.

- [ ] **Step 6: Commit** — `feat(runs): steer conversation input immediately and record consumption`.

### Task A9: Requeue inputs a finished turn never consumed

**Files:**
- Modify: `packages/cezar/src/runs/store.ts` (`requeueUnconsumedAgentInputs`)
- Modify: `packages/cezar/src/workflows/run.ts` — new private `retireTurnInputs(runId, state, event)` called first in **both** `turn-end` branches (`runContinuation` ~`:4290`, `runAgentStep` ~`:5232`)
- Test: `packages/cezar/src/workflows/immediate-delivery.test.ts`

**Interfaces:**
- Produces: `RunStore.requeueUnconsumedAgentInputs(runId: string, ids: readonly string[]): void` (clears `deliveredAt` and `consumedAt` for those ids only; keeps order and inbox claims untouched)

- [ ] **Step 1: Failing tests** (Codex backend — its mock has `steer-late`; set the fixture's backend to `codex` the way `conversation-delivery.test.ts` selects `withOwnedInputRun(backend, …)`):

```ts
it('resubmits an input the finished turn never consumed, as the next turn (#505)', async () => {
  // worker on mock:steer-late; commit a message after its final text; expect: deliveredAt set, then
  // cleared at turn-end, then set again by a second submission; one text containing it; consumedAt set.
});
it('does not settle CEZ:DONE while an accepted input is unconsumed (#505)', async () => {
  // mock:steer-late variant whose final text ends with CEZ:DONE (add mock:steer-late-done); expect the
  // run to stay open, the requeued input to be delivered in a following turn, then DONE to settle.
});
it('does not park a worker wait or monitoring over unconsumed input (#505)', async () => { /* CEZ:MONITORING variant */ });
```

- [ ] **Step 2: Run — FAIL** (turn-end ignores `unconsumedInputIds`; DONE closes the session).

- [ ] **Step 3: Implement**

```ts
  /** #505: a turn that ended idle without consuming accepted input returns it to the queue,
   * so DONE/auto-end/park see queued work through hasQueuedAgentInputs. */
  private retireTurnInputs(runId: string, state: ActiveRun, event: Extract<AgentEvent, { type: 'turn-end' }>): void {
    const ids = event.unconsumedInputIds ?? [];
    if (!ids.length || state.cancelled) return;
    this.store.requeueUnconsumedAgentInputs(runId, ids);
    this.store.appendEvent(runId, { type: 'note', message: `resubmitting ${ids.length} message${ids.length === 1 ? '' : 's'} the turn ended before reading` });
  }
```

Call `this.retireTurnInputs(runId, state, event)` as the first statement inside `if (event.type === 'turn-end') {` in both handlers. The existing `flushAgentInputs` call in each handler then submits them; `hasQueuedAgentInputs` already counts inputs without `deliveredAt`, which holds DONE (`done && … !this.hasQueuedAgentInputs(runId)`), the autonomous nudge and park.

- [ ] **Step 4: Run — PASS. Step 5: Prove red (tag `cez505-A9`, stash `run.ts store.ts`). Step 6: Commit** — `fix(runs): resubmit input a turn ended without reading`.

### Task A10: Replay delivered-but-unconsumed input after a crash

**Files:**
- Modify: `packages/cezar/src/workflows/run.ts` `recover()` (`:1861`)
- Test: `packages/cezar/src/workflows/immediate-delivery.test.ts`

- [ ] **Step 1: Failing test** — on Claude (observable): commit a message while `mock:steer-tool` runs, wait for `deliveredAt`, then simulate a crash before consumption with the testkit's restart helper (the `fixture.restart()` pattern in `conversation-delivery.test.ts:44`, or `worker-wait-durability.test.ts`'s restart). After restart expect the input's `deliveredAt` cleared, the run recovered, the input re-delivered exactly once more, its text showing its id prefix, and `consumedAt` set. A second case: a record whose step backend is `cursor` keeps `deliveredAt` untouched through recovery.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** — at the start of `recover()` for every run in `queued|running|waiting` with `agentInputs`:

```ts
      const backend = this.currentBackend(run); // the run's current step backend, default runner otherwise
      if (inputDeliveryOf(createRunner(backend)).consumption === 'observable') {
        const unread = run.agentInputs.filter(input => input.deliveredAt && !input.consumedAt &&
          input.id !== run.continuationMessage?.agentInputId).map(input => input.id);
        if (unread.length) this.store.requeueUnconsumedAgentInputs(run.id, unread);
      }
```

Reuse the recovery code's existing backend resolution (`step.backend ?? record.runner`) instead of adding `currentBackend` if an equivalent exists. Replay only inputs from sessions started by this version: write a new optional `StepState.inputConsumption: 'observable' | 'unobservable'` at `startSession` time (both sites) and replay only when the recovered step carries `'observable'`. An upgraded install therefore never replays historical messages, which have `deliveredAt` and no `consumedAt`.

- [ ] **Step 4: Run — PASS. Step 5: Prove red (tag `cez505-A10`). Step 6: Commit** — `fix(runs): replay accepted but unread input after restart`.

### Task A11: Human answer first, pending messages right behind it

**Files:**
- Modify: `packages/cezar/src/workflows/run.ts` `deliverMessage` (`:3699-3748`)
- Test: `packages/cezar/src/workflows/immediate-delivery.test.ts`

Behavior:
- After a successful user-authored `sendMessage` that answered a pending ask, call `this.flushAgentInputs(runId)` so held conversation input steers immediately behind the answer.
- When the answer opens a new turn — the answered ask was a `CEZ:ASK` marker ask (no native ask pending in the runner; `state.atTurnBoundary === state.session`) — build the pending conversation batch first and append its text as a second content block to the same `sendMessage` call; on success commit `deliveredAt` for those ids and record them in `state.bundledInputIds`; the next `turn-end` of that session commits their `consumedAt` (they rode in the turn that just completed).

- [ ] **Step 1: Failing tests**

```ts
it('delivers held messages right behind a live human answer, never as the answer (#505)', async () => {
  // parent ends a turn with CEZ:ASK (mock:ask); three worker messages are committed; they stay queued.
  // manager.sendMessage(parent, [{ type: 'text', text: 'mock:agent-echo yes' }]) answers.
  // Expect: one stdin write whose content has the answer first and all three message ids after it;
  // human-input-delivered once for that ask; the three inputs delivered with the same deliveredAt,
  // and consumedAt set at the following turn-end.
});
it('steers held messages behind a native-ask answer on codex (#505)', async () => {
  // codex mock:native-codex-ask: answer via requestUserInput; expect a turn/steer carrying the three
  // ids submitted after the answer RPC, within the same turn.
});
```

- [ ] **Step 2: Run — FAIL** (no flush after the answer; messages wait for that turn to end).

- [ ] **Step 3: Implement** in `deliverMessage`:

```ts
    const answeringAskSeq = userAuthored ? this.pendingHumanAskSeq(runId) : undefined;
    const bundle = userAuthored && answeringAskSeq !== undefined && state.atTurnBoundary === state.session
      ? this.pendingConversationBatch(runId) : undefined;
    const delivered = userAuthored
      ? state.session.sendMessage(bundle ? [...deliverable, { type: 'text', text: bundle.text }] : deliverable)
      : this.submitAgentInput(runId, state, deliverable);
    if (delivered) {
      if (userAuthored) {
        /* existing ciHumanMessage / human-input-delivered / pendingHumanAsk lines */
        if (bundle) this.commitBundledDelivery(runId, state, bundle.inputs.map(input => input.id));
        else if (answeringAskSeq !== undefined) this.flushAgentInputs(runId);
      }
      this.resumeParkedRun(runId, state);
    }
```

`pendingConversationBatch(runId)` returns `agentInputBatch(queue.filter(i => i.conversation && !i.deliveredAt && !hasLiveInboxClaim(i) && i.id !== state.openingAgentInputId), …)` — the same formatter `flushAgentInputs` uses; it returns `undefined` while a CI wait is registered (CI lifecycle input is never bundled). `commitBundledDelivery` writes `deliveredAt` and pushes the ids onto `state.bundledInputIds`. In `retireTurnInputs` (Task A9), after requeue handling, commit `consumedAt` for `state.bundledInputIds` and clear it.

- [ ] **Step 4: Run — PASS. Step 5: Prove red (tag `cez505-A11`). Step 6: Commit** — `feat(runs): deliver held messages right behind a human answer`.

### Task A12: Receipts, thread and CLI show "consumed"

**Files:**
- Modify: `packages/contract/src/conversations.ts:50` (`delivery` enum gains `'consumed'`), `packages/contract/src/events.ts:32` (`conversation-message.delivery` gains `'consumed'`, optional `consumedAt`)
- Modify: `packages/cezar/src/delegation/service.ts:144-150` (`conversationReceipt`), `packages/cezar/src/delegation/conversations.ts` (projection emits a consumed projection once)
- Modify: `packages/web/src/routes/task-thread/thread-state.ts` + the conversation message component that renders `delivery` (find it with `grep -rn "delivery ===" packages/web/src`)
- Test: `packages/cezar/src/delegation/conversation-service.test.ts`, `packages/cezar/src/delegation/conversations.test.ts`, the web component test, `contract-parity*.test.ts`

- [ ] **Step 1: Failing tests** — service: a message whose recipient input has `consumedAt` returns `delivery: 'consumed'`; projection: exactly one `conversation-message` projection with `delivery: 'consumed'` per consumed input across repeated `projectConversationEvents` calls; web: a consumed message renders the label `Read` next to its delivered time.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — `delivery: input?.consumedAt ? 'consumed' : input?.deliveredAt ? 'delivered' : input ? 'queued' : 'not-delivered'`; add the enum value in both schemas; the projection writes the consumed projection with `consumedAt`; the thread shows `Queued` / `Delivered` / `Read`. Update `BACKWARD_COMPATIBILITY.md` only if it enumerates the delivery values (grep first).
- [ ] **Step 4: Run** `npm test -- packages/cezar/src/delegation packages/web/src/routes/task-thread packages/cezar/src/server/contract-parity` — PASS.
- [ ] **Step 5: Commit** — `feat(conversations): report consumed messages separately from delivered`.

### Task A13: Agent instructions no longer promise turn-boundary delivery

**Files:**
- Modify: `packages/cezar/src/delegation/provision.ts:32,39`
- Test: `packages/cezar/src/delegation/provision-workflows.test.ts` (or the test that snapshots these lines; `grep -rn "next safe turn boundary" packages/cezar/src`)

- [ ] **Step 1: Update the expected text in the test** to the new lines, run — FAIL.
- [ ] **Step 2: Replace the two lines**

```ts
    `Messages reach the recipient's live session as soon as they are accepted, including mid-turn; they are read at its next model step. ${invocation} inbox remains a fallback read during an active turn; it acknowledges only the messages it returns. Use conversation <recipient-run-id> for history or investigation; it does not acknowledge messages.`,
    `Pending conversations are submitted together within a 100,000-character batch limit. Each keeps its own ID and request outcome; receipts report queued, delivered and consumed separately. A wait refusal explains why; successful registration parks only when you end your turn.`,
```

- [ ] **Step 3: Run — PASS. Step 4: Commit** — `docs(delegation): describe immediate delivery to agents`.

### Task A14: Protocol docs and the manual probe script

**Files:**
- Modify: `AGENT_PROTOCOL.md` (runner seam section: `inputDelivery`, `sendAgentMessage(content, inputIds)`, `onAgentInputConsumed`, `turn-end.unconsumedInputIds`; a per-backend table with the spec's probe rows; the new-runner checklist gains "declare `inputDelivery`")
- Create: `.ai/scripts/probe-steering.ts`

- [ ] **Step 1: Write the probe script** — the `/tmp/cez505/probe.ts` shape from design, made durable: `tsx .ai/scripts/probe-steering.ts <backend> [model]` starts the real runner with the slow-tool prompt, sends `sendAgentMessage` with id `probe-1` 8 s into the first tool, and prints a JSON timeline (`tool-call`, `SENT`, `ACK`, `CONSUMED`, `tool-result`, `turn-end`, final `RESULT` with `textHasToken`). Header comment: manual, spends a paid session, never run by CI or `npm test`, not packed (it lives outside `packages/`).
- [ ] **Step 2: Update `AGENT_PROTOCOL.md`.**
- [ ] **Step 3: Commit** — `docs(protocol): document input delivery and add the steering probe`.

### Task A15: Verification, real-harness evidence, draft PR A

- [ ] **Step 1: Full gate** (sequentially — see memory: `test-env-up` `npm ci` collides with `npm test`):

```bash
npm run typecheck && npm test && npm run test:unit && npm run build && TMPDIR=/tmp npm run test:package
env -u CEZ_AUTOMATIONS npm run test:e2e
```

Expected: all green; `TEST_E2E_STATUS=passed`.

- [ ] **Step 2: Real harness** — `for b in claude codex pi opencode; do env -u CEZ_AUTOMATIONS node_modules/.bin/tsx .ai/scripts/probe-steering.ts $b; done` (Claude with `claude-haiku-4-5`). Expected per backend: `ACK` within ~1 s of `SENT`, `CONSUMED` after `tool-result` and before `turn-end`, one `turn-end`, `textHasToken: true`. Cursor: `sendAgentMessage` refused while busy, delivered after `turn-end`. Paste the timelines into the PR body's Verification section.
- [ ] **Step 3: Draft PR A** per dev-flow step 10 (`gh pr create --draft --base main`), body `Refs #505` (not `Closes`), Left undone: PR B, OpenCode V2 follow-up.

---

# PR B — Worker questions go to the parent

Branch `fix/worker-questions-to-parent` off the merged PR A (or stacked on `fix/immediate-worker-delivery` until it merges).

### Task B1: Contract shapes

**Files:**
- Modify: `packages/contract/src/conversations.ts` (`conversationMessageSchema.question?: askRequestSchema`; `requestOutcomeSchema.status` gains `'human-fallback'`)
- Modify: `packages/contract/src/events.ts` (`workerQuestionRoutedEventSchema { type: 'worker-question-routed', askSeq, messageId, parentRunId }`, `workerQuestionFallbackEventSchema { type: 'worker-question-fallback', askSeq, reason }`, `humanInputDeliveredEventSchema.source?: 'human' | 'parent'`)
- Test: `packages/contract` schema tests (or `packages/cezar/src/server/contract-parity*.test.ts`)

- [ ] **Step 1:** Tests: a message with a valid `question` parses; an invalid `question` (5 questions) fails; `human-fallback` parses; old events without `source` parse. **Step 2:** FAIL. **Step 3:** Implement (import `askRequestSchema` from `./ask.ts`; check for an import cycle `ask.ts → events.ts → conversations.ts` and, if present, move `askRequestSchema` into a leaf `ask-schema.ts` re-exported from `ask.ts`). **Step 4:** PASS + `npm run typecheck`. **Step 5:** Commit `feat(contract): add worker question and fallback shapes`.

### Task B2: `delegation/questions.ts`

**Files:**
- Create: `packages/cezar/src/delegation/questions.ts`, `packages/cezar/src/delegation/questions.test.ts`

**Interfaces:**
- Produces:
  - `questionMessage(input: { workerRunId: string; parentRunId: string; askSeq: number; request: AskRequest; now: string }): ConversationMessage` — `kind: 'request'`, deterministic `id = uuidv5-style hash of workerRunId + askSeq` (use `createHash('sha256')` → format as UUID v4-shaped hex so a retry after restart reuses it), `question: request`, no `deadline`, `requestHash` of the payload, `state: 'accepted'`
  - `formatQuestionText(workerRunId: string, messageId: string, request: AskRequest): string`
  - `answersQuestion(message: ConversationMessage, input: AgentInput): boolean` — true only for `input.conversation.kind === 'reply' && input.conversation.requestId === message.id && message.question`

- [ ] **Step 1: Tests**

```ts
it('formats every question, its options and the exact reply command', () => {
  const text = formatQuestionText(W, M, { questions: [{ header: 'DB', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] });
  expect(text).toContain('Which database?'); expect(text).toContain('Postgres');
  expect(text).toContain(`worker reply ${W} '<answer>' --id <new-message-UUID> --request-id ${M}`);
  expect(text).toContain('Escalate to the human with your own question');
});
it('is deterministic per worker ask so a restart reuses the same message', () => {
  expect(questionMessage({ ...base, now: 'a' }).id).toBe(questionMessage({ ...base, now: 'b' }).id);
});
it('only a reply to that question answers it', () => {
  expect(answersQuestion(q, input('reply', q.id))).toBe(true);
  expect(answersQuestion(q, input('progress'))).toBe(false);
  expect(answersQuestion(q, input('reply', randomUUID()))).toBe(false);
});
```

- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat(delegation): build parent-routed worker questions`.

### Task B3: Route worker asks to the parent

**Files:**
- Modify: `packages/cezar/src/workflows/run.ts` — `handleRunnerUiEvent` `ask.requested` branch (`:5566`) and the `CEZ:ASK` emission in both turn-end handlers (`emitAskRequested(sink, ask)` sites) through one helper `routeWorkerQuestion(runId, state)` called right after the ask event is persisted
- Test: `packages/cezar/src/workflows/worker-questions.test.ts` (new)

**Interfaces:**
- Consumes: `questionMessage`, `formatQuestionText` (Task B2)
- Produces: `RunManager.routeWorkerQuestion(workerId: string): 'routed' | 'fallback' | 'not-worker'`; `RunManager.parentCanReceive(parentId: string): boolean` (parent run exists, status `queued|running|waiting`, not stopping, no finish requested, no history deletion pending)

Behavior: when the run is an owned worker and `pendingHumanAsk(events)` returns an ask, build the question message, commit it with `store.commitConversation(root.id, next, { recipientRunId: parent.id, input })` where `input.text = formatQuestionText(...)`, append `worker-question-routed { askSeq, messageId, parentRunId }` to the worker, project events, and call `deliverConversationInput(parent.id)`. Idempotent on retry (same id already in the conversation → only re-deliver). If `!parentCanReceive`, append `worker-question-fallback { askSeq, reason }` and record outcome `human-fallback` for an already-routed message.

- [ ] **Step 1: Failing tests** (for `claude` marker ask via `mock:ask` and `codex` native ask via `mock:native-codex-ask`):

```ts
it('sends a worker question to its active parent as a request (#505)', async () => {
  // worker raises an ask; expect parent agentInputs to gain one conversation request whose message has
  // `question`, the worker to have worker-question-routed for that askSeq, the worker waiting with its
  // slot released, and no human attention flag on the parent from the worker ask.
});
it('falls back to the human when the parent is finished (#505)', async () => { /* parent done → worker-question-fallback */ });
```

- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** prove red (tag `cez505-B3`). **Step 6:** Commit `feat(workers): route worker questions to the owning parent`.

### Task B4: A parent reply answers the worker's question

**Files:**
- Modify: `packages/cezar/src/workflows/run.ts` `deliverConversationInput` (`:3131`) and a new `answerRoutedQuestion(workerId, input)`; `continueRun` gains an internal `answerSource: 'parent'` option
- Modify: `packages/cezar/src/delegation/service.ts:170-172` — a reply to a settled question is refused (`incompatible_state`, "This question was already answered")
- Test: `packages/cezar/src/workflows/worker-questions.test.ts`

Behavior:
- `deliverConversationInput(workerId)` today returns early while `hasPendingHumanAsk`. New: when the pending ask is routed (a `worker-question-routed` for its seq and no later fallback), find the first undelivered input with `answersQuestion`. If found: live session → `state.session.sendMessage([{ type: 'text', text: replyText }])` (the native answer seam), then `human-input-delivered { askSeq, source: 'parent' }`, commit its `deliveredAt`, clear `pendingHumanAsk`, `resumeParkedRun`, then `flushAgentInputs` so held progress follows (Task A11 rules). No live session → `continueRun(workerId, { text: replyText }, true, { answerSource: 'parent' })`, which answers that ask seq exactly like a human continuation (`openingAnswerAskSeq`) but records `source: 'parent'`. Any other input stays queued.
- `replyText` is the reply's own text prefixed with `Your parent answered your question:`.

- [ ] **Step 1: Failing tests**

```ts
it('a correlated parent reply unblocks the worker without human input (#505)', async () => { /* live */ });
it('progress and follow-ups never answer a pending worker question (#505)', async () => {
  // parent sends progress then a follow-up to the worker: both stay undelivered, the ask stays pending;
  // then the reply arrives: the answer is delivered first and the two queued inputs right behind it.
});
it('a parent reply answers the worker after a restart (#505)', async () => { /* restart between ask and reply */ });
it('holds a worker question while the parent waits on the human, then delivers it behind the answer (#505)', async () => {});
it('refuses a second reply to an answered question (#505)', async () => {});
```

- [ ] **Step 2–4:** FAIL → implement → PASS (run for claude and codex backends). **Step 5:** prove red (tag `cez505-B4`). **Step 6:** Commit `feat(workers): answer routed questions from parent replies`.

### Task B5: Human input cannot answer a routed question

**Files:**
- Modify: `packages/cezar/src/workflows/run.ts` `deliverMessage` and `continueRun` human answer path
- Test: `packages/cezar/src/workflows/worker-questions.test.ts`

- [ ] **Step 1: Test** — while a worker's ask is routed, `manager.sendMessage(worker, [...])` returns `false` and appends one note `This question was sent to the parent task; answer it there.`; `continueRun(worker, { text })` returns `{ ok: false, error: … }` with the same sentence. After `worker-question-fallback`, both succeed and answer the ask.
- [ ] **Step 2–4:** FAIL → implement (check `this.routedAsk(runId)` before sending) → PASS. **Step 5:** Commit `fix(workers): keep routed questions parent-only until fallback`.

### Task B6: Parent completion attention and fallback triggers

**Files:**
- Modify: `packages/cezar/src/workflows/run.ts` — `parentCompletionAttention` includes unanswered routed questions whose parent is this run; fallback hook `fallbackRoutedQuestions(parentId, reason)` called where a parent settles `done|review|failed|cancelled`, on stop/destroy, when history deletion starts, and once in `recover()` for every routed question whose parent can no longer receive
- Test: `packages/cezar/src/workflows/worker-questions.test.ts`

- [ ] **Step 1: Tests** — parent emits `CEZ:DONE` with an unanswered worker question: the run does not close and shows completion attention; parent cancelled: the worker ask gets `worker-question-fallback { reason: 'parent-cancelled' }`, outcome `human-fallback`, and becomes human-answerable; a parked parent is woken by the question within `maxParallel` (use `worker-wait-capacity.test.ts`'s capacity fixture).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat(workers): hold parent completion on worker questions and fall back to the human`.

### Task B7: Cockpit — "Routed to parent" card

**Files:**
- Modify: `packages/web/src/routes/task-thread/thread-state.ts` (`ThreadAsk.routedToParent?: boolean`, `answeredBy?: 'human' | 'parent'`; handle `worker-question-routed`, `worker-question-fallback`, `human-input-delivered` with `source: 'parent'` → resolved)
- Modify: `packages/web/src/routes/task-thread/ask-card.tsx` (routed + unresolved → read-only card: questions and options as text, the line `Routed to parent — answer it in the parent task`, a link to the parent run via `Link`; no chips, no Send)
- Test: `thread-state.test.ts`, `ask-card.test.tsx`

- [ ] **Step 1: Tests** — reducer: routed ask → `routedToParent: true`; fallback → `false`; parent delivery → `resolved: true, answeredBy: 'parent'`; card: routed renders no `button` with an option label and renders the parent link; fallback renders the chips as today; resolved-by-parent renders `Answered by parent`.
- [ ] **Step 2–4:** FAIL → implement → PASS (`npm test -- packages/web/src/routes/task-thread`). Keep light/dark tokens and keyboard access of the existing card. **Step 5:** Commit `feat(web): show worker questions routed to the parent`.

### Task B8: Instructions and protocol docs

**Files:**
- Modify: `packages/cezar/src/delegation/provision.ts:58` (worker line) and add a parent line; `AGENT_PROTOCOL.md` worker-message section; `.ai/specs/2026-09-23-immediate-worker-delivery.md` (replace the `routedTo` event field with the `worker-question-routed` event this plan uses)

- [ ] **Step 1:** Update the provision test expectations, run — FAIL. **Step 2:** Worker line: `Follow your assigned task and selected input context. Your questions — native or CEZ:ASK — go to your parent, which answers or asks the human; do not wait for a human.` Parent line: `Worker questions arrive as requests carrying a question; answer with worker reply <worker-id> '<answer>' --id <new-UUID> --request-id <question-id>. If you cannot decide, ask the human with your own question, then reply.` **Step 3:** PASS. **Step 4:** Commit `docs(delegation): tell workers and parents how questions route`.

### Task B9: Cross-backend evidence, verification, draft PR B

- [ ] **Step 1:** Add `packages/cezar/src/core/conversation-questions.test.ts` on `withOwnedInputRun(backend, 'ask', …)` for every backend in `RUNNER_IDS`: the worker's ask reaches the parent as a routed request and a parent reply resolves it (`human-input-delivered` with `source: 'parent'`, one answer echo). Cursor's native ask included.
- [ ] **Step 2:** Full gate as Task A15 Step 1.
- [ ] **Step 3:** Real harness, once per backend: extend `.ai/scripts/probe-steering.ts` with `question` mode — a parent session and a worker session on the same backend through a dry cockpit is out of scope for the script; instead run a real cezar task (`CEZ_DRY_RUN` unset) whose parent spawns one worker instructed to ask a `CEZ:ASK` question, and record from `runs.json`/NDJSON: ask time, parent receipt time, reply time, worker answer delivery time. Paste the timeline into PR B.
- [ ] **Step 4:** Draft PR B, body `Closes #505`; step 10 findings; board to In review.

---

## Self-review notes

- Spec coverage: runner seam (A1–A7), gates/receipts/opening (A8), unconsumed (A9), crash (A10), human-first (A11), receipts UI/CLI (A12), instructions (A13, B8), docs/probe (A14), questions raise/answer/escalate/fallback/UI (B1–B7), evidence (A15, B9).
- Deviation recorded: the spec's `ask.requested.routedTo` becomes a separate `worker-question-routed` event (runner mappers emit `ask.requested`; cezar owns routing) — Task B8 updates the spec.
- Crash replay is limited to sessions started by this version (Task A10 `StepState.inputConsumption`) so an upgrade does not replay history.
