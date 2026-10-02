import { describe, expect, it } from 'vitest';
import { normalizePreviewUrl } from './url.ts';

describe('normalizePreviewUrl', () => {
  it('expands a bare port to localhost', () => {
    expect(normalizePreviewUrl('3000')).toBe('http://localhost:3000/');
  });

  it('adds http:// to a scheme-less address, host:port included', () => {
    expect(normalizePreviewUrl('localhost:5173/admin')).toBe('http://localhost:5173/admin');
    expect(normalizePreviewUrl('example.com')).toBe('http://example.com/');
  });

  it('keeps http and https URLs', () => {
    expect(normalizePreviewUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(normalizePreviewUrl('  http://127.0.0.1:8080  ')).toBe('http://127.0.0.1:8080/');
  });

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'data:text/html,x'])('refuses %s', input => {
    expect(() => normalizePreviewUrl(input)).toThrow('only http(s)');
  });
});
