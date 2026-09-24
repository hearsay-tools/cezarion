import { createHash } from 'node:crypto';

/**
 * Idempotent `POST /runs` (#504, spec 2026-09-24-cez-task-cli): the fingerprint of a start
 * request, so a retry carrying the same `clientRequestId` can prove it is the SAME request.
 *
 * Only the keys that decide what the run does. Attachments, the inbox bookkeeping id and the
 * follow-ups flag stay out: none of them changes the task, and a retry that differs only there
 * is still the same start. The record stores this hash, never the payload.
 */
const KEYS = ['task', 'workflow', 'steps', 'runner', 'model', 'effort', 'agentProfile', 'autonomous', 'worktree', 'systemPrompt'] as const;

export type ClientRequestPayload = Partial<Record<(typeof KEYS)[number], unknown>> & Record<string, unknown>;

/** Sorted keys, `undefined` dropped, so key order and absent-vs-undefined never change the hash. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, canonical(record[key])]));
  }
  return value;
}

export function clientRequestHash(body: ClientRequestPayload): string {
  const picked = Object.fromEntries(KEYS.map((key) => [key, body[key]]));
  return createHash('sha256').update(JSON.stringify(canonical(picked))).digest('hex');
}
