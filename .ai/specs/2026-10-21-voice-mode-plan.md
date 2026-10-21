# Voice mode (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The ⌘K palette understands sentences: it opens tasks by status and position, fills the
open task's question card or message box from dictated text, and sends only after a confirmation.

**Architecture:** A contract-first `voice` route family on the server asks a pluggable decision
engine (Jev, or a deterministic fake under `CEZ_DRY_RUN=1`) one fan-out request per sentence and
maps the typed answers to a `VoiceDecision`. The browser resolves targets from its cached run list,
keeps pending proposals in a small external store that the question card and composer subscribe
to, and sends through the existing card and composer paths.

**Tech Stack:** TypeScript (strict ESM, Node ≥ 24.15), zod 4 in `packages/contract`, Hono with the
`validators.ts` middleware, React 19 + cmdk palette, Vitest, the cockpit browser E2E harness.

**Spec:** `.ai/specs/2026-10-21-voice-mode.md` (read it first; research in
`.ai/analysis/2026-10-21-voice-mode-jev-research.md`).

**Not in this plan:** the Jev replay set from the spec's § Testing. It needs a real key and real
sentences, which the decision log collects once v1 runs; the thresholds in Task 3 are starting
values until then.

## Global Constraints

- Flag: `CEZ_VOICE` — only the exact value `1` enables it. Key: `TYPESAFE_API_KEY`, server env only.
- Capability rule: `voice = CEZ_VOICE === '1' && (TYPESAFE_API_KEY non-empty || CEZ_DRY_RUN === '1')`.
- Off: both routes answer `409 { error: 'Voice mode is off: set CEZ_VOICE=1 and TYPESAFE_API_KEY, then restart cezar' }`; the palette renders exactly as today.
- Under `CEZ_DRY_RUN=1` the engine is always the fake, even with a key set.
- Jev: `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`, model pinned to `jev-1.13.0`, per-call timeout 5000 ms, no retries. Never put the key in an error, a log line or a test snapshot.
- Contract values are imported from subpaths: server `@open-mercato/cezar-contract/voice`, web `@open-mercato/cezar-api-client/contract/voice`. Types may come from the roots as `import type`.
- Routes are chained into one family and mounted in the `v1` chain in `packages/cezar/src/server/server.ts`, so they answer under `/api/v1/voice/*` and `/api/v1/p/:projectId/voice/*`.
- Sentence text: trimmed, 1–500 characters (`VOICE_TEXT_MAX = 500`).
- Copy (exact): confirm prompt `Send these answers? Say “yes, confirmed” or press Return.`; tell prompt `Send this message? Say “yes, confirmed” or press Return.`; refusal `Question <n> (<header>) still needs an answer.`
- The Return that commits a sentence never confirms. Return confirms only when the palette input is empty and a proposal is shown.
- Any wait bound in a unit test carries a `// bound: <reason>` comment (AGENTS.md § Validation).
- New `CEZ_*` env var ⇒ `.env.example` and the README env table change in the same commit.

## Review Focus

1. **Keystroke-typing dictation** (Superwhisper "Simulate keypresses"): the text changes on every character. Expect at most one decide request in flight and only the latest text's decision shown. Test: Task 7, `ignores a decision for text that has since changed`.
2. **The question closes while a proposal is open** (answered in another tab, superseded, Finish): the proposal must end with a line, not send into a closed card. Test: Task 6, `unregistering the card drops its proposal`.
3. **The user switches tasks while a decision is in flight**: a late answer must not fill another task's card. Test: Task 7, `drops a decision made for another open task`.
4. **The engine answers outside the menu** (an unoffered choice, a probability outside 0–1, HTTP 429/529, a timeout): treated as an engine failure; the palette keeps working. Test: Task 2, `rejects a choice that was not offered` and `maps 529 to a VoiceEngineError without the key`.
5. **Dictation punctuation and fillers** ("Open next finished.", "um, answer…", capital letters): rules and span cleaning must ignore them. Test: Task 2 fake-engine table and Task 3 `cleans punctuation and fillers`.

---

### Task 1: Contract, capability and env docs

**Files:**
- Create: `packages/contract/src/voice.ts`, `packages/contract/src/voice.test.ts`, `packages/api-client/src/contract/voice.ts`
- Modify: `packages/contract/src/index.ts`, `packages/contract/src/health.ts` (`capabilitiesSchema`), `packages/cezar/src/server/capabilities.ts` (`resolveCapabilities`), `packages/cezar/src/server/capabilities.test.ts`, `.env.example`, `README.md` (env table), `BACKWARD_COMPATIBILITY.md` (health capability, additive)
- Modify: every object literal of type `Capabilities` that the typecheck names (test fixtures in `packages/web` and `packages/cezar`)

**Interfaces:**
- Produces (all from `@open-mercato/cezar-contract/voice`):
  - `VOICE_TEXT_MAX = 500`
  - `VOICE_STATUS_IDS = ['needs-you','working','finished','archived','needs-review','needs-permission','failed','running','waiting-for-ci','monitoring','waiting-for-capacity','queued','scheduled','waiting-on-workers','done','cancelled','unread'] as const`, `voiceStatusSchema`, `type VoiceStatus`
  - `VOICE_STATUS_DESCRIPTIONS: Record<VoiceStatus, string>` — one plain line each, written for the engine (for example `'finished': 'Done, failed or cancelled tasks the user has not archived.'`)
  - `voicePositionSchema = z.union([z.enum(['next','previous','last']), z.number().int().min(1).max(10)])`, `type VoicePosition`
  - `voiceSidebarViewSchema = z.enum(['active','automations'])`
  - `voiceDecideRequestSchema` (strict): `{ text, sidebarView, openRunId?: runIdParamSchema.shape.id, proposal?: { decisionId: z.uuid(), action: z.enum(['answer','tell']) } }`, `type VoiceDecideRequest`
  - `voiceAnswerSchema` = discriminated union on `kind`: `{ question: 0..3, kind: 'option', labels: string[1..4] }` | `{ question: 0..3, kind: 'other', text: string[1..VOICE_TEXT_MAX] }`, `type VoiceAnswer`
  - `voiceDecisionSchema` = discriminated union on `action`, every arm has `decisionId: z.uuid()`:
    `open { status, position, confidence: 0..1, alternatives?: { status, position }[] (max 3) }`,
    `answer { runId, askRequestId: string, answers: VoiceAnswer[1..4], confidence }`,
    `tell { runId, text, confidence }`, `confirm {}`, `cancel {}`,
    `none { reason: 'not-a-command' | 'no-open-task' | 'no-open-question' | 'unclear' }`; `type VoiceDecision`
  - `voiceOutcomeSchema = z.enum(['executed','confirmed','cancelled','replaced','abandoned'])`, `voiceOutcomeRequestSchema` (strict) `{ decisionId: z.uuid(), outcome }`, `voiceOutcomeResponseSchema = z.object({ ok: z.literal(true) })`
  - `capabilitiesSchema.voice: z.boolean()` (required, documented like `automations`)

