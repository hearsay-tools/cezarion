/**
 * The opencode UI mapper's fold state and mapping result: `SubtaskScope`,
 * `OpencodeUiMapperState` and `OpencodeUiMapping`. `opencode-ui-mapper.ts`
 * re-exports `OpencodeUiMapperState` and `OpencodeUiMapping`.
 */

import type { MessageUsage } from './opencode-usage.ts';
import type { ToolStatus, UiEvent } from './ui-events.ts';

interface SubtaskScope {
  readonly id: string;
  /** The wire tool name the item was started under (`subtask` for subtask
   *  parts, `task` for the task tool) — completion keeps the same name. */
  readonly name: string;
  readonly title: string;
  readonly input?: unknown;
  /** The child session the wire named for this scope, when it did: opencode's
   *  task tool publishes `metadata.sessionId` on its running snapshot right
   *  after creating the child. Known → bound directly, never through FIFO. */
  readonly childSession?: string;
  /** The scope this one was opened inside (a task issued from a child
   *  session) — completion keeps the same nesting. */
  readonly parentItemId?: string;
}

export interface OpencodeUiMapperState {
  /** The main session id (from POST /session) — the SSE bus is server-wide,
   *  so this is what separates our events from a subtask's child session. */
  readonly sessionId: string | null;
  /** True once `opencodeSessionStarted` emitted `session.started`. */
  readonly sessionStarted: boolean;
  readonly turnSeq: number;
  readonly currentTurnId: string | null;
  /** Message ids observed during the active turn. Their latest snapshots are
   * summed once when the matching `session.idle` closes the turn. */
  readonly currentTurnMessageIds: ReadonlySet<string>;
  /** A `session.error` arrived since the turn started → `session.idle`
   *  closes the turn with stopReason 'error' (§7.1). */
  readonly turnErrored: boolean;
  /** messageID → role. Parts carry no role; only assistant parts surface
   *  (the user's own prompt streams as parts over the same feed). */
  readonly msgRoles: ReadonlyMap<string, string>;
  /** Text/reasoning part id → chars already emitted as deltas. */
  readonly cursors: ReadonlyMap<string, number>;
  /** Part ids whose `item.started` was emitted. */
  readonly startedItems: ReadonlySet<string>;
  /** Text/reasoning/patch part ids whose `item.completed` was emitted. */
  readonly endedItems: ReadonlySet<string>;
  /** Tool part id → last emitted status/title (flip + live-title detection).
   *  `live` says the title came off the wire rather than being derived from
   *  the input, so only a live title is worth carrying over. */
  readonly tools: ReadonlyMap<string, { status: ToolStatus; title: string; live: boolean }>;
  /** Serialized last plan — todowrite snapshots are idempotent, so identical
   *  replacements emit no duplicate `plan.updated`. */
  readonly lastPlanJson: string | null;
  /** Child session id → subtask scope. Foreign parts are attributed only to
   *  their own child session; that session's idle completes the scope. */
  readonly subtasks: ReadonlyMap<string, SubtaskScope>;
  /** Subtask parts and task tool calls do not carry the child session id.
   *  Pending scopes bind to child sessions first-in-first-out: the oldest
   *  pending subtask takes the next child session heard from
   *  (hearsay-tools/cezarion#5). */
  readonly unboundSubtasks: readonly SubtaskScope[];
  /** Child sessions whose scope is over (the child went idle, its task tool
   *  settled, or the main turn ended around it). A late event from one must
   *  never claim a pending scope through the FIFO queue — not in this turn and
   *  not in a later one, so the set lives as long as the mapper state does
   *  (one id per child session ever seen; small by construction). */
  readonly closedSessions: ReadonlySet<string>;
  readonly usageByMessage: ReadonlyMap<string, MessageUsage>;
  /** Last emitted session totals — usage.updated fires only on change. */
  readonly lastUsage: { total: number; cost: number | null } | null;
}

export interface OpencodeUiMapping {
  events: UiEvent[];
  state: OpencodeUiMapperState;
}

export type { SubtaskScope };
