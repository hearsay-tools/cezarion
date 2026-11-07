/**
 * The codex UI mapper's fold state: the per-channel reasoning accumulators,
 * the collaboration task record, and the state the mapper threads from frame
 * to frame. `codex-ui-mapper.ts` re-exports `ReasoningAccumulator` and
 * `CodexUiMapperState`.
 */

import type { TokenUsage, UiToolItem } from './ui-events.ts';

/** The two reasoning delta channels, accumulated separately — see
 *  `CodexUiMapperState.reasonings`. */
export interface ReasoningAccumulator {
  /** `item/reasoning/textDelta` — the raw chain of thought. */
  readonly text: string;
  /** `item/reasoning/summaryDelta` + `summaryTextDelta` — the condensed summary. */
  readonly summary: string;
}

export interface CodexCollabTask {
  readonly itemId: string;
  readonly prompt?: string;
  readonly model?: string;
}

export interface CodexUiMapperState {
  /** True once `session.started` was emitted (thread/started notification or
   *  the runner's `codexSessionStarted` after the thread/start result —
   *  whichever lands first wins; the other is deduplicated). */
  readonly sessionStarted: boolean;
  /** Fallback counter for turn frames that arrive without a wire turn id. */
  readonly turnSeq: number;
  readonly currentTurnId: string | null;
  /** Fresh `tokenUsage.last` received while the current turn is active.
   * Consumed exactly once by its matching turn end; cumulative `total` is
   * never used as a persisted per-turn delta. */
  readonly pendingTurnUsage: TokenUsage | null;
  /** Item ids already introduced — a delta for an unknown id synthesizes an
   *  `item.started` first so consumers always have something to upsert. */
  readonly knownItems: ReadonlySet<string>;
  /** Accumulated `outputDelta` text per commandExecution item, attached to
   *  the final snapshot when the wire `item/completed` carries no output. */
  readonly outputs: ReadonlyMap<string, string>;
  /** Accumulated reasoning deltas per reasoning item, attached to the final
   *  snapshot when the wire `item/completed` carries no `content`. Deltas are
   *  live-only (never persisted), so without this the reasoning text is
   *  unrecoverable on replay and the row reads back empty (#528).
   *
   *  Kept PER CHANNEL: `item/reasoning/textDelta` streams the raw chain of
   *  thought while `summaryDelta`/`summaryTextDelta` stream the condensed
   *  summary, and codex emits both when raw reasoning is enabled. One shared
   *  bucket would concatenate the two into `"<raw CoT><summary>"` and persist
   *  that garble over the clean wire `summary`.
   *
   *  Turn-scoped, and reset by `turn/started`: an interrupted item is never
   *  completed, so without the reset its text would both leak into a later
   *  turn that reuses the id and pin whole chains of thought in memory. */
  readonly reasonings: ReadonlyMap<string, ReasoningAccumulator>;
  /** True once `turn/plan/updated` has spoken IN THE CURRENT TURN. Both that
   *  notification and the `plan`/`todoList` item arm write `plan.updated`, so
   *  without a precedence rule the last frame wins and a prose plan item would
   *  flatten the real checklist into one entry. The authoritative channel
   *  latches this and the item arm stands down (see `mapItemLifecycle`).
   *
   *  Turn-scoped, and reset by `turn/started`: a plan belongs to a turn (hence
   *  `turn/plan/updated`), so a latch that outlived its turn would gag the item
   *  arm for the rest of the session and strand the dock on a stale checklist. */
  readonly planFromNotification: boolean;
  /** The open review-mode item's id, or `null` when review mode is not active.
   *
   *  Codex announces review mode as two disjoint frames (`enteredReviewMode`,
   *  `exitedReviewMode`) with different ids. Mapped literally that is two
   *  childless `task` items — which the Agents dock would read as two separate
   *  sub-agents that each did nothing (spec
   *  `.ai/specs/2026-07-20-grouped-subagent-display.md` §"Codex-mapper fix",
   *  #474). This latch folds the pair into ONE item with a running→completed
   *  lifecycle: the entered frame opens it, the exited frame completes that
   *  same id. An unpaired exit falls back to its own item, so a stream that
   *  starts mid-review still renders. */
  readonly reviewItemId: string | null;
  /** Child thread → stable task item created by a Codex collaboration spawn.
   * Installed 0.144.6 uses `collabAgentToolCall`; newer protocol revisions use
   * `collabToolCall`. Both carry the receiver ids used for child attribution. */
  readonly collabTasks: ReadonlyMap<string, CodexCollabTask>;
  /** Background spawn rows still running, keyed by item id (hearsay-tools/cezarion#2431): a
   *  `subAgentActivity(kind: started)` child outlives the parent turn, so its row stays running
   *  until the child's `subAgentActivity(kind: completed)`. */
  readonly backgroundTasks: ReadonlyMap<string, UiToolItem>;
}
