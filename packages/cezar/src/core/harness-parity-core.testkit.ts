/**
 * Shared fixtures for the harness parity matrix (`harness-parity.test.ts`,
 * spec `.ai/specs/2026-09-04-harness-parity-matrix.md`, #68).
 *
 * `ui-parity.test.ts` pins one axis: every mapper emits every v2 UI capability.
 * This kit supports the other one — the session, lifecycle and error-path
 * contract in `agent-runner.ts` — by driving each backend's REAL runner class
 * against that backend's own offline mock binary.
 *
 * Two deliberate choices live here rather than in the suite:
 *  - **scenario NAMES are shared, spellings are not.** Every mock is already
 *    driven by `mock:<scenario>` markers found in the prompt text, and those
 *    markers were written alongside the golden fixtures. The adapter maps a
 *    shared name onto whatever a backend already calls it, so the matrix
 *    renames nothing and churns no passing runner test.
 *  - **the transport is an explicit `CEZ_*_BIN`, never `CEZ_DRY_RUN`.** A row's
 *    transport is then visible in the adapter instead of implied by a global,
 *    and a backend with no dry-run short-circuit is driven the same way as one
 *    that has it.
 *
 * The run tier, which drives a real `RunManager`, lives in `workflow-parity.testkit.ts`. This
 * kit imports no workflow-engine module, so a runner-adapter test does not load the engine
 * (hearsay-tools/cezarion#2938); `harness-parity-closure.test.ts` holds it to that.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WAIT_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { AgentRunSpec, AgentEvent, AgentRunResult, AgentSession, RunnerId, SessionOptions } from './agent-runner.ts';
import { runnersUnderTest } from './runners-under-test.testkit.ts';
import { runnersWhere, type RunnerFacts } from './runner-facts.ts';
import { UNSET_TOOL_GRANT } from './tool-grant.testkit.ts';
import type { UiEvent } from './ui-events.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The shared scenario catalog. A name, not a marker.
 *
 * | Scenario | The mock must |
 * | --- | --- |
 * | `baseline` | one text, one tool call and result, a later visible assistant message, usage, then its terminal turn signal |
 * | `mcp-approval` | ask the native client before another MCP server's tool call, then echo the exact answer and end the turn |
 * | `cezar-done` | the same, calling `cezar_done` before its final text so the run reaches its review gate |
 * | `hold` | delay the terminal turn signal after the last content event |
 * | `hold-cezar-done` | like `hold`, then call `cezar_done` so a mid-turn follow-up can race the close (#486) |
 * | `hold-cezar-ask` | like `hold`, then call `cezar_ask` so a mid-turn follow-up can race the park (#486) |
 * | `provider-error` | a request the provider rejects as invalid (HTTP 400) in its native error shape; the run fails |
 * | `provider-error-controlled` | the same 400, raised by the mock's failure control (`failure: 'provider'`) |
 * | `provider-unavailable` | the provider is unreachable or answers 503 (Codex: its own stream retries); the run holds |
 * | `provider-rate-limit` | a 429 with no reset time in its native error shape; the run holds |
 * | `provider-not-found` | a 404 from the model endpoint in its native error shape; the run holds |
 * | `provider-credit` | a spent credit balance in its native error shape; the run holds |
 * | `approval` | a native permission request Squawk routes to the cockpit; no turn end until it is answered |
 * | `permission-default` | a native built-in default permission ask Squawk answers itself, then call `cezar_done` (#1266) |
 * | `approval-resolved` | the `approval` request, which the backend settles itself once `CEZ_MOCK_RELEASE_FILE` exists, then `cezar_done` |
 * | `approval-turn-end` | the `approval` request, still pending when the turn ends after `cezar_done` once `CEZ_MOCK_RELEASE_FILE` exists |
 * | `approval-reply-fails` | the `approval` request, whose first answer the backend refuses to accept; a later answer ends the turn |
 * | `approval-malformed` | a malformed native permission request; the backend calls `cezar_done` and ends the turn once it is refused |
 * | `permission-classify` | a request the backend settles while Squawk reads its config, then a marker request (`CEZ_MOCK_RELEASE_FILE` gates) |
 * | `permission-late` | the turn ends after `cezar_done`, then a native permission request from a run the server started; its answer resumes that run, which calls `cezar_done` |
 * | `ask` | an ask — native where the wire has one (Codex, OpenCode), a `cezar_ask` call (`mock:cezar-ask`) otherwise |
 * | `ask-resume` | accept one human answer, then call `cezar_done` without another prompt (`mock:resume-cezar-done`) |
 * | `cezar-ask` | call `cezar_ask` with one "Which test library?" question, then end the turn — the same tool call on every wire, fresh or resumed |
 * | `cezar-wait` | call `cezar_wait` for a 60 s timer, then end the turn — a declared monitoring park on every wire |
 * | `ask-reply-late` | native ask whose reply acknowledgement can lag the resumed turn |
 * | `ask-bad` | a malformed native ask, and then still end the turn (the runners with no native ask have none) |
 * | `subagent` | child work and terminal signal, then parent text after a `cezar_wait` timer, followed by late child text |
 * | `forked-skill` | a skill call that runs as a native forked subagent: child work nested under the call, then its result and final text |
 * | `hook-after-park` | a mid-turn hook with context, a `cezar_wait` park, then a late hook (#961) |
 * | `steer-tool` | one slow tool; agent input sent while it runs is read before the turn ends (#505) |
 * | `steer-late` | the final text first; agent input sent after it arrives after the last model call (#505) |
 * | `silent-tail` | visible assistant text, a tool, then reasoning that names cezar_done, and no later message |
 * | `silent-tail-ack-delay` | silent-tail as a follow-up whose transport ACK is held until after turn-end |
 * | `silent-tail-no-reply` | the same first turn; a final-message nudge is ACKed and never opens a turn |
 * | `silent-tail-late-reply` | the same first turn; a final-message nudge is ACKed, then replies after the bound |
 * | `silent-tail-late-turn-start` | the same first turn; after the bound, native turn-start holds before any content |
 * | `silent-tail-slow-done` | the same first turn; a nudge reply starts before the bound and ends after it |
 * | `serve-start-exit` | the backend server's first start exits before listening; the next start answers `baseline` |
 *
 * hearsay-tools/cezarion#2397 removed the lifecycle markers, and with them the scenarios that
 * drove marker parsing only (`split-text`, `ask-snapshot`, `ask-snapshot-bad`, `ask-prose`).
 */
export const SCENARIOS = [
  'approval',
  'permission-default',
  'approval-resolved',
  'approval-turn-end',
  'approval-reply-fails',
  'approval-malformed',
  'permission-classify',
  'permission-late',
  'mcp-approval',
  'multi-pr-refs',
  'auto-resumed',
  'turn-messages',
  'skill-warning',
  'closed-input',
  'input-closed-live',
  'missing-binary',
  'serve-start-exit',
  'crash-stderr-pre-ack',
  'crash-stderr-held-pipe',
  'shutdown-stderr',
  'crash-stderr',
  'crash-stderr-single',
  'autonomous',
  'autonomous-cap',
  'autonomous-cezar-ask-cap',
  'silent-tail',
  'silent-tail-ack-delay',
  'silent-tail-no-reply',
  'silent-tail-late-reply',
  'silent-tail-late-turn-start',
  'silent-tail-slow-done',
  'baseline',
  'cezar-done',
  'hold',
  'hold-gated',
  'hold-cezar-done',
  'hold-cezar-ask',
  'no-progress',
  'no-progress-ignore-term',
  'no-progress-held-pipe',
  'no-progress-ack-only',
  'no-progress-leftover',
  'busy-progress',
  'provider-error',
  'provider-error-controlled',
  'provider-unavailable',
  'provider-rate-limit',
  'provider-not-found',
  'provider-credit',
  'post-success-refusal',
  'ask',
  'ask-resume',
  'ask-bad',
  'ask-reply-late',
  'cezar-ask',
  'cezar-wait',
  'subagent',
  'subagent-after-park',
  'forked-skill',
  'hook-after-park',
  'steer-tool',
  'steer-late',
] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

/** hearsay-tools/cezarion#843: real OS failures after each native prompt is admitted. */
export const SHUTDOWN_CRITERIA = [
  { id: 'S22', scenario: 'no-progress', name: 'treats an outside signal as failure' },
  { id: 'S23', scenario: 'no-progress', name: 'end escalates when the child cannot process EOF or SIGTERM' },
  { id: 'S24', scenario: 'no-progress', name: 'stops the live child when its output transport fails' },
  // hearsay-tools/cezarion#890: the session leader's own process group.
  { id: 'S26', scenario: 'no-progress-leftover', name: 'the session leader leads its own process group' },
  { id: 'S27', scenario: 'no-progress-leftover', name: "stop ends the leader's process group but not a setsid child" },
  { id: 'S28', scenario: 'no-progress-leftover', name: 'end escalation reaches the whole process group' },
  { id: 'S29', scenario: 'input-closed-live', name: 'settles a live native input transport failure without false success' },
  // hearsay-tools/cezarion#1286: a session that ends without a signal from Squawk.
  { id: 'S30', scenario: 'no-progress-leftover', name: 'a leader that exits on its own leaves nothing in its process group' },
  { id: 'S31', scenario: 'no-progress-leftover', name: 'a leader killed from outside leaves nothing in its process group' },
  { id: 'S33', scenario: 'no-progress', name: 'preserves outside-signal failure when native exit notification follows EOF cleanup' },
  { id: 'S34', scenario: 'no-progress', name: 'preserves delayed outside-signal failure when all process probes are unavailable' },
] as const;

