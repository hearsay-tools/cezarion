/**
 * OMP provider-failure surfacing and message usage accounting.
 *
 * Moved verbatim (code and comments) from omp-ui-mapper.ts when splitting the mapper
 * functions for hearsay-tools/cezarion#2836 crossed that file's 1,000-line limit.
 * Types import back from the mapper; nothing here imports mapper functions, so there
 * is no runtime cycle.
 */
import type { TokenUsage, UiEvent } from './ui-events.js';
import type { OmpUiMapperState, OmpUiMapping } from './omp-ui-mapper.ts';
import { isRecord, number, string } from './pi-rpc-wire.ts';

/** Same as pi-ui-mapper.ts `piFlushProviderError`: release the latch as `session.error` (#256). */
export function ompFlushProviderError(state: OmpUiMapperState): OmpUiMapping {
  if (!state.latchedProviderError) return { events: [], state };
  return {
    events: [{ type: 'session.error', message: state.latchedProviderError, fatal: false }],
    state: { ...state, latchedProviderError: null },
  };
}

/** Same as pi-ui-mapper.ts `piProviderErrorMessage`, prefixed `omp:`. */
export function ompProviderErrorMessage(message: Record<string, unknown>): string {
  const detail = ompProviderErrorDetail(message);
  const provider = string(message.provider);
  const model = string(message.model);
  const who = provider && model ? `${provider}/${model}` : (provider ?? model);
  if (who && detail) return `omp: ${who} request failed: ${detail}`;
  if (who) return `omp: ${who} request failed`;
  if (detail) return `omp: provider request failed: ${detail}`;
  return 'omp: provider request failed';
}

/** Same as pi-ui-mapper.ts `piProviderErrorDetail`. */
function ompProviderErrorDetail(message: Record<string, unknown>): string | undefined {
  if (Array.isArray(message.diagnostics)) {
    for (const diagnostic of message.diagnostics) {
      if (!isRecord(diagnostic) || string(diagnostic.type) !== 'provider_transport_failure') continue;
      const error = isRecord(diagnostic.error) ? string(diagnostic.error.message) : undefined;
      if (error) return error;
    }
  }
  return string(message.errorMessage);
}

/** Read the same native per-message report for both v1 and v2, including child envelopes. */
export function ompMessageUsage(value: unknown): Extract<UiEvent, { type: 'usage.updated' }> | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === 'subagent_event') {
    if (!isRecord(value.payload) || !string(value.payload.id) || !isRecord(value.payload.event)) return undefined;
    value = value.payload.event;
  }
  if (!isRecord(value) || value.type !== 'message_end' || !isRecord(value.message) || value.message.role !== 'assistant') return undefined;
  return usageEvent(value.message.usage);
}

function sumUsage(previous: TokenUsage | null, next: TokenUsage): TokenUsage {
  return {
    input: (previous?.input ?? 0) + next.input,
    output: (previous?.output ?? 0) + next.output,
    total: (previous?.total ?? 0) + (next.total ?? 0),
    ...(previous?.cacheRead !== undefined || next.cacheRead !== undefined
      ? { cacheRead: (previous?.cacheRead ?? 0) + (next.cacheRead ?? 0) } : {}),
    ...(previous?.cacheWrite !== undefined || next.cacheWrite !== undefined
      ? { cacheWrite: (previous?.cacheWrite ?? 0) + (next.cacheWrite ?? 0) } : {}),
  };
}

export function accountUsage(report: ReturnType<typeof ompMessageUsage>, state: OmpUiMapperState): OmpUiMapping {
  if (!report) return { events: [], state };
  const sessionUsage = sumUsage(state.sessionUsage, report.usage);
  const sessionCostUsd = report.costUsd === undefined ? state.sessionCostUsd : (state.sessionCostUsd ?? 0) + report.costUsd;
  return {
    events: [{ type: 'usage.updated', usage: sessionUsage, ...(sessionCostUsd !== null ? { costUsd: sessionCostUsd } : {}) }],
    state: {
      ...state, sessionUsage, sessionCostUsd,
      ...(state.turnId ? {
        turnUsage: sumUsage(state.turnUsage, report.usage),
        turnCostUsd: report.costUsd === undefined ? state.turnCostUsd : (state.turnCostUsd ?? 0) + report.costUsd,
      } : {}),
    },
  };
}

/** Native OMP message usage is an increment; the public usage.updated event is cumulative. */
function usageEvent(value: unknown): Extract<UiEvent, { type: 'usage.updated' }> | undefined {
  if (!isRecord(value)) return undefined;
  const input = number(value.input) ?? 0;
  const output = number(value.output) ?? 0;
  const cacheRead = number(value.cacheRead);
  const cacheWrite = number(value.cacheWrite);
  const total = number(value.totalTokens) ?? input + output + (cacheRead ?? 0) + (cacheWrite ?? 0);
  const cost = isRecord(value.cost) ? number(value.cost.total) : undefined;
  if (total <= 0 && !(cost !== undefined && cost > 0)) return undefined;
  return {
    type: 'usage.updated',
    usage: {
      input,
      output,
      total,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    },
    ...(cost !== undefined && cost >= 0 ? { costUsd: cost } : {}),
  };
}