- [ ] **Step 1: Write the failing tests**

`packages/contract/src/voice.test.ts`:
- `accepts a decide request and trims the text` — `{ text: '  open next finished ', sidebarView: 'active' }` parses to text `'open next finished'`.
- `refuses empty, overlong and unknown-key requests` — `''`, `'   '`, 501 × `'a'`, and `{ …, extra: 1 }` all fail.
- `positions take next, previous, last and 1–10 only` — `'next'`, `3` pass; `0`, `11`, `'first'` fail.
- `every status has a description` — for each id in `VOICE_STATUS_IDS`, `VOICE_STATUS_DESCRIPTIONS[id].length > 0`.
- `decision arms parse and keep their discriminant` — one sample per arm; `{ action: 'none', reason: 'maybe' }` fails.

`packages/cezar/src/server/capabilities.test.ts`, new `describe('voice capability')`:
- `{}` → `voice: false`; `{ CEZ_VOICE: '1' }` → `false`; `{ CEZ_VOICE: '1', TYPESAFE_API_KEY: 'k' }` → `true`; `{ CEZ_VOICE: '1', CEZ_DRY_RUN: '1' }` → `true`; `{ CEZ_VOICE: 'true', TYPESAFE_API_KEY: 'k' }` → `false`; `{ CEZ_VOICE: '1', TYPESAFE_API_KEY: '' }` → `false`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- packages/contract/src/voice.test.ts packages/cezar/src/server/capabilities.test.ts`
Expected: FAIL (`./voice.ts` not found; `voice` missing from the capabilities object).

- [ ] **Step 3: Implement the schemas, the re-exports and `resolveCapabilities(...).voice`**

`packages/api-client/src/contract/voice.ts` is the one-line re-export the other modules use.
Add `export * from './voice.ts'` to `packages/contract/src/index.ts`. Document `CEZ_VOICE` and
`TYPESAFE_API_KEY` in `.env.example` next to `CEZ_AUTOMATIONS`, in the same style (what it does, off
by default, exact value `1`, read at boot, what stays the same when off, that the key is only read
by the server, and that browser E2E boots its own fixture server with the flag).

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npm test -- packages/contract/src/voice.test.ts packages/cezar/src/server/capabilities.test.ts`, then from `packages/cezar`: `./node_modules/.bin/tsc --noEmit -p tsconfig.test.json`, then `npm run typecheck:contract` and `npm run typecheck:web` from the root.
Expected: PASS; fix each `Capabilities` literal the typecheck names by adding `voice: false`.

- [ ] **Step 5: Commit**

```bash
git add packages/contract packages/api-client/src/contract/voice.ts packages/cezar/src/server/capabilities.ts packages/cezar/src/server/capabilities.test.ts .env.example README.md BACKWARD_COMPATIBILITY.md packages/web/src
git commit -m "feat(contract): add voice decision schemas and the voice capability"
```

---

### Task 2: Decision engine seam (Jev and the dry-run fake)

**Files:**
- Create: `packages/cezar/src/voice/engine.ts`, `packages/cezar/src/voice/jev-engine.ts`, `packages/cezar/src/voice/fake-engine.ts`
- Test: `packages/cezar/src/voice/jev-engine.test.ts`, `packages/cezar/src/voice/fake-engine.test.ts`

**Interfaces:**
- Produces (`engine.ts`):
  ```ts
  export type EngineQuestion =
    | { type: 'choice'; instructions: string; options: Record<string, string | null> }
    | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
  export type EngineAnswer =
    | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
    | { type: 'noul'; noul: number }
  export interface DecisionEngine {
    readonly id: 'jev' | 'fake'
    decide(input: { state: VoiceEngineState; questions: Record<string, EngineQuestion> }, signal: AbortSignal):
      Promise<{ answers: Record<string, EngineAnswer>; inputTokens?: number }>
  }
  export interface VoiceEngineState {
    sentence: string; view: { sidebarView: 'active' | 'automations'; openTask: boolean };
    pendingProposal?: 'answer' | 'tell';
    card?: { header: string; question: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[];
    recent: { sentence: string; action: string; outcome?: string }[];
  }
  export const QUESTION_IDS: { isCommand: 'is_command'; action: 'action'; status: 'status'; position: 'position';
    tellStart: 'tell_start'; span(i: number): string /* `q${i}_span` */; choice(i: number): string /* `q${i}_choice` */;
    option(i: number, j: number): string /* `q${i}_opt${j}` */ }
  export class VoiceEngineError extends Error { constructor(readonly code: 'http' | 'timeout' | 'invalid-answer' | 'network', readonly status?: number) }
  export function selectVoiceEngine(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): DecisionEngine
  ```
- `JevVoiceEngine` (`jev-engine.ts`): `new JevVoiceEngine({ apiKey: string, fetch?: typeof fetch })`.
- `FakeVoiceEngine` (`fake-engine.ts`): `new FakeVoiceEngine()`; reads `state.sentence` and the question ids above.

- [ ] **Step 1: Write the failing tests**

