import type { ScenarioName } from './harness-parity-core.testkit.ts';

/**
 * The rows the harness parity cells declare, as plain data: the cell kits
 * (`harness-parity-seam-tier.testkit.ts`, `harness-parity-run-tier.testkit.ts` and the
 * `harness-parity-<part>.cells.testkit.ts` modules) import Vitest and runners, and some the workflow
 * engine and the server, so nothing outside Vitest can load them. They attach each row's
 * assertion by id. `scripts/parity-rows.ts` prints these rows.
 */
export interface ParityRow {
  /** Stable id the exemption table references. */
  readonly id: string;
  readonly scenario: ScenarioName;
  /** Absent where the row's cells carry the name in their own titles. */
  readonly name?: string;
}

/** The seam tier: each runner class against its own offline mock. */
export const SEAM_ROWS = [
  { id: 'S21', scenario: 'auto-resumed', name: 'S21 warns about unexpected startup history without failing the turn' },
  { id: 'S25', scenario: 'serve-start-exit', name: 'S25 retries a backend server that exits before listening once and completes the turn' },
  { id: 'S20', scenario: 'missing-binary', name: 'S20 reports missing executables through its existing failure channel without starting a turn' },
  { id: 'S18', scenario: 'crash-stderr-pre-ack', name: 'S18 reports one actionable crash before terminal boundaries when the opening prompt is unacknowledged' },
  { id: 'S19', scenario: 'crash-stderr-held-pipe', name: 'S19 drains late crash stderr without waiting indefinitely for inherited pipes' },
  { id: 'S17', scenario: 'shutdown-stderr', name: 'S17 keeps clean exits and requested signal teardown successful despite stderr' },
  { id: 'S15', scenario: 'crash-stderr', name: 'S15 preserves actionable crash stderr and full available diagnostics after malformed native output' },
  { id: 'S16', scenario: 'crash-stderr-single', name: 'S16 preserves single-line stderr and nonzero exit codes' },
  { id: 'S1', scenario: 'baseline', name: 'S1 terminates with exactly one v1 done, and it is the last event' },
  { id: 'S2', scenario: 'hold', name: 'S2 ends the turn on its own terminal signal, after the last content event' },
  { id: 'S7', scenario: 'provider-error', name: 'S7 surfaces a provider failure as an error on both streams' },
  { id: 'S9', scenario: 'subagent', name: 'S9 keeps the parent turn open past a child session terminal signal' },
  { id: 'S3', scenario: 'baseline', name: 'S3 yields a resumable session id at the seam' },
  { id: 'S4', scenario: 'baseline', name: 'S4 reports token usage on both streams' },
  { id: 'S10', scenario: 'baseline', name: 'S10 exposes the spawned process pid' },
] as const satisfies readonly ParityRow[];

/** The run tier: a real `RunManager` over the native wire, read once the run settles. */
export const RUN_ROWS = [
  { id: 'R17', scenario: 'provider-unavailable', name: 'R17 holds the run on an unavailable provider and preserves its failure reason' },
  { id: 'R1', scenario: 'cezar-done', name: 'R1 takes a declared-complete run to its review gate' },
  { id: 'R2', scenario: 'provider-error', name: 'R2 fails the run on a provider request rejection instead of parking it as Needs You' },
  { id: 'R3', scenario: 'ask', name: 'R3 parks as waiting and emits exactly one ask card' },
  { id: 'R4', scenario: 'ask-bad', name: 'R4 renders no card for a malformed ask and still ends the turn' },
  { id: 'R5', scenario: 'cezar-wait', name: 'R5 parks a declared monitoring turn on an open monitoring timer, not as a plain wait' },
  { id: 'R12', scenario: 'subagent', name: 'R12 keeps monitoring parked when child text follows the parent cezar_wait' },
  // hearsay-tools/squawk#3337: a provider error on a step holds the run and retries it with back-off.
  { id: 'R126', scenario: 'provider-rate-limit', name: 'R126 holds the run on a provider rate limit and retries it with back-off' },
  { id: 'R127', scenario: 'provider-not-found', name: 'R127 holds the run on a model endpoint 404 and retries it with back-off' },
  { id: 'R128', scenario: 'provider-credit', name: 'R128 holds the run on a spent credit balance and retries it with back-off' },
] as const satisfies readonly ParityRow[];

/** The run-tier rows the provider part runs: the provider holds a run instead of failing it. */
export const PROVIDER_HOLD_ROW_IDS: readonly string[] = ['R17', 'R126', 'R127', 'R128'];

