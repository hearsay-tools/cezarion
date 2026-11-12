import { RUNNER_IDS, type InputDelivery, type RunnerId, type SystemPromptOnResume } from './agent-runner.ts';

/**
 * What one runner's wire can do, declared once per runner id (hearsay-tools/cezarion#2991).
 * Shared code often holds only a `RunnerId`, because it builds the runner later, so it reads
 * this table instead of comparing runner ids. Each runner class exposes its own row as
 * `facts`, and reads its `inputDelivery` and `systemPromptOnResume` from it.
 * `runner-facts.test.ts` checks that every runner `createRunner` builds carries the row for its
 * id. A test that must not load the runner classes reads the same row here.
 */
export interface RunnerFacts {
  /** How the runner admits input while a turn runs (`InputDelivery`, hearsay-tools/cezarion#505). */
  readonly inputDelivery: InputDelivery;
  /** How the runner carries `spec.systemPrompt` onto a resumed session (hearsay-tools/cezarion#790). */
  readonly systemPromptOnResume: SystemPromptOnResume;
  /**
   * The harness's own question tool. `answerable`: the wire reports the question and Squawk routes
   * the human answer back to it. `auto-skipped`: the harness has the tool but answers it itself
   * before a human can (Cursor print skips it in headless mode). `none`: the wire has no native
   * question; the agent asks through `cezar_ask`.
   */
  readonly nativeAsk: 'answerable' | 'auto-skipped' | 'none';
  /**
   * Backgrounded native subagents. `reported`: the wire reports a child's start and end, so Squawk
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
  /**
   * Who names the session. `launch`: the runner opens its session under the id Squawk saves on the
   * step before launch, so that id resumes at once. `native`: the runner mints its own id and
   * reports it in a `session` event; until then the step holds only Squawk's launch id, which the
   * runner never knew. The `sessionId` row of each runner's `specSupport` names the wire.
   */
  readonly sessionIdSource: 'launch' | 'native';
}

export const RUNNER_FACTS = {
  claude: {
    inputDelivery: {
      mode: 'steer', consumption: 'observable', acknowledgement: 'write', humanInputAtTurnEnd: 'held-when-late',
      via: 'stream-json stdin line with uuid; --replay-user-messages echo at consumption',
    },
    systemPromptOnResume: 'resent',
    nativeAsk: 'none', nativeSubagents: 'reported', nativeTimerTool: 'ScheduleWakeup', costReport: 'cumulative', sessionIdSource: 'launch',
  },
  codex: {
    inputDelivery: {
      mode: 'steer', consumption: 'observable', acknowledgement: 'response', humanInputAtTurnEnd: 'held-when-late',
      // The userMessage item marks the input entering the thread's history (probe 2026-09-24:
      // 0.8 s and 26.7 s after the steer, both before the tool ended); the next model call reads it.
      via: 'turn/steer with clientUserMessageId; item/started userMessage clientId once in the thread history',
    },
    systemPromptOnResume: 'in-thread',
    nativeAsk: 'answerable', nativeSubagents: 'reported', nativeTimerTool: null, costReport: 'per-turn', sessionIdSource: 'native',
  },
  opencode: {
    inputDelivery: {
      mode: 'steer', consumption: 'observable', acknowledgement: 'response', humanInputAtTurnEnd: 'always-held',
      via: 'prompt_async while busy; assistant message.updated parentID at consumption',
    },
    systemPromptOnResume: 'in-thread',
    nativeAsk: 'answerable', nativeSubagents: 'turn-held', nativeTimerTool: null, costReport: 'per-turn', sessionIdSource: 'native',
  },
  pi: {
    inputDelivery: {
      mode: 'steer', consumption: 'observable', acknowledgement: 'response', humanInputAtTurnEnd: 'held-when-late',
      via: 'prompt with streamingBehavior steer; set_steering_mode all at session start; user message_start with the submitted text',
    },
    systemPromptOnResume: 'resent',
    nativeAsk: 'none', nativeSubagents: 'unreported', nativeTimerTool: null, costReport: 'per-turn', sessionIdSource: 'launch',
  },
  // Every Cursor session runs on print (hearsay-tools/cezarion#1267).
  cursor: {
    inputDelivery: {
      mode: 'boundary', consumption: 'unobservable', acknowledgement: 'model-work', humanInputAtTurnEnd: 'always-held',
      via: 'next exact-resume print process',
    },
    systemPromptOnResume: 'in-thread',
    nativeAsk: 'auto-skipped', nativeSubagents: 'unreported', nativeTimerTool: null, costReport: 'per-turn', sessionIdSource: 'native',
  },
  omp: {
    inputDelivery: {
      mode: 'steer', consumption: 'observable', acknowledgement: 'response', humanInputAtTurnEnd: 'never-held',
      via: 'prompt with streamingBehavior steer; set_steering_mode all at session start; user message_start with the submitted text',
    },
    systemPromptOnResume: 'resent',
    nativeAsk: 'none', nativeSubagents: 'turn-held', nativeTimerTool: null, costReport: 'per-turn', sessionIdSource: 'native',
  },
} as const satisfies Readonly<Record<RunnerId, RunnerFacts>>;

/** The runners whose declared facts match, in `RUNNER_IDS` order. */
export function runnersWhere(matches: (facts: RunnerFacts) => boolean): RunnerId[] {
  return RUNNER_IDS.filter(id => matches(RUNNER_FACTS[id]));
}