`jev-engine.test.ts` (inject a stub `fetch`):
- `posts the pinned model with a bearer key` — body `model === 'jev-1.13.0'`; header `Authorization === 'Bearer test-key'`; a choice question goes on the wire as `{ type: 'choice', instructions, criteria: options }`, a noul as `{ type: 'noul', instructions, criteria }`.
- `returns typed answers` — a canned Jev response maps to `EngineAnswer`s unchanged.
- `rejects a choice that was not offered` — answer `choice: 'banana'` ⇒ `VoiceEngineError` with `code: 'invalid-answer'`; same for a missing question id and a probability of `1.2`.
- `maps 529 to a VoiceEngineError without the key` — `code: 'http'`, `status: 529`, and `String(error)` does not contain `test-key`.
- `stops on abort` — an aborted signal rejects; a stub that never resolves rejects with `code: 'timeout'` under fake timers advanced 5000 ms.

`fake-engine.test.ts`, table-driven over `{ sentence, card?, pendingProposal?, expect }`:
- `'Open next finished.'` ⇒ `is_command` ≥ 0.9, `action: 'open'`, `status: 'finished'`, `position: 'next'`
- `'um, open the third failed'` ⇒ `position: '3'`, `status: 'failed'`
- `'open first needs you'` ⇒ `position: '1'`, `status: 'needs-you'`
- card `[{ header: 'Library', options: Vitest, Node test }, { header: 'Build', options: Vite, Webpack }]`, sentence `'answer Vitest to question first and the second answer to question second'` ⇒ `action: 'answer'`, `q0_choice: 'Vitest'`, `q1_choice: 'Webpack'`, `q0_span` and `q1_span` name the matching candidate
- same card, `'answer use both to question first'` ⇒ `q0_choice: 'other'`, `q0_span: 'use both'`, `q1_span: 'none'`
- `'tell it: run the tests again'` ⇒ `action: 'tell'`, `tell_start: 'run the tests again'`
- `pendingProposal: 'answer'`, `'Yes, confirmed.'` ⇒ `action: 'confirm'`; `'no'` and `'cancel'` ⇒ `action: 'cancel'`
- `'what a nice day'` ⇒ `is_command` ≤ 0.1, `action: 'none'`
- every asked question id gets an answer whose choice is one of its options.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- packages/cezar/src/voice`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement `engine.ts`, `JevVoiceEngine.decide` and `FakeVoiceEngine.decide`**

Jev: `fetch` with `AbortSignal.any([signal, AbortSignal.timeout(5000)])`; validate every answer
against the question that asked it (offered choice, finite numbers in [0, 1]). The fake answers with
probability 1 for its pick and 0 elsewhere (`confidence: 1`); rules are regexes over the sentence
lower-cased with leading fillers (`um`, `uh`, `so`, `okay`) and trailing `.!?` removed. Ordinal words
(`first`…`tenth`, `one`…`ten`, digits) map to positions and question indices.
`selectVoiceEngine`: `CEZ_DRY_RUN === '1'` ⇒ fake; otherwise Jev with `env.TYPESAFE_API_KEY`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- packages/cezar/src/voice`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cezar/src/voice
git commit -m "feat(voice): add the decision engine seam with Jev and a dry-run fake"
```

---

### Task 3: Build questions and map answers to a decision

**Files:**
- Create: `packages/cezar/src/voice/sentence.ts`, `packages/cezar/src/voice/thresholds.ts`, `packages/cezar/src/voice/decide.ts`
- Modify: `packages/cezar/src/runs/human-ask-summary.ts` (export a reader; `refreshHumanAskSummary` reuses it)
- Test: `packages/cezar/src/voice/sentence.test.ts`, `packages/cezar/src/voice/decide.test.ts`, `packages/cezar/src/runs/human-ask-summary.test.ts` (add cases; create the file if absent)

**Interfaces:**
- Consumes: Task 1 schemas and types; Task 2 `DecisionEngine`, `EngineQuestion`, `EngineAnswer`, `QUESTION_IDS`, `VoiceEngineState`.
- Produces:
  - `readPendingHumanAsk(dataDir: string, runId: string): { requestId: string; questions: AskQuestion[] } | undefined` — the latest pending `ask.requested` from the run's durable history (`readHistoryText` + `pendingHumanAsk`), `undefined` when there is none or the history cannot be read.
  - `candidateSpans(sentence: string): string[]` and `tellStarts(sentence: string): string[]` (`sentence.ts`), each ≤ 20 entries, de-duplicated. Every candidate is offered as said first (only surrounding whitespace, a leading `:`/`,` and a trailing `.!?` trimmed), then cleaned when that differs (no leading `answer`/`and`/`then`/`to`/`for`/filler, never cleaned down to nothing). *Correction from the final review:* this line first cleaned every candidate unconditionally, which dropped dictated words ("tell it: answer the question" lost "answer"); the spec copies dictated text exactly, so cleaning only adds an alternative.
  - `thresholds.ts`: `IS_COMMAND_MIN = 0.5`, `ACTION_MIN = 0.55`, `CONFIRM_MIN = 0.7`, `OPEN_STATUS_SURE = 0.6`, `ANSWER_OPTION_MIN = 0.5`, `OPTION_SELECTED_MIN = 0.5` — the only place thresholds live.
  - `buildVoiceQuestions(state: VoiceEngineState, spans: string[], starts: string[]): Record<string, EngineQuestion>` — the spec's fan-out table: `is_command`, `action` (open, answer, tell, confirm, cancel, none, each with a one-line description; confirm and cancel only while `state.pendingProposal` is set — *correction from the live Jev run, ruling R20*), `status` (`VOICE_STATUS_DESCRIPTIONS` + `none`), `position` (`next`, `previous`, `last`, `'1'`…`'10'` described as "the first one"… + `none`), per card question `q{i}_span` (spans + `none` = "not addressed"), `q{i}_choice` (labels with descriptions + `other` = "the user's own words") or, for multi-select, one noul `q{i}_opt{j}` per option; `tell_start` (starts, or the whole sentence when none were found). The sentence is untrusted reference data, never instructions (same wording as `jev-friction-intake.cjs`).
  - `decideVoice(args: { request: VoiceDecideRequest; ask?: { requestId: string; questions: AskQuestion[] }; recent: VoiceEngineState['recent']; engine: DecisionEngine; decisionId: string; signal: AbortSignal }): Promise<{ decision: VoiceDecision; answers: Record<string, EngineAnswer>; latencyMs: number }>`

Mapping rules for `decideVoice` (code-owned, in this order):
1. `request.proposal` set and `action` ∈ {confirm, cancel} with confidence ≥ `CONFIRM_MIN` ⇒ that arm.
2. `action` is `none` or `action.confidence < ACTION_MIN` ⇒ `none 'not-a-command'` when `is_command.noul < IS_COMMAND_MIN`, else `none 'unclear'`; a confident action goes on to rules 3–5 whatever `is_command` says. *Correction from the live Jev run (ruling R19):* this rule first let `is_command` veto every action, and jev-1.13.0 scored real commands at 0.33–0.47 ("open second failed": 0.33 with `open` at 0.98).
3. `open`: `status`/`position` of `none` ⇒ `none 'unclear'`; position answers `'1'`…`'10'` become numbers; `status.confidence < OPEN_STATUS_SURE` ⇒ add `alternatives`: the next two statuses by probability with the same position.
4. `answer`: no `ask` ⇒ `none 'no-open-question'`. Per question `i`: `q{i}_span === 'none'` ⇒ skip; single-select with an option whose probability ≥ `ANSWER_OPTION_MIN` ⇒ `option [label]`; multi-select options with noul ≥ `OPTION_SELECTED_MIN` ⇒ `option labels`; otherwise `other` with the span text. No question addressed ⇒ `none 'unclear'`.
5. `tell`: no `openRunId` ⇒ `none 'no-open-task'`; else the chosen `tell_start` text.
6. `confirm`/`cancel` without a proposal ⇒ `none 'unclear'`.

- [ ] **Step 1: Write the failing tests**

`sentence.test.ts`:
- `splits at question references` — `'answer Right, go on to question first and Needs changes to question second: drop the wake word'` contains `'Right, go on'`, `'Needs changes'`, `'drop the wake word'` and `'Needs changes: drop the wake word'`.
- `cleans punctuation and fillers` — `'Um, answer Vitest to question one.'` contains `'Vitest'`.
- `finds tell-it starts` — `'tell it: run the tests again'` and `'tell the agent to run the tests again'` both contain `'run the tests again'`.
- `caps the candidates at 20`.

`decide.test.ts` (stub engine returning canned answers per case):
- `opens next finished` ⇒ `{ action: 'open', status: 'finished', position: 'next' }`, no `alternatives`.
- `offers alternatives when the status is unsure` — status probabilities `{ finished: 0.45, done: 0.35, failed: 0.15 }` ⇒ alternatives `[{ status: 'done', … }, { status: 'failed', … }]`.
- `answers a two-question card with an option and an Other` ⇒ `answers: [{ question: 0, kind: 'option', labels: ['Vitest'] }, { question: 1, kind: 'other', text: 'use both' }]`, `askRequestId` from `ask`.
- `skips questions the sentence does not address`.
- `selects several options on a multi-select question`.
- `refuses answer without an open question` ⇒ `none 'no-open-question'`.
- `refuses tell without an open task` ⇒ `none 'no-open-task'`.
- `treats chatter as not a command` ⇒ `none 'not-a-command'` at `is_command: 0.3`.
- `confirms only a pending proposal` — confirm with `proposal` ⇒ `confirm`; without ⇒ `none 'unclear'`.
- `asks every question in one engine call` — the stub records exactly one call containing `is_command`, `action`, `status`, `position`, `tell_start` and every `q{i}_*`.

`human-ask-summary.test.ts`: `reads the pending ask from history` (seed an NDJSON history with one `ask.requested`) and `returns undefined after the answer is delivered` (add a matching `human-input-delivered`).

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- packages/cezar/src/voice packages/cezar/src/runs/human-ask-summary.test.ts`
Expected: FAIL (new modules and export missing).