/** hearsay-tools/cezarion#1351: earlier success must not swallow a later native rejection. */
export const MODEL_REFUSAL_CRITERIA = [
  { id: 'S32', scenario: 'post-success-refusal', name: 'bounds a provider refusal after prior success and retains its diagnosis' },
] as const;

/** #427: intermediate asks through cezar_ask, on every native message wire. Q2 (a malformed
 *  intermediate marker) went with the CEZ:ASK line (hearsay-tools/cezarion#2397). */
export const WORKFLOW_ASK_CRITERIA = [
  { id: 'Q4', scenario: 'cezar-ask', name: 'idle close, a second question on Continue and a clean close before its answer retain the workflow tail' },
  { id: 'Q5', scenario: 'cezar-ask', name: 'restart preserves the unanswered question and resumes the tail after an answer' },
  { id: 'Q6', scenario: 'cezar-ask', name: 'cancel leaves later steps pending' },
  { id: 'Q8', scenario: 'cezar-ask', name: 'an authored timeout fails without running later steps' },
] as const;

/** hearsay-tools/cezarion#1620: workflow-step-completion-parity.testkit.ts, every native wire. An
 *  earlier agent step completes only on an accepted done; the tail never starts without one. */
export const STEP_COMPLETION_CRITERIA = [
  { id: 'C1', scenario: 'baseline', name: 'an earlier step without done is nudged once, then waits for the user; a reply with done runs the tail' },
  { id: 'C3', scenario: 'baseline', name: 'a clean session close without done leaves the earlier step waiting; Continue with done runs the tail' },
  { id: 'C4', scenario: 'baseline', name: 'an idle close leaves the earlier step waiting; a Continue without done parks on it again' },
  { id: 'C5', scenario: 'baseline', name: 'restart recovery keeps the parked earlier step; Continue with done runs the tail' },
  { id: 'C6', scenario: 'autonomous', name: 'an autonomous earlier step is nudged to its done, then the tail runs' },
] as const;

/** #470: exercised in workflow-timeout-parity.testkit.ts against every native wire. */
// T1, T2 and T5 hold their turn and then signal done, which an earlier step needs
// since hearsay-tools/cezarion#1620.
export const WORKFLOW_TIMEOUT_CRITERIA = [
  { id: 'T1', scenario: 'hold-cezar-done', name: 'default non-final steps outlive the runner deadline' },
  { id: 'T2', scenario: 'hold-cezar-done', name: 'explicit zero disables the workflow deadline' },
  { id: 'T3', scenario: 'hold', name: 'authored positive deadlines fail without running trailing checks' },
  { id: 'T4', scenario: 'hold', name: 'standalone sessions retain the default deadline' },
  { id: 'T5', scenario: 'hold-cezar-done', name: 'an authored longer limit replaces the runner default' },
  { id: 'T6', scenario: 'hold', name: 'default tasks remain unlimited' },
  { id: 'T7', scenario: 'hold', name: 'a set spec.timeoutMs replaces the runner default deadline' },
] as const;

export const NO_PROGRESS_CRITERIA = [
  { id: 'N1', scenario: 'no-progress', name: 'stalled nonfinal turns fail and release capacity' },
  { id: 'N2', scenario: 'busy-progress', name: 'native progress keeps a long turn alive' },
  { id: 'N3', scenario: 'baseline', name: 'parked sessions outlive inactivity and followups rearm it' },
  { id: 'N5', scenario: 'no-progress-ignore-term', name: 'stalled processes ignoring TERM are killed before releasing capacity' },
  { id: 'N6', scenario: 'ask', name: 'native questions or cezar_ask pause protection until answered' },
  { id: 'N7', scenario: 'no-progress-held-pipe', name: 'descendant-held pipes cannot retain capacity after CLI exit' },
  { id: 'N8', scenario: 'no-progress-ack-only', name: 'agent input rearms protection even without a native turn-start notification' },
  { id: 'N4', scenario: 'baseline', name: 'Continue sessions enforce inactivity' },
] as const;

/** #486: workflow-followup-cells.testkit.ts, real native wires on both turn-end paths. */
export const FOLLOWUP_CRITERIA = [
  { id: 'H1', scenario: 'hold-cezar-done', name: 'keeps a mid-turn human follow-up across a cezar_done turn' },
  { id: 'H2', scenario: 'hold-cezar-ask', name: 'drops a mid-turn human follow-up when the turn parks on cezar_ask' },
  { id: 'H3', scenario: 'hold-gated', name: 'does not park or nudge between a done-less turn and a mid-turn follow-up' },
  { id: 'H4', scenario: 'hold-gated', name: 'does not park before a held follow-up whose native turn starts late' },
  { id: 'H5', scenario: 'hold-gated', name: 'does not park before a late-acknowledged steer that runs after the turn' },
] as const;

/** #426: workflow-autonomous-parity.testkit.ts, real native wires on both turn-end paths. */
export const AUTONOMOUS_CRITERIA = [
  { id: 'A1', scenario: 'autonomous', name: 'nudges fresh markerless turns to completion' },
  { id: 'A2', scenario: 'autonomous', name: 'hydrates autonomous Continue sessions' },
  { id: 'A3', scenario: 'cezar-ask', name: 'refuses cezar_ask on fresh turns and nudges to completion' },
  { id: 'A4', scenario: 'cezar-ask', name: 'refuses cezar_ask on Continue and nudges to completion' },
  { id: 'A5', scenario: 'autonomous-cap', name: 'parks at the cap with an explicit note' },
  { id: 'A6', scenario: 'autonomous', name: 'keeps non-autonomous parking reachable' },
  { id: 'A7', scenario: 'cezar-wait', name: 'parks on a cezar_wait timer without a nudge' },
  { id: 'A8', scenario: 'cezar-done', name: 'honors cezar_done without a nudge' },
  { id: 'A9', scenario: 'ask', name: 'preserves native mid-turn questions' },
  { id: 'A10', scenario: 'cezar-ask', name: 'never continues past a persisted unanswered question' },
  { id: 'A11', scenario: 'autonomous-cezar-ask-cap', name: 'continues after a refused cezar_ask and delayed readiness' },
  { id: 'A12', scenario: 'autonomous-cezar-ask-cap', name: 'continues a resumed refused cezar_ask after delayed readiness' },
] as const;

/** #544: workflow-final-message-cells.testkit.ts, the no-wait nudge's reply bound on every native wire. */
export const FINAL_MESSAGE_CRITERIA = [
  { id: 'F7', scenario: 'silent-tail-ack-delay', name: 'nudges a silent tail after a delayed ACK' },
  { id: 'F8', scenario: 'silent-tail-no-reply', name: 'parks waiting when a nudge is ACKed without a turn' },
  { id: 'F9', scenario: 'silent-tail-late-reply', name: 'resumes when a nudge reply arrives after the bound' },
  { id: 'F10', scenario: 'silent-tail-slow-done', name: 'content that starts before the bound clears it' },
  { id: 'F11', scenario: 'silent-tail-late-turn-start', name: 'resumes on a late native turn-start before content' },
] as const;

/** hearsay-tools/cezarion#1138: worker-wait-conversations.test.ts, every native parent wire. */
export const WORKER_PROGRESS_WAIT_CRITERIA = [
  { id: 'WP1', scenario: 'hold', name: 'delivers progress without retiring the registered worker wait' },
  { id: 'WP2', scenario: 'hold', name: 'preserves a resumed request past 45 minutes and delivers a late reply amendment' },
] as const;

/** #790: skill system prompt on Continue and restart recovery, every native wire. */
export const SKILL_RESUME_CRITERIA = [
  { id: 'R53', scenario: 'baseline', name: 'keeps the skill system prompt on Continue' },
  { id: 'R54', scenario: 'baseline', name: 'keeps the skill system prompt when recover() resumes a persisted continuation' },
  { id: 'R55', scenario: 'baseline', name: 'warns once when a resent continued skill is gone' },
  { id: 'R56', scenario: 'baseline', name: 'declares systemPromptOnResume matching the resume wire' },
  { id: 'R57', scenario: 'baseline', name: 'reuses the recorded session id on Continue and recover' },
  { id: 'R59', scenario: 'baseline', name: 'recovers a continued session before its next session event' },
] as const;

