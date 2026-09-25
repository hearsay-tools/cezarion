import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { appendCursorStderr, classifyCursorProviderError, CURSOR_PROVIDER_ERROR_MAX_CHARS, sanitizeCursorProviderError } from './cursor-provider-error.ts';

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

describe('appendCursorStderr', () => {
  it('keeps only the last cap as chunks arrive, so a live session cannot grow unbounded', () => {
    let buf = appendCursorStderr('', 'a'.repeat(400));
    buf = appendCursorStderr(buf, 'b'.repeat(200));
    expect(buf.length).toBe(CURSOR_PROVIDER_ERROR_MAX_CHARS);
    expect(buf.endsWith('b'.repeat(200))).toBe(true);
    expect(buf.startsWith('a'.repeat(300))).toBe(true);
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

  it('classes the recorded resource_exhausted envelope as transient', () => {
    const envelope = readFileSync(new URL('./__fixtures__/cursor/resource-exhausted.txt', import.meta.url), 'utf8');
    expect(classifyCursorProviderError(envelope, now)).toEqual({ kind: 'transient' });
    expect(sanitizeCursorProviderError(envelope)).toBe('RetriableError: [resource_exhausted] Error');
  });

  it('classes bare [resource_exhausted] prose as transient without RetriableError', () => {
    expect(classifyCursorProviderError('\n\nError: [resource_exhausted] Error', now)).toEqual({ kind: 'transient' });
  });

  it('keeps unknown Cursor [internal] codes fatal', () => {
    expect(classifyCursorProviderError('\n\nError: [internal] Error', now)).toEqual({ kind: 'fatal' });
  });

  it('classes the recorded RetriableError stream-protocol envelope as transient', () => {
    const envelope = readFileSync(new URL('./__fixtures__/cursor/retriable-protocol-error.txt', import.meta.url), 'utf8');
    expect(classifyCursorProviderError(envelope, now)).toEqual({ kind: 'transient' });
    expect(sanitizeCursorProviderError(envelope))
      .toBe('RetriableError: [invalid_argument] protocol error: missing EndStreamResponse');
  });

  it.each([
    '[invalid_argument] protocol error: missing EndStreamResponse',
    '[invalid_argument] protocol error: unknown frame',
    'NonRetriableError: [invalid_argument] protocol error: unknown frame',
  ])('keeps protocol errors without an explicit transient signal fatal: %s', detail => {
    expect(classifyCursorProviderError(`\n\nError: ${detail}`, now)).toEqual({ kind: 'fatal' });
  });

  it('keeps authentication failures fatal even when marked RetriableError', () => {
    expect(classifyCursorProviderError('\n\nError: RetriableError: [unauthenticated] request rejected', now))
      .toEqual({ kind: 'auth' });
  });

  it('reads a reset instant that sits beyond the display-detail cap', () => {
    // #446 round 3: the 500-char detail cap is for display; classification parses the full
    // envelope, or a verbose provider message buries the instant the recovery machinery needs.
    const verbose = `\n\nError: usage limit reached. The request ${'x'.repeat(600)} could not be completed, try again at 2026-09-18T21:00:00Z`;
    const hit = classifyCursorProviderError(verbose, now);
    expect(hit).toEqual({ kind: 'transient', resetAt: new Date('2026-09-18T21:00:00Z') });
  });
});