- [ ] **Step 3: Implement `sentence.ts`, `thresholds.ts`, `buildVoiceQuestions`, `decideVoice` and `readPendingHumanAsk`**

`candidateSpans`: anchors are question references — `question (one|two|three|four|first|second|third|fourth|[1-4])`, `(first|second|third|fourth) question`, optionally preceded by `to`/`for`/`the`; the segments between anchors are candidates, and so is each pair of neighbouring segments joined with `': '`, and each segment's text after a `:`. `tellStarts`: the text after the first `:`, and after each match of `tell (it|the agent|them)( to)?`, `reply( with)?`, `say`, `message( it)?`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- packages/cezar/src/voice packages/cezar/src/runs/human-ask-summary.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cezar/src/voice packages/cezar/src/runs/human-ask-summary.ts packages/cezar/src/runs/human-ask-summary.test.ts
git commit -m "feat(voice): build the fan-out questions and map answers to a decision"
```

---

### Task 4: Routes, gate and decision log

**Files:**
- Create: `packages/cezar/src/voice/routes.ts`, `packages/cezar/src/voice/decision-log.ts`
- Modify: `packages/cezar/src/server/server.ts` (export `type ProjectApiEnv`; build `voiceRoutes`; add `.route('/', voiceRoutes)` to the `v1` chain after `agentConfigRoutes`), `packages/cezar/src/data-gitignore.ts` (`'voice/'`), `BACKWARD_COMPATIBILITY.md` §2 (route rows)
- Test: `packages/cezar/src/server/voice-api.test.ts`, `packages/cezar/src/server/contract-parity.voice.test.ts`, `packages/cezar/src/voice/decision-log.test.ts`, `packages/cezar/src/data-gitignore.test.ts` (create: no test covers this file yet)

**Interfaces:**
- Consumes: Task 1 schemas; Task 2 `DecisionEngine`, `selectVoiceEngine`, `VoiceEngineError`; Task 3 `decideVoice`, `readPendingHumanAsk`.
- Produces:
  - `createVoiceRoutes(deps: { voiceEnabled(): boolean; engine(): DecisionEngine; recent: RecentVoiceActions; uuid?: () => string }): Hono<ProjectApiEnv>` — `.use('/voice/*', gate)` then `.post('/voice/decide', jsonZodValidator(voiceDecideRequestSchema), …)` answering `200 VoiceDecision` or `503 { error: 'Voice decision unavailable (<code>)' }`, and `.post('/voice/outcome', jsonZodValidator(voiceOutcomeRequestSchema), …)` answering `200 { ok: true }` (also for an unknown `decisionId`).
  - `appendVoiceLog(dataDir: string, line: VoiceLogLine): void` — appends one JSON line to `<dataDir>/voice/decisions.ndjson`, creating the directory; never throws. `VoiceLogLine = { type: 'decision'; at; decisionId; sentence; openRunId?; engine: 'jev' | 'fake'; answers; decision; latencyMs } | { type: 'decision-error'; at; decisionId; sentence; code } | { type: 'outcome'; at; decisionId; outcome }`.
  - `class RecentVoiceActions { record(projectId, decisionId, sentence, action): void; settle(projectId, decisionId, outcome): void; last(projectId, n = 3): VoiceEngineState['recent'] }` — in memory, newest last, at most 10 per project.
  - In `server.ts`: `createVoiceRoutes({ voiceEnabled: () => capabilities().voice, engine: () => selectVoiceEngine(process.env), recent: new RecentVoiceActions() })`.

The decide handler ignores an `openRunId` that `project.store.getRun` does not know (it is then
"no open task"), reads the pending ask only for a known run, passes `c.req.raw.signal` to the engine,
writes the log line after the decision (or a `decision-error` line on `VoiceEngineError`), and records
the decision in `RecentVoiceActions`.

- [ ] **Step 1: Write the failing tests**

`voice-api.test.ts` (set up like `automations-gate.test.ts`; inject a stub engine through `createVoiceRoutes` deps where the full server is not needed, and use `startServer` + `apiRequest` for the gate):
- `answers 409 on both routes when voice is off` — error contains `CEZ_VOICE`; nothing written under `voice/`.
- `decides under dry run without a key` — `CEZ_VOICE=1 CEZ_DRY_RUN=1`, `POST /api/v1/voice/decide { text: 'open next finished', sidebarView: 'active' }` ⇒ 200, `action: 'open'`; the same body on `/api/v1/p/default/voice/decide` ⇒ the same arm.
- `answers from the open task's pending card` — a run seeded with an `ask.requested` history; `{ text: 'answer Vitest to question first', openRunId }` ⇒ `action: 'answer'`, `askRequestId` equals the seeded request id.
- `treats an unknown run as no open task` ⇒ `tell` request gives `none 'no-open-task'`.
- `answers 503 when the engine fails` — stub throws `VoiceEngineError('http', 529)`; body `{ error: 'Voice decision unavailable (http)' }`; the log holds a `decision-error` line.
- `refuses bad bodies` — extra key, 501-character text ⇒ 400.
- `records outcomes` — outcome POST ⇒ `200 { ok: true }`; the log's last line is `{ type: 'outcome', … }`.

