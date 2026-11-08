import { RUNNER_IDS, type RunnerId } from './agent-runner.ts';

/**
 * What one runner's wire can do, declared once per runner id (hearsay-tools/cezarion#2991).
 * Shared code often holds only a `RunnerId`, because it builds the runner later, so it reads
 * this table instead of comparing runner ids. Each runner class exposes its own row as
 * `facts`, and `runner-facts.test.ts` checks that every runner `createRunner` builds carries
 * the row for its id. How a runner admits input lives on `InputDelivery`, and how it carries
 * the system prompt onto a resume lives on `systemPromptOnResume`; this table holds the rest.
 */
export interface RunnerFacts {
  /**
   * The harness's own question tool. `answerable`: the wire reports the question and Cezar routes
   * the human answer back to it. `auto-skipped`: the harness has the tool but answers it itself
   * before a human can (Cursor print skips it in headless mode). `none`: the wire has no native
   * question; the agent asks through `cezar_ask`.
   */
  readonly nativeAsk: 'answerable' | 'auto-skipped' | 'none';
  /**
   * Backgrounded native subagents. `reported`: the wire reports a child's start and end, so Cezar
   * waits on the child. `unreported`: the wire sends no child signal. `turn-held`: the parent turn
   * stays open until every child returns, so no turn end parks on running children.
   */
  readonly nativeSubagents: 'reported' | 'unreported' | 'turn-held';
  /** The native tool that schedules the session's own wake-up, the equivalent of a `cezar_wait`
   *  timer; null when the wire has none. A tool of the same name on another wire means nothing. */
  readonly nativeTimerTool: string | null;
  /** `cumulative`: each cost report is the session total so far, Continue steps included.
   *  `per-turn`: each report is new cost since the previous report. */
  readonly costReport: 'cumulative' | 'per-turn';
}

export const RUNNER_FACTS = {
  claude: { nativeAsk: 'none', nativeSubagents: 'reported', nativeTimerTool: 'ScheduleWakeup', costReport: 'cumulative' },
  codex: { nativeAsk: 'answerable', nativeSubagents: 'reported', nativeTimerTool: null, costReport: 'per-turn' },
  opencode: { nativeAsk: 'answerable', nativeSubagents: 'turn-held', nativeTimerTool: null, costReport: 'per-turn' },
  pi: { nativeAsk: 'none', nativeSubagents: 'unreported', nativeTimerTool: null, costReport: 'per-turn' },
  cursor: { nativeAsk: 'auto-skipped', nativeSubagents: 'unreported', nativeTimerTool: null, costReport: 'per-turn' },
  omp: { nativeAsk: 'none', nativeSubagents: 'turn-held', nativeTimerTool: null, costReport: 'per-turn' },
} as const satisfies Readonly<Record<RunnerId, RunnerFacts>>;

/** The runners whose declared facts match, in `RUNNER_IDS` order. */
export function runnersWhere(matches: (facts: RunnerFacts) => boolean): RunnerId[] {
  return RUNNER_IDS.filter(id => matches(RUNNER_FACTS[id]));
}
