import { parseUsageLimit } from './usage-limit.ts';

/**
 * Cursor provider error envelopes (#443). Cursor 2026.09.15 catches provider
 * failures and emits them as an `agent_message_chunk` beginning with a literal
 * `\n\nError: ` prefix, then ends the turn. The runner used to reduce that
 * envelope to two canned strings, which discarded the reset instants the
 * auto-resume machinery (spec 2026-08-03) needs and made a transient 429/5xx
 * indistinguishable from a fatal one.
 */

/** Preserved provider text is diagnosis, not transcript bulk — cap it. */
export const CURSOR_PROVIDER_ERROR_MAX_CHARS = 500;

export type CursorProviderErrorClassification =
  | { kind: 'auth' }
  | { kind: 'transient'; resetAt?: Date }
  | { kind: 'fatal' };

const ENVELOPE_PREFIX_RE = /^\n\nError: /u;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

/**
 * Transient provider failure signals worth one more prompt. Deliberately wide —
 * the cost of a false positive is two wasted prompts (bounded below), while the
 * cost of a false negative is a dead run that needed a human Continue. Fatal
 * prose like "context length exceeded" or "model not found" matches none of these.
 */
const TRANSIENT_SIGNAL_RE =
  /\b(?:429|500|502|503|504|rate[ _-]?limit(?:ed)?|overloaded|temporar(?:y|ily)|timed?[ _-]?out|bad gateway|service unavailable|internal server error|connection (?:reset|refused|closed|error)|econn(?:reset|refused|aborted)|socket hang up|try again|retry)\b/i;

/**
 * Strip the envelope prefix, control characters and runs of whitespace, and cap
 * the length. The result is safe to embed in a run error and keeps the phrases
 * `parseUsageLimit` matches on intact — that is what lets a fatal outcome still
 * carry the reset instant the auto-resume scheduler reads.
 */
export function sanitizeCursorProviderError(text: string): string {
  return text
    .replace(ENVELOPE_PREFIX_RE, '')
    .replace(CONTROL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CURSOR_PROVIDER_ERROR_MAX_CHARS);
}

/**
 * Classify a raw envelope chunk. Auth wins first (login guidance, fatal);
 * a limit phrase with a usable reset instant makes it transient-with-instant;
 * any other transient signal is transient-without-instant; everything else is fatal.
 */
export function classifyCursorProviderError(text: string, now = Date.now()): CursorProviderErrorClassification {
  const detail = sanitizeCursorProviderError(text);
  if (/unauthenticated/i.test(detail)) return { kind: 'auth' };
  const limit = parseUsageLimit(detail, now);
  if (limit) return { kind: 'transient', resetAt: limit.resetAt };
  if (TRANSIENT_SIGNAL_RE.test(detail)) return { kind: 'transient' };
  return { kind: 'fatal' };
}