`contract-parity.voice.test.ts`: the `Mutual` pattern from `contract-parity.automations.test.ts` for `client.api.v1.voice.decide.$post` 200 vs `voiceDecisionSchema` and `client.api.v1.voice.outcome.$post` 200 vs `voiceOutcomeResponseSchema`.

`decision-log.test.ts`: `appends one line per call`, `never throws on an unwritable directory`, `RecentVoiceActions.last returns the three newest with outcomes`.

`data-gitignore.test.ts`: `ignores the voice decision log` — after `ensureDataGitignore(tmpRepo)`, `.ai/cezar/.gitignore` has a `voice/` line; a second call adds no duplicate.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- packages/cezar/src/server/voice-api.test.ts packages/cezar/src/voice/decision-log.test.ts packages/cezar/src/data-gitignore.test.ts`
Expected: FAIL (routes absent: 404s; module missing).

- [ ] **Step 3: Implement the family, the log and the mount; add the BC §2 rows**

BC §2 row, in the style of the automations row: `POST /api/v1/voice/decide`, `POST /api/v1/voice/outcome` (and the scoped spellings) — gated on `CEZ_VOICE=1` plus `TYPESAFE_API_KEY` (or `CEZ_DRY_RUN=1`); off answers `409`.

- [ ] **Step 4: Run the tests and the route guards**

Run: `npm test -- packages/cezar/src/server/voice-api.test.ts packages/cezar/src/voice packages/cezar/src/data-gitignore.test.ts packages/cezar/src/server/route-parity.test.ts packages/cezar/src/server/bc-route-inventory.test.ts packages/cezar/src/server/versioned-surface.test.ts packages/cezar/src/server/typed-bodies.test.ts`, then from `packages/cezar`: `./node_modules/.bin/tsc --noEmit -p tsconfig.test.json` (this checks the parity file).
Expected: PASS. If `typed-bodies.test.ts` lists validated routes explicitly, add both voice routes there.

- [ ] **Step 5: Commit**

```bash
git add packages/cezar/src/voice packages/cezar/src/server packages/cezar/src/data-gitignore.ts BACKWARD_COMPATIBILITY.md
git commit -m "feat(voice): add the gated voice routes and the local decision log"
```

---

### Task 5: Browser client and target resolution

**Files:**
- Modify: `packages/web/src/api/client.ts`
- Create: `packages/web/src/lib/voice/status-map.ts`, `packages/web/src/lib/voice/resolve-open.ts`, `packages/web/src/lib/voice/numbered-pick.ts`
- Test: `packages/web/src/lib/voice/status-map.test.ts`, `packages/web/src/lib/voice/resolve-open.test.ts`, `packages/web/src/lib/voice/numbered-pick.test.ts`

**Interfaces:**
- Consumes: Task 1 types; `bucketOf`, `sortRuns`, `groupRuns`, `sidebarRuns`, `sidebarActiveRunId`, `QuickListRow` (`packages/web/src/lib/task-groups.ts`); `deriveAttention` (`@/lib/attention`); `isUnread` (`@/lib/read-state`).
- Produces:
  - `voiceDecide(input: VoiceDecideRequest, signal?: AbortSignal): Promise<VoiceDecision>` and `reportVoiceOutcome(decisionId: string, outcome: VoiceOutcome): void` (fire and forget; swallows errors) in `client.ts`, scoped with `queryScope()` like `getAutomations`.
  - `voiceStatusMatches(status: VoiceStatus, run: RunSummary): boolean` — sections by `bucketOf(run, 'active')` (`needs-you` → `'Needs you'`, `working` → `'Working'`, `finished` → `'Finished'`); `archived` → `run.archived === true`; `needs-permission` → bucket `'permission'`; `failed` → bucket `'error'`; `needs-review`, `running`, `waiting-for-ci`, `monitoring`, `waiting-for-capacity`, `queued`, `scheduled` → the `deriveAttention(run).label` of the same words; `waiting-on-workers` → label starts with `'waiting on '`; `done`/`cancelled` → `run.status`; `unread` → `isUnread(run)`.
  - `type OpenTarget = { kind: 'run'; runId: string } | { kind: 'group'; groupId: string } | { kind: 'empty' } | { kind: 'past-end' }`
  - `resolveOpenTarget(args: { runs: readonly RunSummary[]; sidebarView: SidebarView; openRunId: string | null; status: VoiceStatus; position: VoicePosition }): OpenTarget` — rows: `archived` ⇒ `sortRuns(runs, 'archived')` without owned workers; otherwise every row of `groupRuns(sidebarRuns(runs, sidebarView), 'active')` across buckets in order, with no cap. A run row matches by its run; a group row matches when any member matches and opens `{ kind: 'group' }`. The current row is the one holding `sidebarActiveRunId(openRunId, runs)`. `next`: the row after the current one, the first row when there is no current one, `past-end` after the last. `previous`: the row before, the last row when there is no current one, `past-end` before the first. A number `n`: row `n − 1` or `past-end`. `last`: the last row. No rows ⇒ `empty`.
  - `parseNumberedPick(text: string, count: number): number | null` — 0-based; reads `2`, `two`, `number two`, `the second`, `second one`; out of range or anything else ⇒ `null`.

- [ ] **Step 1: Write the failing tests**

- `status-map.test.ts`: `matches every status` — one fixture run per id, `voiceStatusMatches(id, fixture) === true`; `covers every contract id` — for each `VOICE_STATUS_IDS` entry the function returns a boolean without throwing; `statuses overlap` — a failed, unread run matches `failed`, `finished` and `unread`.
- `resolve-open.test.ts`: `next from inside the list`; `next when the open task is not in the list is the first`; `next after the last is past-end`; `the third`; `last reaches rows the sidebar cap hides` (12 finished runs ⇒ 12th); `owned workers are skipped and a worker counts from its parent`; `a variant group opens as a group`; `archived walks the archived order`; `automations tab walks only automation tasks`; `no rows is empty`.
- `numbered-pick.test.ts`: `'two'`, `'2'`, `'number two'`, `'The second.'` ⇒ `1`; `'four'` with `count: 3` ⇒ `null`; `'open next'` ⇒ `null`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- packages/web/src/lib/voice`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement the client functions and the three modules**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- packages/web/src/lib/voice`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api/client.ts packages/web/src/lib/voice
git commit -m "feat(web): resolve voice targets from the sidebar order"
```

