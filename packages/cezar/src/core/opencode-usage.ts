/**
 * Opencode telemetry: the per-message `MessageUsage` record, wire-token
 * parsing (`tokensToUsage`), the additive merge (`addUsage`), and the session
 * totals emitted as `usage.updated` (`emitUsage`, `usageForMessages`). The
 * state and mapping types come from `opencode-ui-mapper-state.ts`.
 */

import type { OpencodeUiMapperState, OpencodeUiMapping } from './opencode-ui-mapper-state.ts';
import type { TokenUsage, UiUsageUpdatedEvent } from './ui-events.ts';

/** Per-message telemetry: `message.updated` snapshots (cumulative per
 *  message) and summed `step-finish` increments are tracked separately —
 *  they describe the same accumulation, so the larger total wins and
 *  nothing is double-counted. */
export interface MessageUsage {
  readonly info: TokenUsage | null;
  readonly infoCost: number | null;
  readonly steps: TokenUsage | null;
  readonly stepsCost: number | null;
}

const EMPTY_MESSAGE_USAGE: MessageUsage = { info: null, infoCost: null, steps: null, stepsCost: null };

/** `{input, output, reasoning, cache:{read,write}}` → raw TokenUsage
 *  (opencode reports no total — the sum of the parts is the total). */
function tokensToUsage(tokens: unknown): TokenUsage | undefined {
  if (!isRecord(tokens)) return undefined;
  const input = num(tokens.input) ?? 0;
  const output = num(tokens.output) ?? 0;
  const reasoning = num(tokens.reasoning);
  const cache = isRecord(tokens.cache) ? tokens.cache : undefined;
  const cacheRead = cache ? num(cache.read) : undefined;
  const cacheWrite = cache ? num(cache.write) : undefined;
  const usage: TokenUsage = {
    input,
    output,
    total: input + output + (reasoning ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
  };
  if (cacheRead !== undefined) usage.cacheRead = cacheRead;
  if (cacheWrite !== undefined) usage.cacheWrite = cacheWrite;
  if (reasoning !== undefined) usage.reasoning = reasoning;
  return usage;
}

function addUsage(a: TokenUsage | null, b: TokenUsage): TokenUsage {
  if (a === null) return b;
  const sum: TokenUsage = { input: a.input + b.input, output: a.output + b.output, total: a.total + b.total };
  const cacheRead = optSum(a.cacheRead, b.cacheRead);
  if (cacheRead !== undefined) sum.cacheRead = cacheRead;
  const cacheWrite = optSum(a.cacheWrite, b.cacheWrite);
  if (cacheWrite !== undefined) sum.cacheWrite = cacheWrite;
  const reasoning = optSum(a.reasoning, b.reasoning);
  if (reasoning !== undefined) sum.reasoning = reasoning;
  return sum;
}

function optSum(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function maxCost(a: number | null, b: number | undefined): number | null {
  if (b === undefined) return a;
  return a === null ? b : Math.max(a, b);
}

/** Session totals = per-message effective usage summed across messages;
 *  emitted only when the snapshot actually changed and is non-zero. */
function emitUsage(state: OpencodeUiMapperState): OpencodeUiMapping {
  let usage: TokenUsage = { input: 0, output: 0, total: 0 };
  let cost: number | null = null;
  for (const mu of state.usageByMessage.values()) {
    const effective = mu.info !== null && (mu.steps === null || mu.info.total >= mu.steps.total) ? mu.info : mu.steps;
    if (effective !== null) usage = addUsage(usage, effective);
    const effCost = maxCost(mu.infoCost, mu.stepsCost ?? undefined);
    if (effCost !== null) cost = (cost ?? 0) + effCost;
  }
  if (usage.total === 0 && (cost === null || cost === 0)) return { events: [], state };
  if (state.lastUsage !== null && state.lastUsage.total === usage.total && state.lastUsage.cost === cost) {
    return { events: [], state };
  }
  const event: UiUsageUpdatedEvent = { type: 'usage.updated', usage };
  if (cost !== null) event.costUsd = cost;
  return { events: [event], state: { ...state, lastUsage: { total: usage.total, cost } } };
}

function usageForMessages(
  messageIds: ReadonlySet<string>,
  usageByMessage: ReadonlyMap<string, MessageUsage>,
): { usage: TokenUsage | null; cost: number | null } {
  let usage: TokenUsage | null = null;
  let cost: number | null = null;
  for (const id of messageIds) {
    const message = usageByMessage.get(id);
    if (message === undefined) continue;
    const effective =
      message.info !== null && (message.steps === null || message.info.total >= message.steps.total)
        ? message.info
        : message.steps;
    if (effective !== null && (effective.input > 0 || effective.output > 0)) usage = addUsage(usage, effective);
    const effectiveCost = maxCost(message.infoCost, message.stepsCost ?? undefined);
    if (effectiveCost !== null && effectiveCost > 0) cost = (cost ?? 0) + effectiveCost;
  }
  return { usage, cost };
}

export { EMPTY_MESSAGE_USAGE, addUsage, emitUsage, maxCost, tokensToUsage, usageForMessages };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