/** hearsay-tools/cezarion#1408: the selected skill and its companions reach every runner's task worktree. */
export const SKILL_PROVISION_CRITERIA = [
  { id: 'R92', scenario: 'baseline', name: 'provisions the selected skill and its companions on Start' },
  { id: 'R93', scenario: 'baseline', name: "provisions the selected skill's companions on an ordinary Continue" },
  { id: 'R94', scenario: 'baseline', name: 'provisions them when recover() resumes a continuation with no live session' },
  { id: 'R95', scenario: 'baseline', name: 'delivers a live /name, then one input naming what was installed' },
  { id: 'R96', scenario: 'baseline', name: 'Stop during skill preparation launches nothing' },
] as const;

/** hearsay-tools/cezarion#917: worktree setup's note reaches every runner's opening message. */
export const WORKTREE_SETUP_CRITERIA = [
  { id: 'R58', scenario: 'baseline', name: 'delivers the worktree setup note in the opening message' },
] as const;

/** hearsay-tools/cezarion#935: conversation-answer-delivery.testkit.ts, a Continue executing a human answer. */
export const ANSWER_DELIVERY_CRITERIA = [
  { id: 'I3', scenario: 'steer-tool', name: 'steers a conversation message into a running human answer and reports it read before that turn ends' },
  { id: 'I4', scenario: 'hold-gated', name: 'delivers a conversation message to a running human answer as its input delivery declares' },
  { id: 'I5', scenario: 'cezar-ask', name: 'holds conversation input behind a native question and delivers it beside a cezar_ask one, never as its answer' },
] as const;

/** Native approvals, exercised through the manager and HTTP route (P1), and a backend's own
 *  built-in permission asks, which Squawk answers without parking (P2, hearsay-tools/cezarion#1266).
 *  P3–P8 pin the pending request's lifecycle: it holds from receipt until the backend settles it.
 *  P9 routes an MCP tool approval for another server (hearsay-tools/cezarion#1294). */
export const PERMISSION_CRITERIA = [
  { id: 'P1', scenario: 'approval', name: 'routes explicit native approval decisions and settles the turn' },
  { id: 'P2', scenario: 'permission-default', name: "answers a backend's built-in default permission ask without parking" },
  { id: 'P3', scenario: 'approval-resolved', name: 'retires a pending native request the backend settles itself' },
  { id: 'P4', scenario: 'approval-turn-end', name: 'retires a native request still pending when its turn ends' },
  { id: 'P5', scenario: 'approval-reply-fails', name: 'keeps a native request answerable when its answer is not accepted' },
  { id: 'P6', scenario: 'approval-malformed', name: 'refuses a malformed native request instead of hanging on it' },
  { id: 'P7', scenario: 'permission-classify', name: 'holds agent input from receipt and shows no card for a request settled before it' },
  { id: 'P8', scenario: 'permission-late', name: 'reopens the turn for a request that arrives after it ended, and closes the session once it is answered' },
  { id: 'P9', scenario: 'mcp-approval', name: 'routes an MCP tool approval for another server and settles the turn (hearsay-tools/cezarion#1294)' },
] as const;

export interface HarnessAdapter {
  readonly backend: RunnerId;
  /** Every human ask wire this runner exposes; cezar_ask when it has no native one. */
  readonly askResumeCases: readonly {
    kind: string;
    scenario: 'ask-resume';
    answer: string;
  }[];
  /** The env var this backend's runner already reads to locate its binary. */
  readonly binEnv: string;
  /** Absolute path to the offline mock binary. */
  readonly mockBin: string;
  /** Scenario name -> the prompt text this backend's mock answers it with. */
  readonly scenarios: Readonly<Partial<Record<ScenarioName, string>>>;
  /** P1: the option to pick (matched case-insensitively against its label) and the text the
   *  mock echoes once that native reply arrives. Required with `scenarios.approval`. */
  readonly approvalDecisions?: readonly { pick: string; echo: string }[];
  /** P6: the text the mock echoes once Squawk refuses its malformed request. Required with
   *  `scenarios['approval-malformed']`. */
  readonly malformedApprovalEcho?: string;
}

/** Resolved from this file, not the cwd, so the paths hold wherever vitest runs. */
const CLAUDE_MOCK = join(HERE, '..', '..', 'scripts', 'mock-claude.mjs');
const PI_MOCK = join(HERE, '..', '..', 'scripts', 'mock-pi-rpc.mjs');
/** Created by the OMP runner's mock task; HARNESS_ADAPTERS.omp stays red until it exists. */
const OMP_MOCK = join(HERE, '..', '..', 'scripts', 'mock-omp-rpc.mjs');
const CODEX_MOCK = join(HERE, '..', '..', 'scripts', 'mock-codex-app-server.mjs');
const OPENCODE_MOCK = join(HERE, '..', '..', 'scripts', 'mock-opencode-serve.mjs');

/** No marker: every mock's default branch answers this with its scripted turn. */
const BASELINE_PROMPT = 'inspect the working tree';

/** `mock:cezar-tool` (scripts/mock-ci-tool.mjs) calls one Squawk tool over the session's own wire,
 *  then `mock:then` ends the turn with that text. Every mock answers it the same way, on a fresh
 *  turn and on a resumed one, so `cezar-ask` and `cezar-wait` are one prompt for every runner. */
const squawkToolPrompt = (name: 'cezar_ask' | 'cezar_wait', args: Record<string, unknown>, then: string): string =>
  `mock:cezar-tool ${name} ${Buffer.from(JSON.stringify(args)).toString('base64url')} mock:then ${Buffer.from(then).toString('base64url')}`;
/** The question every `cezar-ask` turn sends. */
export const SQUAWK_ASK_QUESTION = 'Which test library?';
const SQUAWK_ASK_PROMPT = squawkToolPrompt('cezar_ask', {
  context: 'A choice is needed before I continue.',
  questions: [{ header: 'Library', question: SQUAWK_ASK_QUESTION, options: [{ label: 'Vitest' }, { label: 'Node test' }] }],
}, 'Pick one.');
const SQUAWK_WAIT_PROMPT = squawkToolPrompt('cezar_wait', { kind: WAIT_KIND.timer, seconds: 60, note: 'Re-check the downstream work.' },
  'parity cezar-wait: waiting on downstream work');
const SQUAWK_TOOL_SCENARIOS = { 'cezar-ask': SQUAWK_ASK_PROMPT, 'cezar-wait': SQUAWK_WAIT_PROMPT } as const;

/** The id Squawk pins on every session, mirroring `RunManager`. */
export const PINNED_SESSION_ID = '0e5f1a7c-1c3e-4d2a-9b64-2f7a5c8d1e90';

/** Pre-create a session the OpenCode mock will GET on resume, so a Continue cell
 *  exercises GET+PATCH instead of the 404 fallback that POSTs a fresh session. */
export function seedOpencodeMockSession(
  argsFile: string,
  session: { id?: string; title?: string; permission?: unknown[] } = {},
): void {
  const id = session.id ?? PINNED_SESSION_ID;
  writeFileSync(`${argsFile}.opencode-sessions.json`, JSON.stringify({
    seq: 1,
    sessions: {
      [id]: {
        id,
        title: session.title ?? 'cezar task',
        prompts: [],
        ...(session.permission ? { permission: session.permission } : {}),
      },
    },
  }));
}