/** Agent input that reaches a running turn. */
export const INPUT_ROWS = [
  { id: 'I1', scenario: 'steer-tool', name: 'I1 admits agent input mid-turn and reports it read before that turn ends' },
  { id: 'I2', scenario: 'steer-late', name: 'I2 reports accepted input the finished turn never read' },
] as const satisfies readonly ParityRow[];

/** Input posted right after a turn that took a steer. */
export const FOLLOW_ON_ROWS = [
  { id: 'I6', scenario: 'steer-tool', name: 'I6 answers input posted right after a turn that took a steer in a turn of its own' },
] as const satisfies readonly ParityRow[];

/** Criteria driven through `whileOpen` rather than one settled observation. */
export const CONTROL_CRITERIA = [
  // hearsay-tools/cezarion#1380: workflows/resume-diagnostics.testkit.ts.
  { id: 'R85', scenario: 'provider-error' },
  { id: 'R86', scenario: 'cezar-done' },
  { id: 'R87', scenario: 'cezar-done' },
  { id: 'R88', scenario: 'provider-error' },
  { id: 'R89', scenario: 'provider-error' },
  { id: 'R90', scenario: 'cezar-done' },
  { id: 'R91', scenario: 'cezar-done' },
  // hearsay-tools/cezarion#2279: a governed session keeps native subagents; only a separate
  // cross-session tool gets a control.
  { id: 'D1', scenario: 'baseline' },
  // hearsay-tools/cezarion#1994: a session at shipped defaults refuses native cross-session messages.
  { id: 'D3', scenario: 'baseline' },
  { id: 'S5', scenario: 'baseline' },
  { id: 'S6', scenario: 'baseline' },
  { id: 'S35', scenario: 'baseline' },
  { id: 'S11', scenario: 'ask' },
  { id: 'S12', scenario: 'hold' },
  { id: 'S13', scenario: 'hold' },
  { id: 'S14', scenario: 'baseline' },
  { id: 'R44', scenario: 'skill-warning' },
  { id: 'R45', scenario: 'skill-warning' },
  { id: 'R46', scenario: 'provider-error' },
  { id: 'R6', scenario: 'ask' },
  { id: 'R7', scenario: 'ask' },
  { id: 'R8', scenario: 'hold' },
  { id: 'R9', scenario: 'ask-reply-late' },
  { id: 'R10', scenario: 'cezar-done' },
  { id: 'R11', scenario: 'baseline' },
  { id: 'R15', scenario: 'subagent-after-park' },
  // #961: hook items never move run state, mid-turn or after the park.
  { id: 'R77', scenario: 'hook-after-park' },
  { id: 'R20', scenario: 'baseline' },
  { id: 'R22', scenario: 'baseline' },
  { id: 'R23', scenario: 'ask' },
  // harness-autosave.test.ts drives both cleanup paths with native runner wires.
  { id: 'R24', scenario: 'baseline' },
  { id: 'R25', scenario: 'baseline' },
  // hearsay-tools/cezarion#934: harness-autosave-settlement*.test.ts, independent writer guard.
  { id: 'R61', scenario: 'provider-error' },
  { id: 'R62', scenario: 'provider-error' },
  { id: 'R63', scenario: 'baseline' },
  { id: 'R64', scenario: 'cezar-ask' },
  { id: 'R65', scenario: 'baseline' },
  { id: 'R66', scenario: 'baseline' },
  // hearsay-tools/cezarion#958: final autosave beside unrelated worktree process churn.
  { id: 'R67', scenario: 'baseline' },
  { id: 'R68', scenario: 'baseline' },
  // hearsay-tools/cezarion#1004: harness-autosave-branch.test.ts, run-finalize and turn-end
  // saves leave work on an agent-checked-out branch uncommitted and report it in the handoff;
  // R79 also reports a periodic commit that leaves the closing turn-end flush clean.
  { id: 'R78', scenario: 'baseline' },
  { id: 'R79', scenario: 'baseline' },
  // hearsay-tools/cezarion#994: workflows/ci-wait-failure-parity.testkit.ts,
  // failed fresh/continued CI attempts retain history through scheduler recovery.
  { id: 'R72', scenario: 'provider-error-controlled' },
  { id: 'R73', scenario: 'provider-error-controlled' },
  // Nonfinal CI recovery retains failure history and runs the tail/check retries, including restart.
  { id: 'R74', scenario: 'provider-error-controlled' },
  { id: 'R75', scenario: 'provider-error-controlled' },
  { id: 'R76', scenario: 'provider-error-controlled' },
  { id: 'R26', scenario: 'ask-resume' },
  // workflows/ci-wait-refusal.test.ts: settled worker wake, private CI IPC, then delivery.
  { id: 'R27', scenario: 'hold' },
  // hearsay-tools/cezarion#1225: cancel/destroy releases the same-turn wait slot.
  { id: 'R80', scenario: 'hold' },
  // workflows/ci-wait-conflict-{fresh,continued,recovered}-parity.test.ts: real gh metadata, atomic input, native wake.
  { id: 'R81', scenario: 'baseline' },
  { id: 'R82', scenario: 'baseline' },
  { id: 'R83', scenario: 'baseline' },
  // hearsay-tools/cezarion#1399: workflows/ci-wait-rerun-{fresh,recovered}-parity.test.ts keeps
  // partial green pending during a rerun, including recovery without a session.
  { id: 'R85', scenario: 'baseline' },
  // hearsay-tools/cezarion#1440: query retry through native wake, fresh and recovered.
  { id: 'R92', scenario: 'baseline' },
  // hearsay-tools/cezarion#1425: workflows/pr-merge-wait-parity.test.ts keeps green checks
  // open and delivers one committed merge observation, fresh, continued and recovered.
  { id: 'R97', scenario: 'baseline' },
  { id: 'R98', scenario: 'baseline' },
  { id: 'R99', scenario: 'baseline' },
  { id: 'R28', scenario: 'baseline' },
  { id: 'R29', scenario: 'baseline' },
  { id: 'R30', scenario: 'baseline' },
  { id: 'R31', scenario: 'baseline' },
  { id: 'R32', scenario: 'baseline' },
  { id: 'R33', scenario: 'baseline' },
  { id: 'R34', scenario: 'baseline' },
  // R35 covers both preview serve (#781) and stop/restart (#803) discovery on every native wire.
  { id: 'R35', scenario: 'baseline' },
  // hearsay-tools/cezarion#784: the session's preview CDP address reaches each native process.
  { id: 'R125', scenario: 'baseline' },
  // core/ci-tools-wait-cancel.test.ts (hearsay-tools/cezarion#1233): `cezar_wait` and `cezar_cancel_wait`
  // reach the session's handlers through each native wire, fresh and resumed.
  { id: 'U0', scenario: 'baseline' },
  // #399: shared monitoring instructions on each native prompt channel.
  { id: 'R36', scenario: 'baseline' },
  { id: 'R37', scenario: 'baseline' },
  { id: 'R38', scenario: 'cezar-wait' },
  { id: 'R39', scenario: 'cezar-wait' },
  { id: 'R40', scenario: 'baseline' },
  { id: 'R41', scenario: 'cezar-done' },
  { id: 'R42', scenario: 'baseline' },
  // workflows/worker-reboot-{collect,destroy,reuse}-parity.test.ts and worker-location-evidence.test.ts: native exit/Continue,
  // independent reboot proof, legacy location uncertainty, readable vs unreadable holders, cleanup retries
  // and parent Finish.
  { id: 'R43', scenario: 'baseline' },
  // workflows/worker-restart-same-boot-crash-lock-parity.test.ts: same-boot exit proof, mixed-holder polling and bounded cleanup locks.
  { id: 'R47', scenario: 'baseline' },
  // worker-restart-starting-proof-parity.test.ts: cold terminal starting-proof facts readiness.
  { id: 'R60', scenario: 'baseline' },
  // #779: Continue on a run only runs.db holds, through both ActiveRun construction sites.
  { id: 'R48', scenario: 'cezar-done' },
  // #779: restart still repairs a cancelled root's stale Finish intent, so Continue is not refused.
  { id: 'R49', scenario: 'cezar-done' },
  // #779 plan step 3: a headless open beside the owner leaves its parked run alone.
  { id: 'R50', scenario: 'ask' },
  // #779 plan step 3: adopting a dead owner's mid-turn run for a control resumes nothing; Continue does.
  { id: 'R51', scenario: 'hold' },
  // #779: Stop on a dead owner's mid-turn run ends it cancelled, not interrupted, and starts nothing.
  { id: 'R52', scenario: 'hold' },
  { id: 'PR1', scenario: 'multi-pr-refs' },
  { id: 'PR2', scenario: 'multi-pr-refs' },
] as const satisfies readonly ParityRow[];
