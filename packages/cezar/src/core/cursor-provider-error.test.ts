import { describe, expect, it } from 'vitest';
import { CURSOR_PROVIDER_ERROR_MAX_CHARS, sanitizeCursorProviderError } from './cursor-provider-error.ts';

describe('sanitizeCursorProviderError', () => {
  it('strips the Cursor error-envelope prefix and collapses whitespace', () => {
    expect(sanitizeCursorProviderError('\n\nError: 429 rate limited\ntry again soon\n'))
      .toBe('429 rate limited try again soon');
  });

  it('strips control characters and caps the length', () => {
    const clean = sanitizeCursorProviderError(`\n\nError: boom \u0007${'x'.repeat(2000)}`);
    expect(clean).not.toContain('\u0007');
    expect(clean.length).toBeLessThanOrEqual(500);
    expect(clean.startsWith('boom')).toBe(true);
  });

  it('leaves text without the envelope prefix intact apart from sanitization', () => {
    expect(sanitizeCursorProviderError('plain 429 failure')).toBe('plain 429 failure');
  });
});
