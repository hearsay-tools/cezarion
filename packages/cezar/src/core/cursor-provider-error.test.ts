import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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

  it('classes the recorded RetriableError stream-protocol envelope as transient', () => {
    const envelope = readFileSync(new URL('./__fixtures__/cursor/retriable-protocol-error.txt', import.meta.url), 'utf8');
    expect(classifyCursorProviderError(envelope, now)).toEqual({ kind: 'transient' });
    expect(sanitizeCursorProviderError(envelope))
      .toBe('RetriableError: [invalid_argument] protocol error: missing EndStreamResponse');
  });

  it('classes the recorded SSL record-layer envelope as transient', () => {
    const envelope = readFileSync(new URL('./__fixtures__/cursor/ssl-record-layer-error.txt', import.meta.url), 'utf8');
    expect(classifyCursorProviderError(envelope, now)).toEqual({ kind: 'transient' });
    expect(sanitizeCursorProviderError(envelope))
      .toBe('RetriableError: [internal] C0AC9346CC7B0000:error:0A000119:SSL routines:tls_get_more_records:decryption failed or bad record mac:../deps/openssl/openssl/ssl/record/methods/tls_common.c:869:');
  });

  it.each([
    '[internal] C0AC9346CC7B0000:error:0A000119:SSL routines:tls_get_more_records:decryption failed or bad record mac:../deps/openssl/openssl/ssl/record/methods/tls_common.c:869:',
    '[internal] tls_get_more_records failed',
    '[internal] decryption failed or bad record mac',
  ])('classes bare SSL/TLS OpenSSL record-layer prose as transient without RetriableError: %s', detail => {
    expect(classifyCursorProviderError(`\n\nError: ${detail}`, now)).toEqual({ kind: 'transient' });
  });

  it.each([
    '[internal] SSL routines:tls_process_server_certificate:certificate verify failed',
    '[internal] SSL routines:tls_read:fatal',
  ])('keeps permanent TLS setup errors fatal even when they mention SSL routines: %s', detail => {
    expect(classifyCursorProviderError(`\n\nError: ${detail}`, now)).toEqual({ kind: 'fatal' });
  });

  it('keeps a bare [internal] Cursor code fatal when it is not an SSL/TLS record-layer failure', () => {
    expect(classifyCursorProviderError('\n\nError: [internal] C0AC9346CC7B0000:error:0A000001:unknown provider fault', now))
      .toEqual({ kind: 'fatal' });
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

  it('keeps authentication failures fatal even when the envelope also has SSL record-layer prose', () => {
    expect(classifyCursorProviderError('\n\nError: [unauthenticated] SSL routines:tls_get_more_records', now))
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