export const HARNESS_ADAPTERS: Readonly<Record<RunnerId, HarnessAdapter>> = {
  claude: {
    backend: 'claude',
    askResumeCases: [{ kind: 'cezar_ask', scenario: 'ask-resume', answer: 'Library: Vitest' }],
    binEnv: 'CEZ_CLAUDE_BIN',
    mockBin: CLAUDE_MOCK,
    scenarios: {
      ...SQUAWK_TOOL_SCENARIOS,
      'input-closed-live': 'mock:no-progress-input-closed',
      'multi-pr-refs': 'mock:multi-pr-refs',
      'turn-messages': 'mock:turn-messages',
      'missing-binary': BASELINE_PROMPT,
      autonomous: 'mock:autonomous',
      'autonomous-cap': 'mock:autonomous-cap',
      'autonomous-cezar-ask-cap': 'mock:autonomous-cezar-ask-cap',
      'silent-tail': 'mock:silent-tail',
      'silent-tail-no-reply': 'mock:silent-tail-no-reply',
      'silent-tail-late-reply': 'mock:silent-tail-late-reply',
      'silent-tail-slow-done': 'mock:silent-tail-slow-done',
      baseline: BASELINE_PROMPT,
      'no-progress-ack-only': BASELINE_PROMPT,
      'crash-stderr-pre-ack': 'mock:crash-stderr-pre-ack',
      'crash-stderr-held-pipe': 'mock:crash-stderr-held-pipe',
      'shutdown-stderr': 'mock:crash-stderr-clean',
      'crash-stderr': 'mock:crash-stderr',
      'crash-stderr-single': 'mock:crash-stderr-single',
      'cezar-done': 'mock:cezar-done',
      hold: 'mock:hold', 'hold-gated': 'mock:hold-gated', 'hold-cezar-done': 'mock:hold-cezar-done', 'hold-cezar-ask': 'mock:hold-cezar-ask', 'no-progress': 'mock:no-progress', 'no-progress-ignore-term': 'mock:no-progress-ignore-term', 'no-progress-held-pipe': 'mock:no-progress-held-pipe', 'no-progress-leftover': 'mock:no-progress-leftover', 'busy-progress': 'mock:busy-progress',
      // `mock:auth-error` is a gated failure-control prompt; the control's provider failure is a 400.
      'provider-error': 'mock:request-error', 'provider-error-controlled': 'mock:auth-error',
      'provider-unavailable': 'mock:provider-unavailable',
      'provider-rate-limit': 'mock:provider-rate-limit', 'provider-not-found': 'mock:provider-not-found', 'provider-credit': 'mock:provider-credit',
      'post-success-refusal': 'mock:model-refusal:always',
      ask: 'mock:cezar-ask',
      'ask-resume': 'mock:cezar-ask mock:resume-cezar-done',
      'ask-reply-late': 'mock:cezar-ask',
      subagent: 'mock:subagents',
      'subagent-after-park': 'mock:subagent-after-park',
      'forked-skill': 'mock:forked-skill',
      'hook-after-park': 'mock:hook-after-park',
      'steer-tool': 'mock:steer-tool',
      // A line written after the last model call runs as the CLI's next queued turn.
      'steer-late': 'mock:hold',
    },
  },
  codex: {
    backend: 'codex',
    askResumeCases: [{ kind: 'item/tool/requestUserInput', scenario: 'ask-resume', answer: 'Library: Vitest' }],
    binEnv: 'CEZ_CODEX_BIN',
    mockBin: CODEX_MOCK,
    approvalDecisions: [
      { pick: 'decline', echo: 'Approval response: {"decision":"decline"}' },
      { pick: 'cancel', echo: 'Approval response: {"decision":"cancel"}' },
    ],
    malformedApprovalEcho: 'Approval error: -32602',
    scenarios: {
      ...SQUAWK_TOOL_SCENARIOS,
      approval: 'mock:approval',
      'approval-resolved': 'mock:approval-resolved',
      'approval-turn-end': 'mock:approval-turn-end',
      'approval-malformed': 'mock:approval-malformed',
      'mcp-approval': 'mock:mcp-approval',
      'input-closed-live': 'mock:no-progress-input-closed',
      'multi-pr-refs': 'mock:multi-pr-refs',
      'turn-messages': 'mock:turn-messages',
      'missing-binary': BASELINE_PROMPT,
      autonomous: 'mock:autonomous',
      'autonomous-cap': 'mock:autonomous-cap',
      'autonomous-cezar-ask-cap': 'mock:autonomous-cezar-ask-cap',
      'silent-tail': 'mock:silent-tail',
      'silent-tail-no-reply': 'mock:silent-tail-no-reply',
      'silent-tail-late-reply': 'mock:silent-tail-late-reply',
      'silent-tail-late-turn-start': 'mock:silent-tail-late-turn-start',
      'silent-tail-slow-done': 'mock:silent-tail-slow-done',
      baseline: BASELINE_PROMPT,
      'no-progress-ack-only': BASELINE_PROMPT,
      'crash-stderr-pre-ack': 'mock:crash-stderr-pre-ack',
      'crash-stderr-held-pipe': 'mock:crash-stderr-held-pipe',
      'shutdown-stderr': 'mock:crash-stderr-clean',
      'crash-stderr': 'mock:crash-stderr',
      'crash-stderr-single': 'mock:crash-stderr-single',
      'cezar-done': 'mock:cezar-done',
      hold: 'mock:hold', 'hold-gated': 'mock:hold-gated', 'hold-cezar-done': 'mock:hold-cezar-done', 'hold-cezar-ask': 'mock:hold-cezar-ask', 'no-progress': 'mock:no-progress', 'no-progress-ignore-term': 'mock:no-progress-ignore-term', 'no-progress-held-pipe': 'mock:no-progress-held-pipe', 'no-progress-leftover': 'mock:no-progress-leftover', 'busy-progress': 'mock:busy-progress',
      // #83: 0.147 reports provider rejection on turn/completed with turn.error.
      'provider-error': 'mock:provider-error', 'provider-error-controlled': 'mock:provider-error',
      'provider-unavailable': 'mock:stream-retry',
      'provider-rate-limit': 'mock:provider-rate-limit', 'provider-not-found': 'mock:provider-not-found', 'provider-credit': 'mock:provider-credit',
      'post-success-refusal': 'mock:provider-error',
      ask: 'mock:native-codex-ask',
      'ask-resume': 'mock:native-codex-ask mock:resume-cezar-done',
      'ask-reply-late': 'mock:native-codex-ask',
      'ask-bad': 'mock:ask-bad',
      // #600's repro: a child thread's own turn/completed must not end the parent.
      subagent: 'mock:child-turn',
      'subagent-after-park': 'mock:subagent-after-park',
      'hook-after-park': 'mock:hook-after-park',
      'steer-tool': 'mock:steer-tool',
      'steer-late': 'mock:steer-late',
    },
  },
  opencode: {
    backend: 'opencode',
    askResumeCases: [{ kind: 'question.asked', scenario: 'ask-resume', answer: 'Library: Vitest' }],
    binEnv: 'CEZ_OPENCODE_BIN',
    mockBin: OPENCODE_MOCK,
    approvalDecisions: [
      { pick: 'reject', echo: 'Approval response: {"reply":"reject"}' },
      { pick: 'allow once', echo: 'Approval response: {"reply":"once"}' },
    ],
    malformedApprovalEcho: 'Approval response: {"reply":"reject"}',
    scenarios: {
      ...SQUAWK_TOOL_SCENARIOS,
      approval: 'mock:approval',
      'permission-default': 'mock:permission-default',
      'approval-resolved': 'mock:approval-resolved',
      'approval-turn-end': 'mock:approval-turn-end',
      'approval-reply-fails': 'mock:approval-reply-fails',
      'approval-malformed': 'mock:permission-malformed',
      'permission-classify': 'mock:permission-classify',
      'permission-late': 'mock:permission-late',
      'input-closed-live': 'mock:no-progress-input-closed',
      'skill-warning': 'mock:skill-warning mock:cezar-done',
      'multi-pr-refs': 'mock:multi-pr-refs', 'turn-messages': 'mock:turn-messages',
      'missing-binary': BASELINE_PROMPT,
      // The failing start is set by driveSeam's env (no prompt exists before listening).
      'serve-start-exit': BASELINE_PROMPT,
      autonomous: 'mock:autonomous',
      'autonomous-cap': 'mock:autonomous-cap',
      'autonomous-cezar-ask-cap': 'mock:autonomous-cezar-ask-cap',
      'silent-tail': 'mock:silent-tail',
      'silent-tail-ack-delay': 'mock:silent-tail f7-delay-ack',
      'silent-tail-no-reply': 'mock:silent-tail-no-reply',
      'silent-tail-late-reply': 'mock:silent-tail-late-reply',
      'silent-tail-slow-done': 'mock:silent-tail-slow-done',
      baseline: BASELINE_PROMPT,
      'no-progress-ack-only': BASELINE_PROMPT,
      'crash-stderr-pre-ack': 'mock:crash-stderr-pre-ack',
      'crash-stderr-held-pipe': 'mock:crash-stderr-held-pipe',
      'shutdown-stderr': 'mock:crash-stderr-clean',
      'crash-stderr': 'mock:crash-stderr',
      'crash-stderr-single': 'mock:crash-stderr-single',
      'cezar-done': 'mock:cezar-done',
      hold: 'mock:hold', 'hold-gated': 'mock:hold-gated', 'hold-cezar-done': 'mock:hold-cezar-done', 'hold-cezar-ask': 'mock:hold-cezar-ask', 'no-progress': 'mock:no-progress', 'no-progress-ignore-term': 'mock:no-progress-ignore-term', 'no-progress-held-pipe': 'mock:no-progress-held-pipe', 'no-progress-leftover': 'mock:no-progress-leftover', 'busy-progress': 'mock:busy-progress',
      'provider-error': 'mock:provider-error', 'provider-error-controlled': 'mock:provider-error',
      'provider-unavailable': 'mock:provider-unavailable',
      'provider-rate-limit': 'mock:provider-rate-limit', 'provider-not-found': 'mock:provider-not-found', 'provider-credit': 'mock:provider-credit',
      'post-success-refusal': 'mock:provider-error',
      ask: 'mock:ask',
      'ask-resume': 'mock:ask mock:resume-cezar-done',
      'ask-reply-late': 'mock:ask-reply-late',
      'ask-bad': 'mock:ask-bad',
      subagent: 'mock:subagent',
      'subagent-after-park': 'mock:subagent-after-park',
      'steer-tool': 'mock:steer-tool',
      'steer-late': 'mock:steer-late',
    },
  },
  cursor: {
    backend: 'cursor',
    askResumeCases: [{ kind: 'cezar_ask', scenario: 'ask-resume', answer: 'Library: Vitest' }],
    binEnv: 'CEZ_CURSOR_BIN',
    mockBin: join(HERE, '..', '..', 'scripts', 'mock-cursor-print.mjs'),
    scenarios: {
      ...SQUAWK_TOOL_SCENARIOS,
      'multi-pr-refs': 'mock:multi-pr-refs',
      'turn-messages': 'mock:turn-messages', 'missing-binary': BASELINE_PROMPT,
      autonomous: 'mock:autonomous',
      'autonomous-cap': 'mock:autonomous-cap',
      'autonomous-cezar-ask-cap': 'mock:autonomous-cezar-ask-cap',
      'silent-tail': 'mock:silent-tail',
      'silent-tail-slow-done': 'mock:silent-tail-slow-done',
      baseline: BASELINE_PROMPT,
      'crash-stderr-pre-ack': 'mock:crash-stderr-pre-ack',
      'crash-stderr-held-pipe': 'mock:crash-stderr-held-pipe',
      'shutdown-stderr': 'mock:crash-stderr-clean',
      'crash-stderr': 'mock:crash-stderr',
      'crash-stderr-single': 'mock:crash-stderr-single', 'cezar-done': 'mock:cezar-done', hold: 'mock:hold', 'hold-gated': 'mock:hold-gated', 'hold-cezar-done': 'mock:hold-cezar-done', 'hold-cezar-ask': 'mock:hold-cezar-ask', 'no-progress': 'mock:no-progress', 'no-progress-ignore-term': 'mock:no-progress-ignore-term', 'no-progress-held-pipe': 'mock:no-progress-held-pipe', 'no-progress-leftover': 'mock:no-progress-leftover', 'busy-progress': 'mock:busy-progress', 'provider-error': 'mock:provider-error', 'provider-error-controlled': 'mock:provider-error',
      'provider-unavailable': 'mock:provider-unavailable',
      'provider-rate-limit': 'mock:provider-rate-limit', 'provider-not-found': 'mock:provider-not-found', 'provider-credit': 'mock:provider-credit',
      'post-success-refusal': 'mock:provider-error',
      ask: 'mock:cezar-ask',
      'ask-resume': 'mock:cezar-ask mock:resume-cezar-done', 'ask-bad': 'mock:ask-bad', 'ask-reply-late': 'mock:cezar-ask-reply-late' },
  },
  pi: {
    backend: 'pi',
    askResumeCases: [{ kind: 'cezar_ask', scenario: 'ask-resume', answer: 'Library: Vitest' }],
    binEnv: 'CEZ_PI_BIN',
    mockBin: PI_MOCK,
    scenarios: {
      ...SQUAWK_TOOL_SCENARIOS,
      'input-closed-live': 'mock:no-progress-input-closed',
      'multi-pr-refs': 'mock:multi-pr-refs',
      'turn-messages': 'mock:turn-messages',
      'missing-binary': BASELINE_PROMPT,
      autonomous: 'mock:autonomous',
      'autonomous-cap': 'mock:autonomous-cap',
      'autonomous-cezar-ask-cap': 'mock:autonomous-cezar-ask-cap',
      'silent-tail': 'mock:silent-tail',
      'silent-tail-no-reply': 'mock:silent-tail-no-reply',
      baseline: BASELINE_PROMPT,
      'no-progress-ack-only': BASELINE_PROMPT,
      'crash-stderr-pre-ack': 'mock:crash-stderr-pre-ack',
      'crash-stderr-held-pipe': 'mock:crash-stderr-held-pipe',
      'shutdown-stderr': 'mock:crash-stderr-clean',
      'crash-stderr': 'mock:crash-stderr',
      'crash-stderr-single': 'mock:crash-stderr-single',
      'cezar-done': 'mock:cezar-done',
      hold: 'mock:hold', 'hold-gated': 'mock:hold-gated', 'no-progress': 'mock:no-progress', 'no-progress-ignore-term': 'mock:no-progress-ignore-term', 'no-progress-held-pipe': 'mock:no-progress-held-pipe', 'no-progress-leftover': 'mock:no-progress-leftover', 'busy-progress': 'mock:busy-progress',
      'provider-error': 'mock:provider-error', 'provider-error-controlled': 'mock:provider-error',
      'provider-unavailable': 'mock:provider-unavailable',
      'provider-rate-limit': 'mock:provider-rate-limit', 'provider-not-found': 'mock:provider-not-found', 'provider-credit': 'mock:provider-credit',
      'post-success-refusal': 'mock:provider-error',
      ask: 'mock:cezar-ask',
      'ask-resume': 'mock:cezar-ask mock:resume-cezar-done',
      'ask-reply-late': 'mock:cezar-ask',
      'steer-tool': 'mock:steer-tool',
      'steer-late': 'mock:steer-late',
      'hold-cezar-done': 'mock:hold-cezar-done',
      'hold-cezar-ask': 'mock:hold-cezar-ask',
      'silent-tail-late-reply': 'mock:silent-tail-late-reply',
      'silent-tail-slow-done': 'mock:silent-tail-slow-done',
      // No `subagent`: see the S9 and R12 entries in PARITY_EXEMPTIONS.
    },
  },
  // OMP is pi's fork on the same RPC wire, so it answers pi's scenario map, plus the two
  // subagent scenarios pi is exempt from: OMP's `task` tool surfaces subagent events natively.
  omp: {
    backend: 'omp',
    askResumeCases: [{ kind: 'cezar_ask', scenario: 'ask-resume', answer: 'Library: Vitest' }],
    binEnv: 'CEZ_OMP_BIN',
    mockBin: OMP_MOCK,
    scenarios: {
      ...SQUAWK_TOOL_SCENARIOS,
      'input-closed-live': 'mock:no-progress-input-closed',
      'closed-input': 'mock:closed-input',
      'auto-resumed': BASELINE_PROMPT,
      'hold-cezar-done': 'mock:hold-cezar-done',
      'hold-cezar-ask': 'mock:hold-cezar-ask',
      'multi-pr-refs': 'mock:multi-pr-refs', 'turn-messages': 'mock:turn-messages',
      'missing-binary': BASELINE_PROMPT,
      autonomous: 'mock:autonomous',
      'autonomous-cap': 'mock:autonomous-cap',
      'autonomous-cezar-ask-cap': 'mock:autonomous-cezar-ask-cap',
      'silent-tail': 'mock:silent-tail',
      'silent-tail-no-reply': 'mock:silent-tail-no-reply',
      'silent-tail-late-reply': 'mock:silent-tail-late-reply',
      'silent-tail-slow-done': 'mock:silent-tail-slow-done',
      baseline: BASELINE_PROMPT,
      'no-progress-ack-only': BASELINE_PROMPT,
      'crash-stderr-pre-ack': 'mock:crash-stderr-pre-ack',
      'crash-stderr-held-pipe': 'mock:crash-stderr-held-pipe',
      'shutdown-stderr': 'mock:crash-stderr-clean',
      'crash-stderr': 'mock:crash-stderr',
      'crash-stderr-single': 'mock:crash-stderr-single',
      'cezar-done': 'mock:cezar-done',
      hold: 'mock:hold', 'hold-gated': 'mock:hold-gated', 'no-progress': 'mock:no-progress', 'no-progress-ignore-term': 'mock:no-progress-ignore-term', 'no-progress-held-pipe': 'mock:no-progress-held-pipe', 'no-progress-leftover': 'mock:no-progress-leftover', 'busy-progress': 'mock:busy-progress',
      'provider-error': 'mock:provider-error', 'provider-error-controlled': 'mock:provider-error',
      'provider-unavailable': 'mock:provider-unavailable',
      'provider-rate-limit': 'mock:provider-rate-limit', 'provider-not-found': 'mock:provider-not-found', 'provider-credit': 'mock:provider-credit',
      'post-success-refusal': 'mock:provider-error',
      ask: 'mock:cezar-ask',
      'ask-resume': 'mock:cezar-ask mock:resume-cezar-done',
      'ask-reply-late': 'mock:cezar-ask',
      'steer-tool': 'mock:steer-tool',
      'steer-late': 'mock:steer-late',
      subagent: 'mock:subagent',
      'subagent-after-park': 'mock:subagent-after-park',
    },
  },
};

