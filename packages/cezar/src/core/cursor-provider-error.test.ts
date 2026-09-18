import { describe, expect, it } from 'vitest';
import { classifyCursorProviderError, sanitizeCursorProviderError } from './cursor-provider-error.ts';

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

describe('classifyCursorProviderError', () => {
  const now = Date.parse('2026-09-18T20:00:00Z');

  it('classes unauthenticated as auth regardless of other content', () => {
    expect(classifyCursorProviderError('\n\nError: [unauthenticated] Backend rejected authentication.', now))
      .toEqual({ kind: 'auth' });
  });

  it('classes a limit phrase with a reset instant as transient with the instant', () => {
    const hit = classifyCursorProviderError('\n\nError: usage limit reached, try again at 2026-09-18T21:00:00Z', now);
    expect(hit).toEqual({ kind: 'transient', resetAt: new Date('2026-09-18T21:00:00Z') });
  });

  it('classes a two-word "rate limited" 429 with an instant as transient with the instant', () => {
    // #443: "429 rate limited" is the phrasing a mid-work provider throttle uses;
    // the shared parser must see it, or the reset instant is lost to auto-resume.
    const hit = classifyCursorProviderError('\n\nError: 429 rate limited, try again at 2026-09-18T20:00:30Z', now);
    expect(hit).toEqual({ kind: 'transient', resetAt: new Date('2026-09-18T20:00:30Z') });
  });

  it('classes a bare 5xx blip as transient without an instant', () => {
    expect(classifyCursorProviderError('\n\nError: 502 bad gateway', now)).toEqual({ kind: 'transient' });
  });

  it('classes an overloaded provider notice as transient without an instant', () => {
    expect(classifyCursorProviderError('\n\nError: the provider is overloaded, please retry', now))
      .toEqual({ kind: 'transient' });
  });

  it('classes unknown provider prose as fatal', () => {
    expect(classifyCursorProviderError('\n\nError: context length exceeded', now)).toEqual({ kind: 'fatal' });
  });

  it('reads a reset instant that sits beyond the display-detail cap', () => {
    // #446 round 3: the 500-char detail cap is for display; classification parses the full
    // envelope, or a verbose provider message buries the instant the recovery machinery needs.
    const verbose = `\n\nError: usage limit reached. The request ${'x'.repeat(600)} could not be completed, try again at 2026-09-18T21:00:00Z`;
    const hit = classifyCursorProviderError(verbose, now);
    expect(hit).toEqual({ kind: 'transient', resetAt: new Date('2026-09-18T21:00:00Z') });
  });
});
