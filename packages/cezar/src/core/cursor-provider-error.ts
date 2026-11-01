/**
 * Cursor provider error text (#443). Cursor wraps a provider failure in a literal `\n\nError: `
 * prefix. Print sessions embed the text in a run error and transcript, so it is reduced to one
 * line and capped.
 */

/** Preserved provider text is diagnosis, not transcript bulk — cap it. */
export const CURSOR_PROVIDER_ERROR_MAX_CHARS = 500;

const ENVELOPE_PREFIX_RE = /^\n\nError: /u;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

/** Strip the envelope prefix, control characters and runs of whitespace, then cap for display. */
export function sanitizeCursorProviderError(text: string): string {
  return text.replace(ENVELOPE_PREFIX_RE, '').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim()
    .slice(0, CURSOR_PROVIDER_ERROR_MAX_CHARS);
}