/** The prompt text that drives one backend's mock into one shared scenario. */
export function promptFor(backend: RunnerId, scenario: ScenarioName): string {
  const prompt = HARNESS_ADAPTERS[backend].scenarios[scenario];
  if (prompt === undefined) {
    throw new Error(`${backend} declares no prompt for scenario "${scenario}"`);
  }
  return prompt;
}

/**
 * Why a cell is exempt, which decides how the matrix pins it. Both kinds fail
 * the day the backend gains the thing, which is what keeps an exemption from
 * going stale — they just cannot be pinned the same way.
 *
 * - `capability-absent` — the scenario IS constructible on this wire, the
 *   backend simply does not produce the criterion's signal. Pinned by an
 *   INVERTED assertion: the criterion must not hold.
 * - `scenario-unconstructible` — the wire cannot even create the situation, so
 *   there is nothing to invert (an unrelated baseline turn would satisfy some
 *   criteria by accident). Pinned by requiring the adapter to declare NO prompt
 *   for that scenario, so the day a mock answers it the exemption fails and the
 *   row has to go live.
 */
export type ExemptionKind = 'capability-absent' | 'scenario-unconstructible';

export interface ParityExemption {
  /** The criterion's stable id — `S9`, `R3`. */
  readonly criterion: string;
  readonly backend: RunnerId;
  readonly kind: ExemptionKind;
  /** Why this backend's WIRE cannot carry it. Never "not implemented yet". */
  readonly reason: string;
}

