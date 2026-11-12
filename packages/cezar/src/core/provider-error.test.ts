import { describe, expect, it } from 'vitest';
import { classifyProviderError } from './provider-error.ts';

// Each row is a failure text a runner emits today (hearsay-tools/squawk#3337).
describe('classifyProviderError', () => {
  it.each([
    ['claude 429', 'step "task" failed: API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}', 'rate-limit'],
    ['codex spend limit', 'step "task" failed: {"status":429,"error":{"type":"usage_limit_reached","message":"You have hit your spend limit"}}', 'rate-limit'],
    ['an exhausted balance in a 400', 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"insufficient credits remaining on this account"}}', 'credit'],
    ['credit balance as a 400', 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}', 'credit'],
    ['claude overloaded', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'overloaded'],
    ['omp overloaded', 'omp: anthropic/claude-sonnet request failed: Overloaded', 'overloaded'],
    ['proxy 502', 'API Error: 502 Bad Gateway', 'server'],
    ['opencode 503', 'opencode: provider anthropic/claude request failed: upstream unavailable (HTTP 503)', 'server'],
    ['codex stream gone', 'Codex stream made no progress for 60s: stream disconnected before completion', 'server'],
    ['codex unreachable', 'Codex stream made no progress for 60s: Reconnecting... waiting for network — Connection failed: error sending request', 'server'],
    ['omp bare 500', 'omp: anthropic/claude-mock request failed: 500 {"type":"error","error":{"type":"api_error","message":"Internal error"}}', 'server'],
    ['pi bare 503', 'pi: openai/gpt-test request failed: 503 upstream unavailable', 'server'],
    ['proxy 404 on /v1/responses', 'unexpected status 404 Not Found: {"detail":"Not Found"} url: http://127.0.0.1:4000/v1/responses', 'proxy-not-found'],
    ['pi not found', 'pi: openai/gpt-5 request failed: Not Found', 'proxy-not-found'],
    ['claude 401', 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.', 'access'],
    ['opencode auth', 'opencode: provider anthropic/claude request failed: ProviderAuthError', 'access'],
    ['model not available', 'API Error: 403 {"error":{"type":"permission_error","message":"model claude-x is not available on your plan"}}', 'access'],
  ])('%s is a provider error', (_name, message, kind) => {
    expect(classifyProviderError(message)).toMatchObject({ kind });
  });

  it.each([
    ['a 400 that only mentions billing', 'API Error: 400 invalid_request_error: billing metadata is invalid'],
    ['a bad request', 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: text content blocks must be non-empty"}}'],
    ['the no-progress kill alone', 'Agent made no progress for 30 minutes during an open turn and was terminated'],
    ['a CLI exit', 'claude CLI exited with code 1 — Error: ENOENT: no such file or directory'],
    ['a tool failure', 'step "task" failed: unexpected tool error'],
    ['nothing', ''],
    ['undefined', undefined],
  ])('%s is not', (_name, message) => {
    expect(classifyProviderError(message)).toBeNull();
  });

  it('keeps one bounded line of detail', () => {
    const detail = classifyProviderError(`API Error: 429\n${'x'.repeat(500)}`)!.detail;
    expect(detail).not.toContain('\n');
    expect(detail.length).toBe(200);
  });
});
