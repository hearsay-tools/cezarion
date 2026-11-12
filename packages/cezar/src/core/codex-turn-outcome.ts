import type { StopReason } from './ui-events.ts';

export const CODEX_TURN_STATUSES = ['interrupted', 'failed'] as const;
export type CodexTurnStatus = (typeof CODEX_TURN_STATUSES)[number];

const CODEX_TURN_STATUS: { [Status in CodexTurnStatus]: Status } = {
  interrupted: CODEX_TURN_STATUSES[0],
  failed: CODEX_TURN_STATUSES[1],
};

/** App-server reports provider failures on turn/completed with turn.error
 * and status=failed (#83). Keep v1 failure handling and v2 classification
 * aligned; an empty successful turn still belongs to the normal waiting path. */
export function codexTurnOutcome(
  method: string,
  params: Record<string, unknown>,
): { stopReason: StopReason; error?: string } {
  const turn = record(params.turn);
  const message = errorMessage(turn.error) ?? errorMessage(params.error);
  // Preserve the legacy turn/failed interrupt spelling. A provider error that
  // mentions an interrupted stream is still an error on turn/completed.
  if (turn.status === CODEX_TURN_STATUS.interrupted || (method === 'turn/failed' && /interrupt/i.test(message ?? ''))) {
    // Legacy turn/failed still emits a v1 error unless Squawk initiated teardown;
    // only its v2 stop reason is cancelled. Keep that existing lifecycle bound.
    return {
      stopReason: 'cancelled',
      ...(method === 'turn/failed' ? { error: message ?? 'codex turn failed' } : {}),
    };
  }
  if (method === 'turn/failed' || turn.status === CODEX_TURN_STATUS.failed || message !== undefined) {
    return { stopReason: 'error', error: message ?? 'codex turn failed' };
  }
  return { stopReason: 'end_turn' };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function errorMessage(error: unknown): string | undefined {
  const message = typeof error === 'string' ? error : record(error).message;
  return typeof message === 'string' && message.trim() !== '' ? message : undefined;
}