/**
 * Cells a backend's upstream protocol genuinely cannot carry.
 *
 * An entry here is not a waiver — see `ExemptionKind` for how each is pinned.
 * "Not implemented yet" is never a reason: that is a failing row, and the fix
 * is the runner, not this table.
 */
export const PARITY_EXEMPTIONS: readonly ParityExemption[] = [
  ...(['codex', 'opencode'] as const).map(backend => ({
    criterion: 'R23', backend, kind: 'capability-absent' as const,
    reason: 'A native ask clears its idle timer, so its parked session never idle-closes (hearsay-tools/cezarion#2701).',
  })),
  ...(['claude', 'pi', 'cursor', 'omp'] as const).map(backend => ({
    criterion: 'P1', backend, kind: 'scenario-unconstructible' as const,
    reason: `${backend}'s native wire does not carry a native permission request that Squawk answers through the cockpit permission card. This cell checks that native request/response protocol; ordinary human questions remain covered by R26.`,
  })),
  ...([
    ['claude', 'Claude print mode settles every tool permission inside Claude under its headless --permission-mode and sends Squawk no MCP tool approval request; Squawk\'s own tools are pre-authorized through generated --allowedTools entries (R35).'],
    ['opencode', 'OpenCode sends no MCP-specific approval request: an ask before any tool call arrives as an ordinary permission.asked from a rule the user wrote, which P1 routes to the cockpit card (hearsay-tools/cezarion#1266).'],
    ['pi', 'Pi\'s RPC wire carries no tool approval request for Squawk to answer; Squawk\'s tools reach Pi as an --extension admitted through --tools (R35), not as an MCP server.'],
    ['cursor', 'Cursor print runs with --force and its stream-json wire carries no MCP tool approval request; Squawk\'s own tools load from a private --plugin-dir.'],
    ['omp', 'OMP\'s RPC wire carries no tool approval request for Squawk to answer: tool admission is its --tools list and --config overlay; Squawk\'s tools reach OMP as an --extension admitted through --tools (R35), not as an MCP server.'],
  ] as const).map(([backend, reason]) => ({ criterion: 'P9', backend, kind: 'scenario-unconstructible' as const, reason })),
  {
    criterion: 'P2', backend: 'claude', kind: 'scenario-unconstructible',
    reason: "dontAsk (the default) denies unapproved tools without emitting a permission request, so no built-in default ask reaches Squawk to answer.",
  },
  {
    criterion: 'P2', backend: 'codex', kind: 'scenario-unconstructible',
    reason: "every app-server approval request comes from Codex's own approval policy or MCP tool approval mode, which Squawk leaves to Codex and P1 and P9 route to the human; the wire has no built-in ask that Squawk answers.",
  },
  ...(['pi', 'cursor', 'omp'] as const).map(backend => ({
    criterion: 'P2', backend, kind: 'scenario-unconstructible' as const,
    reason: `${backend}'s native wire carries no permission request at all, so there is no built-in default ask for Squawk to answer.`,
  })),
  ...(['claude', 'pi', 'cursor', 'omp'] as const).flatMap(backend => { return ([
    ['P3', 'for the backend to settle itself'],
    ['P4', 'to outlive its turn'],
    ['P5', 'whose answer the backend could refuse'],
    ['P6', 'to arrive malformed'],
    ['P7', 'to hold input while Squawk classifies it'],
    ['P8', 'to arrive after its turn ended'],
  ] as const).map(([criterion, situation]) => ({
    criterion, backend, kind: 'scenario-unconstructible' as const,
    reason: `${backend}'s native wire does not carry a native permission request that Squawk answers through the cockpit permission card, so there is no pending request ${situation}.`,
  })); }),
  {
    criterion: 'P5', backend: 'codex', kind: 'scenario-unconstructible',
    reason: 'Codex answers an approval with a JSON-RPC response written to app-server stdin. JSON-RPC sends no reply to a response, so the wire has no per-answer refusal: the write reaches the server, or the transport fails and the session ends.',
  },
  {
    criterion: 'P7', backend: 'codex', kind: 'scenario-unconstructible',
    reason: "A Codex approval request is already Codex's own decision to ask (its approval policy runs server-side), so Squawk shows the card on receipt with nothing to read first; there is no window between receipt and the card.",
  },
  {
    criterion: 'P8', backend: 'codex', kind: 'scenario-unconstructible',
    reason: 'Codex app-server sends an approval request only inside the turn it names (`turnId`), so none can arrive after that turn completed.',
  },
  {
    criterion: 'S29', backend: 'cursor', kind: 'scenario-unconstructible',
    reason: 'Cursor print writes the prompt to stdin once per turn and then closes stdin. It refuses agent input while busy and queues human follow-ups for a new per-turn child, so this admitted-turn/live-followup cell has no writable input transport to close.',
  },
  ...(['S9', 'R12', 'R15'] as const).map(criterion => ({
    criterion, backend: 'cursor' as const, kind: 'scenario-unconstructible' as const,
    reason: 'Cursor 2026.10.01-e373342 print stream-json reports parent tool calls but no child-session transcript or child terminal frames; native delegation is suppressed for governed runs.',
  })),
  ...(['claude', 'codex', 'pi', 'cursor', 'omp'] as const).map(backend => ({
    criterion: 'S25', backend, kind: 'scenario-unconstructible' as const,
    reason: 'This runner speaks its native wire over the spawned process\'s stdio, so there is no listen phase between spawn and session: a start that exits before listening cannot be constructed, and an early exit is the crash path (S15–S18). hearsay-tools/cezarion#872 retries only `opencode serve`; other runners\' process starts are out of scope.',
  })),
  ...(['claude', 'codex', 'opencode', 'pi', 'cursor'] as const).map(backend => ({
    criterion: 'S21', backend, kind: 'scenario-unconstructible' as const,
    reason: 'This native wire has no OMP get_state.messageCount response for an implicit autoResume. Fresh/start and explicit resume remain covered by S1/S3/S14 and spec-support rows.',
  })),
  ...(['R44', 'R45'] as const).flatMap(criterion => { return (['claude', 'codex', 'pi', 'cursor', 'omp'] as const).map(backend => ({
    criterion, backend, kind: 'scenario-unconstructible' as const,
    reason: 'The OpenCode server-wide unscoped session.error UnknownError skill diagnostics (an unreadable skill file, or a skill with malformed YAML frontmatter) have no equivalent on this native wire. R2/R46 retain native provider failure coverage.',
  })); }),
  ...(['H2'] as const).flatMap(criterion => { return (['claude', 'codex', 'pi', 'omp'] as const).map(backend => ({
    criterion, backend, kind: 'capability-absent' as const,
    reason: 'This wire writes or steers a mid-turn human follow-up immediately; discardQueuedMessages cannot unwrite it. OpenCode and Cursor queue and drop (H2 live rows).',
  })); }),
  ...(['claude', 'codex', 'pi', 'cursor', 'omp'] as const).map(backend => ({
    criterion: 'F7', backend, kind: 'scenario-unconstructible' as const,
    reason: 'This wire has no separate HTTP ACK retained after turn completion. Turn frames and the transport ACK share one stream, so a silent-tail turn cannot end while its agent-input ACK is still pending.',
  })),
  ...(['F8', 'F9'] as const).map(criterion => ({
    criterion, backend: 'cursor' as const, kind: 'scenario-unconstructible' as const,
    reason: 'Cursor print has no independent nudge ACK before native model work. It cannot acknowledge a silent nudge and then withhold or delay that turn; the native turn and no-progress cells exercise the available liveness bound.',
  })),
  {
    criterion: 'N8', backend: 'cursor', kind: 'scenario-unconstructible',
    reason: 'Every Cursor print process emits a native init frame mapped to turn.started before model-work admission. The native no-progress rows exercise the timeout after that start; no turn-start-free acknowledged input can be constructed.',
  },
  // #961 wire survey 2026-10-15: no hook lifecycle frame on these wires.
  ...([
    ['opencode', 'OpenCode 1.18.35 runs plugin hooks in-process and streams no hook lifecycle event over its SSE wire.'],
    ['pi', 'Pi 1.0.4 runs extensions in-process; its RPC wire reports only extension_error, never a hook run.'],
    ['omp', 'OMP 18.8.0 shares Pi\'s RPC wire: extensions run in-process and report only extension_error.'],
    ['cursor', 'Cursor 2026.10.01-e373342 print stream-json carries no hook lifecycle frame.'],
  ] as const).map(([backend, reason]) => ({
    criterion: 'R77', backend, kind: 'scenario-unconstructible' as const, reason,
  })),
  ...(['claude', 'opencode', 'pi', 'cursor', 'omp'] as const).map(backend => ({
    criterion: 'F11', backend, kind: 'scenario-unconstructible' as const,
    reason: 'This wire has no native turn-start frame that reaches v2 after the nudge is sent; turn.started is synthetic inside sendAgentMessage and fires at nudge send, before the bound.',
  })),
  // A9: a native mid-turn ask.requested exists only where the declared native ask is answerable.
  ...exemptWhere('A9', 'capability-absent', facts => facts.nativeAsk !== 'answerable', backend => reasonFor('A9', backend, {
    claude: 'Claude stream-json asks through cezar_ask; its wire emits no native mid-turn ask.requested (A3/A4 cover the cezar_ask policy).',
    cursor: 'Cursor print auto-skips native AskQuestion before a human can answer. The executable native-question rejection and the A3/A4 cezar_ask cells cover the available paths.',
    pi: 'Pi RPC asks through cezar_ask; its wire emits no native mid-turn ask.requested (A3/A4 cover the cezar_ask policy).',
    omp: 'OMP v18.4.11 plain `--mode rpc` never constructs the ask tool: sessionOptions.hasUI is true only for interactive or rpc-ui (src/main.ts) and AskTool.createIf returns null without it, so the native ask path cannot exist on the wire Squawk uses. Asks go through cezar_ask (A3/A4 cover the cezar_ask policy).',
  })),
  {
    criterion: 'R15', backend: 'pi', kind: 'scenario-unconstructible',
    reason: 'Pi RPC has no child session or nested child transcript (rpc-lifecycle.ndjson); like S9/R12, post-park child items cannot be constructed on that wire.',
  },
  {
    criterion: 'I1', backend: 'cursor', kind: 'scenario-unconstructible',
    reason: 'Cursor print runs one process per turn and writes its prompt to stdin once, so a running turn has no input channel. sendAgentMessage refuses while busy, and inputDelivery is boundary: input waits for the next exact-resume print process (#505).',
  },
  {
    criterion: 'I2', backend: 'cursor', kind: 'scenario-unconstructible',
    reason: 'Same wire as I1: Cursor admits no mid-turn agent input, so none can be left unread (#505).',
  },
  {
    criterion: 'I6', backend: 'cursor', kind: 'scenario-unconstructible',
    reason: 'Same wire as I1: Cursor admits no mid-turn agent input, so none awaits a follow-on run (#505).',
  },
  {
    criterion: 'I3', backend: 'cursor', kind: 'scenario-unconstructible',
    reason: 'Same wire as I1: a running Cursor print turn has no input channel, so a conversation message cannot steer the answer turn. I4 pins its boundary delivery after that turn (hearsay-tools/cezarion#935).',
  },
  {
    criterion: 'I2', backend: 'claude', kind: 'capability-absent',
    reason: 'Claude 2.1.280 runs a stdin line written after the last model call as its own following result (queued_turn_count), so accepted input is never left unread (#505).',
  },
  {
    criterion: 'I2', backend: 'pi', kind: 'capability-absent',
    reason: 'pi 0.87.0 delivers an acknowledged steer in the running turn or runs it as the next prompt (rpc.md steer; #505 repro), so accepted input is never left unread.',
  },
  {
    criterion: 'I2', backend: 'omp', kind: 'capability-absent',
    reason: 'OMP v18.4.11 session_settled requires queuedMessageCount === 0 (isRpcSessionSettled, modes/rpc/rpc-session-settle.ts), and agent_end is rewritten to isTerminal:false while agent.hasQueuedMessages() (session/agent-session.ts), so a steer accepted before settle is read in the same turn and accepted input is never left unread.',
  },
  {
    criterion: 'S4', backend: 'cursor', kind: 'capability-absent',
    reason: 'Cursor print 2026.10.01-e373342 emits no token usage: its terminal result frame carries no usage or total_cost_usd (Cursor output-format reference; cursor-print-ui-mapper.ts header). Do not manufacture counts from text. Revisit when upstream emits telemetry.',
  },
  {
    criterion: 'R12',
    backend: 'pi',
    kind: 'scenario-unconstructible',
    reason:
      "pi's RPC has no child session or child transcript: task tools run on the parent " +
      'session (see `__fixtures__/pi/rpc-lifecycle.expected.json`), so no child message can ' +
      'arrive between the parent cezar_wait call and turn-end.',
  },
  {
    criterion: 'S9',
    backend: 'pi',
    kind: 'scenario-unconstructible',
    reason:
      "pi's RPC has no child session: a `task` tool is a plain tool call on the parent " +
      'session (see `__fixtures__/pi/rpc-lifecycle.expected.json` — the task item carries no ' +
      'parentItemId and no child transcript), so there is no child terminal signal that could ' +
      'end the parent turn.',
  },
  // S11 (hearsay-tools/cezarion#2397): these wires have no answerable native ask; the `ask`
  // scenario calls cezar_ask, whose human wait the workflow holds input behind (R6), not the runner.
  ...exemptWhere('S11', 'capability-absent', facts => facts.nativeAsk !== 'answerable', () =>
    'this wire has no native ask; cezar_ask is the workflow\'s human wait, so the runner admits non-human input and the run tier holds it (R6)'),
  // R4: a malformed question is a native ask's failure. cezar_ask validates its arguments and
  // answers the agent with invalid_request, so no malformed question reaches the run. Cursor's
  // auto-skipped native question still runs the row on its wire.
  ...exemptWhere('R4', 'scenario-unconstructible', facts => facts.nativeAsk === 'none', () =>
    'this wire has no native ask; a malformed cezar_ask is refused to the agent as invalid_request before any card exists'),
  // hearsay-tools/cezarion#1233 U7: cezar_wait stays live on every wire; only a declared native
  // timer tool (Claude's ScheduleWakeup) is an alias.
  ...exemptWhere('U7', 'capability-absent', facts => facts.nativeTimerTool === null, () =>
    'native scheduler tool exists only on the Claude wire'),
  // U7h (hearsay-tools/cezarion#1234): the ask scenario on these wires calls cezar_ask, so its
  // human wait opens through cezar_ask rather than a native ask; the cell asserts that instead.
  ...exemptWhere('U7h', 'capability-absent', facts => facts.nativeAsk !== 'answerable', () =>
    'this wire has no native ask; its ask scenario calls cezar_ask'),
  // U12/U13: an agent-input acknowledgement the provider can delay or reject.
  {
    criterion: 'U12', backend: 'claude', kind: 'capability-absent',
    reason: 'Claude acknowledges agent input with the local stdin pipe write, so the provider cannot delay the acknowledgement. U3b covers its delivery beside a pending question.',
  },
  {
    criterion: 'U13', backend: 'claude', kind: 'capability-absent',
    reason: 'Claude acknowledges agent input with the local stdin pipe write; a written line has no provider rejection.',
  },
  {
    criterion: 'U13', backend: 'cursor', kind: 'capability-absent',
    reason: 'Cursor print rejects an input receipt when its process does not exit 0 after a result, a failed turn; the print wire carries no provider rejection of an admitted prompt.',
  },
  // U27 (hearsay-tools/cezarion#1525): the late-acknowledgement entry needs a turn that ends before
  // its input is acknowledged. The fresh-step and Continue cells run on every wire.
  {
    criterion: 'U27', backend: 'claude', kind: 'capability-absent',
    reason: 'Claude acknowledges agent input with the local stdin pipe write, so no turn can end before its input is acknowledged; its fresh-step and Continue cells still run.',
  },
  {
    criterion: 'U27', backend: 'cursor', kind: 'capability-absent',
    reason: 'Cursor print acknowledges agent input on the first model work of the process it spawns, so no turn can end before its input is acknowledged; its fresh-step and Continue cells still run.',
  },
  // U20h/U22s (hearsay-tools/cezarion#1301): a refusal the harness acknowledges and never answers.
  ...(['U20h', 'U22s'] as const).map(criterion => ({
    criterion, backend: 'cursor' as const, kind: 'capability-absent' as const,
    reason: 'Cursor print has no acknowledgement before native model work: each prompt spawns a process whose init frame is turn.started, which answers the nudge, so a refusal cannot be acknowledged and left unanswered (as F8).',
  })),
  {
    criterion: 'U20h', backend: 'opencode', kind: 'capability-absent',
    reason: 'OpenCode runs one prompt per turn: a human prompt waits for the busy turn to go idle, and a refusal acknowledged without a turn never goes idle, so the human message the cell sends after the bound is never posted.',
  },
  // S40/S41 (hearsay-tools/cezarion#2991): Cursor print reads a prompt only when its process starts,
  // so its mock has no mid-turn read point to time a message against. runner-facts.test.ts ties
  // these ids to the declared boundary delivery.
  ...(['S40', 'S41'] as const).map(criterion => ({
    criterion, backend: 'cursor' as const, kind: 'scenario-unconstructible' as const,
    reason: 'Cursor print has no input channel into a running print process: every mid-turn message waits for the next process (boundary delivery, always-held), which S38 and S39 hold on its wire.',
  })),
  // D1 (hearsay-tools/cezarion#2279): a governed session keeps native subagents, and Squawk adds a
  // control only where a runner's cross-session tool is separate from subagent messaging. Each
  // reason was checked against the installed CLI on 2026-10-30.
  ...([
    ['claude', 'Claude Code 2.1.312 SendMessage and ListAgents also reach the session\'s own subagents, so no outbound tool is separate from subagent messaging; inbound messages from other sessions are refused on every launch (D3).'],
    ['pi', 'pi 1.4.0 has no built-in cross-session tool; an extension may add one, and its name cannot be discovered as messaging.'],
    ['cursor', 'Cursor 2026.10.22-27dcf5f send_message (to cloud agents) has no CLI handler, and its native agent tools reach the session\'s own subagents.'],
    ['omp', 'OMP 18.13.1 has no cross-session tool in its default set; its irc tool is an in-process bus that reaches only agents inside the same OMP process.'],
  ] as const).map(([backend, reason]) => ({
    criterion: 'D1', backend, kind: 'capability-absent' as const, reason,
  })),
  // D3 (hearsay-tools/cezarion#1994): no native cross-session messaging control at shipped
  // defaults. Each reason was checked against the installed CLI on 2026-10-27.
  ...([
    ['codex', 'Codex 0.164.0 multi-agent tools reach only agents of the same session; the cross-thread agent_message_board feature is under development and off by default, so Squawk sends no flag for an unstable key.'],
    ['opencode', 'OpenCode 1.19.4 has no messaging tool and no inbound channel. Its task tool resumes any session by task_id with no parent check, and the task permission pattern matches only subagent_type, so no session rule blocks a foreign task_id while subagents keep working. Only the shell finds another session\'s ID, and the shell reaches that session directly (opencode run --session); the same-user shell is outside hard isolation.'],
    ['pi', 'pi 1.4.0 has no built-in messaging tool; an extension may add one, and its name cannot be discovered as messaging.'],
    ['cursor', 'Cursor 2026.10.22-27dcf5f defines send_message (to cloud agents) in its protocol, but the CLI never sets sendMessageEnabled and has no handler for it.'],
    ['omp', 'OMP 18.13.1 get_state.dumpTools default set holds no messaging tool; vibe_* and irc are opt-in in the user\'s own config.'],
  ] as const).map(([backend, reason]) => ({
    criterion: 'D3', backend, kind: 'capability-absent' as const, reason,
  })),
];