---

### Task 6: Proposal store, question card and composer

**Files:**
- Create: `packages/web/src/lib/voice/proposal-store.ts`, `packages/web/src/lib/voice/proposal-store.test.ts`
- Modify: `packages/web/src/routes/task-thread/ask-card.tsx`, `packages/web/src/routes/task-thread/ask-card.test.tsx`, `packages/web/src/components/composer/composer.tsx` (`ComposerHandle`), `packages/web/src/components/composer/composer.test.tsx`, `packages/web/src/routes/task-thread/task-thread.tsx`

**Interfaces:**
- Consumes: Task 1 `VoiceAnswer`.
- Produces (`proposal-store.ts`):
  ```ts
  export type VoiceProposal =
    | { kind: 'answer'; decisionId: string; runId: string; askRequestId: string; answers: VoiceAnswer[] }
    | { kind: 'tell'; decisionId: string; runId: string; text: string }
  export interface AskCardTarget { runId: string; requestId: string; headers: string[];
    apply(answers: VoiceAnswer[]): void; restore(): void; unanswered(): number[]; send(): void }
  export interface ComposerTarget { runId: string; getDraft(): string; setDraft(text: string): void; submit(): void }
  export type ProposeResult = { ok: true; replaced?: string } | { ok: false; reason: 'no-card' | 'draft-not-empty' }
  export type ConfirmResult = { ok: true } | { ok: false; unanswered: { index: number; header: string }[] } | { ok: false; reason: 'no-target' }
  export const voiceStore: {
    getProposal(): VoiceProposal | undefined
    propose(p: VoiceProposal): ProposeResult   // an answer for the same askRequestId merges: a later entry for a question replaces the earlier one; `replaced` names the previous decisionId
    confirm(): ConfirmResult
    cancel(): void
    lastDrop(): 'question-closed' | 'task-closed' | undefined   // why the last proposal ended without the user
    registerAskCard(target: AskCardTarget): () => void   // unregistering drops a proposal for that request (lastDrop 'question-closed')
    registerComposer(target: ComposerTarget): () => void   // unregistering drops a tell proposal for that run (lastDrop 'task-closed')
    subscribe(listener: () => void): () => void
  }
  export function useVoiceProposal(): VoiceProposal | undefined   // useSyncExternalStore
  ```