/**
 * One exemption for each runner whose declared facts match (hearsay-tools/cezarion#2991), so a row
 * and the shared code that reads the same fact cannot disagree on which runners it covers.
 */
function exemptWhere(criterion: string, kind: ExemptionKind, matches: (facts: RunnerFacts) => boolean,
  reason: (backend: RunnerId) => string): ParityExemption[] {
  return runnersWhere(matches).map(backend => ({ criterion, backend, kind, reason: reason(backend) }));
}

/** A runner-specific reason; a runner the facts select without one fails the table at load. */
function reasonFor(criterion: string, backend: RunnerId, reasons: Partial<Record<RunnerId, string>>): string {
  const reason = reasons[backend];
  if (reason === undefined) throw new Error(`${criterion} exempts ${backend} by its declared facts, but gives no reason`);
  return reason;
}

export function exemptionFor(criterion: string, backend: RunnerId): ParityExemption | undefined {
  return PARITY_EXEMPTIONS.find((e) => e.criterion === criterion && e.backend === backend);
}

/** Poll a condition. Generous on purpose: under a full suite run these share the
 *  machine with hundreds of files, and a tight bound is a flake, not a check. */
export async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    const elapsed = Date.now() - start;
    if (elapsed > ms) throw new Error(`waitFor timed out after ${elapsed}ms: ${cond.toString()}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** `Array.prototype.findLastIndex` is ES2023; this package's lib is ES2022. */
export function lastIndexWhere<T>(items: readonly T[], match: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (match(items[i] as T)) return i;
  }
  return -1;
}

/** Every v1 `text` event of a run, folded the way the orchestrator folds a turn. */
export function textEvents(v1: readonly AgentEvent[]): string[] {
  return v1
    .filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.text);
}

export interface SeamObservation {
  readonly backend: RunnerId;
  readonly elapsedMs: number;
  readonly failure?: Error;
  readonly v1: readonly AgentEvent[];
  readonly v2: readonly UiEvent[];
  readonly result: AgentRunResult;
  /** The spawned backend process pid, as the seam reported it while open. */
  readonly pid: number | undefined;
}

export interface DriveSeamOptions {
  readonly spec?: Partial<AgentRunSpec>;
  readonly sessionOptions?: SessionOptions;
  /** Extra work while the session is live — a follow-up message, an interrupt.
   *  When absent, `driveSeam` waits for the first turn-end or error. */
  readonly whileOpen?: (
    session: AgentSession,
    observed: { v1: readonly AgentEvent[]; v2: readonly UiEvent[] },
  ) => Promise<void>;
  readonly timeoutMs?: number;
  /** Called with each event right after it is recorded, so a row can read session state at the
   *  event's position in the merged stream (hearsay-tools/cezarion#2991). */
  readonly onEvent?: (event: { readonly v1: AgentEvent } | { readonly v2: UiEvent }) => void;
}

/**
 * Drive one backend's real runner class against its own offline mock and collect
 * both event streams plus the settled result.
 *
 * The bin env var is set and restored around the call the same way
 * `pi-runner.test.ts` and `workflows/run.test.ts` already do it, and
 * `CEZ_DRY_RUN` is cleared so the mock named by the adapter is the only
 * transport in play.
 */
export async function driveSeam(
  backend: RunnerId,
  scenario: ScenarioName,
  opts: DriveSeamOptions = {},
): Promise<SeamObservation> {
  const started = Date.now();
  const adapter = HARNESS_ADAPTERS[backend];
  const savedBin = process.env[adapter.binEnv];
  const savedDry = process.env.CEZ_DRY_RUN;
  process.env[adapter.binEnv] = adapter.mockBin;
  delete process.env.CEZ_DRY_RUN;
  const cwd = mkdtempSync(join(tmpdir(), `cez-parity-${backend}-`));
  // A failed spawn has no native wire. Exercise the real OS boundary through
  // the adapter's binary setting, leaving runtime scenarios on their own mocks.
  if (scenario === 'missing-binary') process.env[adapter.binEnv] = join(cwd, 'missing-executable');
  const v1: AgentEvent[] = [];
  const v2: UiEvent[] = [];
  let session: AgentSession | undefined;
  let pid: number | undefined;
  try {
    session = runnersUnderTest()(backend, backend === 'cursor' ? { sessionTransport: 'cursor-print' } : {}).startSession(
      {
        userPrompt: promptFor(backend, scenario),
        cwd,
        toolGrant: UNSET_TOOL_GRANT,
        timeoutMs: opts.timeoutMs ?? 30_000,
        // RunManager always pins one (`workflows/run.ts:2909`), and claude
        // resumes off exactly this value, so a row that omitted it would test
        // a shape no real run ever uses.
        sessionId: PINNED_SESSION_ID,
        // The claude mock writes to these when set; empty keeps a row from
        // touching a handoff file it does not own.
        env: { CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '', CEZ_MOCK_ARGS_FILE: '',
          ...(scenario === 'closed-input' && backend === 'omp' ? { CEZ_MOCK_OMP_CLOSED_INPUT: '1' } : {}),
          ...(scenario === 'auto-resumed' ? { CEZ_MOCK_OMP_AUTO_RESUME: '1' } : {}),
          ...(scenario === 'serve-start-exit' ? {
            CEZ_MOCK_OPENCODE_SERVE_FAIL_STARTS: '1', CEZ_MOCK_OPENCODE_SERVE_FAIL_FILE: join(cwd, 'serve-starts'),
          } : {}),
        },
        ...opts.spec,
      },
      (event) => { v1.push(event); opts.onEvent?.({ v1: event }); },
      { ...opts.sessionOptions, onUiEvent: (event) => { v2.push(event); opts.onEvent?.({ v2: event }); },
        onPidChange: (nextPid) => { pid = nextPid; opts.sessionOptions?.onPidChange?.(nextPid); } },
    );
    let failure: Error | undefined;
    const settled = session.result.catch((error: unknown): AgentRunResult => {
      failure = error instanceof Error ? error : new Error(String(error));
      return { text: '', toolCalls: [], tokensUsed: 0 };
    });
    pid ??= session.pid;
    if (scenario === 'missing-binary') await settled;
    else if (opts.whileOpen) await opts.whileOpen(session, { v1, v2 });
    else await waitFor(() => v1.some((e) => e.type === 'turn-end' || e.type === 'error'));
    session.end();
    const result = await settled;
    return { backend, v1, v2, result, pid, elapsedMs: Date.now() - started, ...(failure ? { failure } : {}) };
  } finally {
    session?.interrupt();
    if (savedBin === undefined) delete process.env[adapter.binEnv];
    else process.env[adapter.binEnv] = savedBin;
    if (savedDry !== undefined) process.env.CEZ_DRY_RUN = savedDry;
    rmSync(cwd, { force: true, recursive: true });
  }
}