- `ComposerHandle` gains `getDraft(): string`, `setDraft(text: string): void`, `submit(): void` (`submit` runs the same `submitDraft` the send button runs).
- `PendingAsk` registers an `AskCardTarget` while mounted (`RoutedAsk` and resolved cards never do). `apply` snapshots `selections`/`otherAnswers` on the first apply of a proposal, then sets them (an `option` entry selects its labels and clears Other; an `other` entry selects Other with the text); filled blocks get `data-voice-filled="true"`, the card gets `data-voice-proposal="true"` and the confirm prompt (`data-slot="ask-voice-prompt"`, exact copy from Global Constraints), and scrolls into view. `restore` puts the snapshot back. `send` is `sendAll`. Voice never takes the one-tap path.
- `TaskThread` registers a `ComposerTarget` for its run through a `ref` on `<Composer>`; a tell proposal is refused (`draft-not-empty`) when the draft is not empty, otherwise `setDraft(text)` and the composer shows `data-voice-proposal="true"` with the tell prompt; `cancel` empties the draft.

- [ ] **Step 1: Write the failing tests**

- `proposal-store.test.ts`: `merges answers for the same request` (q0 then q1 ⇒ both; q0 again ⇒ replaced, `replaced` is the earlier decisionId); `refuses an answer with no card registered` ⇒ `no-card`; `confirm lists unanswered questions` (two-question card, one answered ⇒ `unanswered: [{ index: 1, header: 'Build' }]`, nothing sent); `confirm sends when every question is answered`; `cancel restores and clears`; `unregistering the card drops its proposal` ⇒ `getProposal() === undefined`, `lastDrop() === 'question-closed'`; `tell is refused when the draft has text`.
- `ask-card.test.tsx`: `voice fills chips and Other and shows the prompt`; `cancel restores a manual choice made before voice`; `confirm sends one combined message` — the mocked delivery receives `'Library: Vitest\nBuild: use both'`; `a one-question card is not sent on apply`; `a routed card registers no target`.
- `composer.test.tsx`: `the handle sets, reads and submits the draft` — `setDraft('hi')`, `getDraft() === 'hi'`, `submit()` calls `onSubmit` with `'hi'`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- packages/web/src/lib/voice/proposal-store.test.ts packages/web/src/routes/task-thread/ask-card.test.tsx packages/web/src/components/composer/composer.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the store, the card target, the composer handle and the thread registration**

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same command. Expected: PASS. Also grep `packages/web/e2e/*.e2e.ts` for `ask-card`, `data-delivery` and the composer's `data-slot` values, and note the matching specs for Task 8's run.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/voice packages/web/src/routes/task-thread packages/web/src/components/composer
git commit -m "feat(web): let voice proposals fill the question card and the composer"
```

---

### Task 7: Palette voice mode

**Files:**
- Create: `packages/web/src/components/voice/use-voice-command.ts`, `packages/web/src/components/voice/voice-rows.tsx`, `packages/web/src/components/voice/use-voice-command.test.tsx`, `packages/web/src/components/command-palette-voice.test.tsx`
- Modify: `packages/web/src/components/command-palette.tsx`

**Interfaces:**
- Consumes: Task 5 `voiceDecide`, `reportVoiceOutcome`, `resolveOpenTarget`, `parseNumberedPick`; Task 6 `voiceStore`, `useVoiceProposal`; `useHealth`; `useRuns`; `useListView`; `useProjectMatch('/tasks/:id/*')`; `useNavigate`.
- Produces:
  - `looksLikeSentence(text: string): boolean` — two or more words after trimming.
  - `useVoiceCommand(args: { enabled: boolean; text: string; close(): void; clearText(): void }): { row: VoiceRow | undefined; mode: 'idle' | 'preview' | 'choosing' | 'proposal'; onEnter(event: KeyboardEvent): boolean /* true = handled */; onClose(): void }` with `type VoiceRow = { kind: 'will-do' | 'notice'; text: string; choices?: string[] }`.

Behavior (`use-voice-command.ts`):
- `enabled` is `health.data?.capabilities.voice === true`; when false the hook returns `{ row: undefined, mode: 'idle', onEnter: () => false }` and makes no request.
- Preview: 300 ms after the last change of a sentence-like `text`, one `voiceDecide` with an `AbortController`; a change aborts the previous request; a response is used only when its text and `openRunId` still match the current ones.
- Enter with `mode === 'proposal'` and an empty input ⇒ `voiceStore.confirm()`: `ok` ⇒ `reportVoiceOutcome(id, 'confirmed')`, close; `unanswered` ⇒ notice `Question <n> (<header>) still needs an answer.` (n is 1-based).
- Enter with `mode === 'choosing'` ⇒ `parseNumberedPick(text, choices.length)` picks an alternative; `null` falls through to the sentence path.
- Enter with sentence-like text ⇒ prevent the default, wait for that text's decision (`// bound: 3000 ms`, then notice `Voice decision timed out.`), then: `open` ⇒ resolve and navigate (`/tasks/<id>` or `/compare/<groupId>`), report `executed`, close; `open` with `alternatives` ⇒ `mode: 'choosing'` with numbered rows; `empty` ⇒ notice `No <status> tasks.`; `past-end` ⇒ notice `No <position> <status> task.`; `answer`/`tell` ⇒ `voiceStore.propose`, on `ok` report `replaced` for `replaced`, clear the input, `mode: 'proposal'`; `no-card` ⇒ notice `This question is not open here.`; `draft-not-empty` ⇒ notice `The message box already has text.`; `confirm`/`cancel` ⇒ as above; `none 'not-a-command'` ⇒ click the selected cmdk item (`[cmdk-item][data-selected="true"]`) so Return does what it does today; other `none` reasons ⇒ notices `Open a task first.`, `This task has no open question.`, `Not sure what to do. Try again.`
- A proposal the store drops on its own (`lastDrop`) ⇒ `abandoned`, `mode: 'idle'` and notice `The question was answered or closed elsewhere.` (`question-closed`) or `The task is no longer open.` (`task-closed`).
- A failed `voiceDecide` (503, network, timeout) ⇒ notice `Voice decision unavailable.`; the committing Enter then falls back to the selected cmdk item, as for `not-a-command`.
- `onClose` (Esc or the dialog closing): a proposal ⇒ `voiceStore.cancel()` and `cancelled`; a preview decision not acted on ⇒ `abandoned`.
- `command-palette.tsx`: render `voice-rows.tsx` first in the list (a `CommandItem` with `forceMount`, `value="voice-will-do"`, `data-slot="voice-row"`), wire `onKeyDown` on `CommandInput` to `onEnter`, call `onClose` from the dialog's close path, and while `mode === 'proposal'` set `data-voice-proposal="true"` on the dialog content, place it at the bottom of the viewport and make the overlay transparent so the highlighted card stays visible. The input keeps focus.

- [ ] **Step 1: Write the failing tests**

`use-voice-command.test.tsx` (mock `voiceDecide`; fake timers):
- `makes no request when voice is off`.
- `previews after 300 ms and shows a Will do row`.
- `ignores a decision for text that has since changed` — two quick changes ⇒ the first request is aborted; only the second result is shown.
- `waits on Enter for the pending decision, then opens the task` — navigate called with `/tasks/<id>`; outcome `executed`.
- `the committing Enter never confirms` — an answer decision creates a proposal and does not call `voiceStore.confirm`; a later Enter on an empty input does.
- `refuses to confirm with an unanswered question` — notice text exact.
- `drops a decision made for another open task` — `openRunId` changes while the request is in flight ⇒ no proposal.
- `numbered alternatives pick with "two"`.
- `Esc cancels a proposal and reports cancelled`.

`command-palette-voice.test.tsx`: `renders no voice row when the capability is off` (the palette's DOM matches today's for the same input); `renders the Will do row first when on`; `docks the palette during a proposal` (`data-voice-proposal="true"`).

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- packages/web/src/components/voice packages/web/src/components/command-palette-voice.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the hook, the rows and the palette wiring**

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same command, then `npm test -- packages/web/src/components/command-palette.test.tsx` and `npm run typecheck:web`.
Expected: PASS. Grep `packages/web/e2e/*.e2e.ts` for `cmdk`, `command-palette` and the palette placeholder text, and note the matching specs for Task 8's run.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components
git commit -m "feat(web): add voice mode to the command palette"
```

---

### Task 8: Dry-run mock and browser E2E

**Files:**
- Modify: `packages/cezar/scripts/mock-claude.mjs` (a `mock:multi-ask` branch)
- Create: `packages/web/e2e/voice.e2e.ts`

**Interfaces:**
- Consumes: everything above; the fixture-server helpers used by `packages/web/e2e/automations.e2e.ts` (`spawnFixtureServer`, `fixtureServeEnv`, `waitForFixtureServer`, `bootProjectId`, `AgentBrowser`).
- Produces: `mock:multi-ask` — the reply ends with `CEZ:ASK {"questions":[{"header":"Library","question":"Which test library?","options":[{"label":"Vitest"},{"label":"Node test"}]},{"header":"Build","question":"Which build tool?","options":[{"label":"Vite"},{"label":"Webpack"}]}]}`, placed before the `mock:ask` branches so it cannot be matched by them.

- [ ] **Step 1: Write the E2E spec**

`voice.e2e.ts`, one fixture server with `fixtureServeEnv(root, { CEZ_VOICE: '1' })` (dry run is on in that env):
- `opens the first task that needs you` — create a task with prompt `mock:multi-ask`, wait for `[data-slot="ask-card"][data-resolved="false"]`, go to the tasks pane, ⌘K, type `open first needs you`, wait for `[data-slot="voice-row"]`, press Enter, wait for the URL to contain the run id.
- `answers both questions, then confirms` — ⌘K, type `answer Vitest to question first and the second answer to question second`, Enter, wait for two `[data-voice-filled="true"]` blocks and `[data-slot="ask-voice-prompt"]`, type `yes, confirmed`, Enter, wait for `[data-slot="ask-card"][data-resolved="true"]` showing `Library: Vitest` and `Build: Webpack`.
- `refuses to confirm an incomplete card` — new `mock:multi-ask` task; answer only question first; Enter on the empty input; wait for the text `Question 2 (Build) still needs an answer.`
- `cancel restores the card` — answer, then Esc; wait for no `[data-voice-filled]`.
- `tell it fills and sends a message` — on a parked task, `tell it: run the tests again`, wait for the composer's `data-voice-proposal`, `yes, confirmed`, wait for the user message in the thread.
- `voice is absent by default` — on the shared test environment (flag off), ⌘K, type `open next finished`, and assert no `[data-slot="voice-row"]` after the palette search settles.

Follow `packages/web/e2e/README.md`: every read after an action is a `wait`/`waitForValue`.

- [ ] **Step 2: Run it to verify it fails, then add the mock branch**

Run: `npm run test:e2e -- voice.e2e.ts`
Expected: FAIL at the first ask-card wait (no `mock:multi-ask` yet). Add the branch, then run again.

- [ ] **Step 3: Run it to verify it passes**

Run: `npm run test:e2e -- voice.e2e.ts`
Expected: `TEST_E2E_STATUS=passed`.

- [ ] **Step 4: Run the checks AGENTS.md requires for a mock change**

From the repo root: the dry-run park fixtures (`grep -lE "waitForStatus\([^)]*'waiting'|hasPendingHumanAsk|attentionLabel|'mock:" packages/web/e2e/*.e2e.ts packages/cezar/test/e2e/*.test.ts`), the runner parity suites (`packages/cezar/src/core/*-parity.test.ts`, `packages/cezar/src/workflows/*-parity.test.ts`), and the specs noted in Tasks 6 and 7, through Squeal (`squeal status --wait 60000 <files>`) or the npm commands in AGENTS.md § Validation. Run `npm run build` before packaged fixtures.
Expected: all pass; record the commands and results in the handoff.

- [ ] **Step 5: Commit**

```bash
git add packages/cezar/scripts/mock-claude.mjs packages/web/e2e/voice.e2e.ts
git commit -m "test(e2e): drive voice mode through the palette under dry run"
```
