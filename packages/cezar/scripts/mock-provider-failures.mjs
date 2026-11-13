// Each native mock's provider failures, one error class each, in that runner's own wire text
// (hearsay-tools/squawk#3337). `provider` is a request the provider rejects as invalid (HTTP 400):
// no retry can succeed, so the run fails. The other kinds are failures the same request can survive
// later (`core/provider-error.ts`), so Squawk holds the run and retries it with back-off. A rate
// limit names no reset time: one that does is a usage limit (`core/usage-limit.ts`).
//
// Claude Code puts the API status and body in an `is_error` result.
export const CLAUDE_FAILURES = {
  provider: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: text content blocks must be non-empty"}}',
  unavailable: 'API Error: 503 {"type":"error","error":{"type":"api_error","message":"Service Unavailable"}}',
  'rate-limit': 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
  'not-found': 'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"Not Found"}}',
  credit: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
};

// Codex fails the turn with the provider's JSON envelope as its error message. The 400 is the
// 0.147 rollout's (core/__fixtures__/codex/provider-error.md); the others use its envelope.
export const CODEX_FAILURES = {
  provider: { status: 400, type: 'invalid_request_error', message: "The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again." },
  unavailable: { status: 503, type: 'server_error', message: 'Service Unavailable' },
  'rate-limit': { status: 429, type: 'rate_limit_exceeded', message: 'Rate limit reached for gpt-6-astra on tokens per min.' },
  'not-found': { status: 404, type: 'not_found', message: 'Not Found' },
  credit: { status: 402, type: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.' },
};

// The Cursor print CLI's failed result names the Connect error code and the HTTP status.
export const CURSOR_FAILURES = {
  provider: 'ConnectError: [invalid_argument] HTTP 400 Bad Request: invalid_request_error: messages must be non-empty',
  unavailable: 'ConnectError: [unavailable] HTTP 503 Service Unavailable',
  'rate-limit': 'ConnectError: [resource_exhausted] HTTP 429 Too Many Requests: rate limit exceeded',
  'not-found': 'ConnectError: [not_found] HTTP 404 Not Found',
  credit: 'ConnectError: [resource_exhausted] You are out of credits. Upgrade your plan in billing settings to continue.',
};

// OpenCode forwards the AI SDK's `APIError`: `[statusCode, message]`.
export const OPENCODE_FAILURES = {
  provider: [400, 'Bad Request: invalid_request_error: messages: text content blocks must be non-empty'],
  unavailable: [503, 'Service Unavailable'],
  'rate-limit': [429, 'Too Many Requests: rate limit exceeded'],
  'not-found': [404, 'Not Found'],
  credit: [400, 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'],
};

// pi's `message_end` `errorMessage` carries the provider's status and body (openai-codex).
export const PI_FAILURES = {
  provider: '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: text content blocks must be non-empty"}}',
  unavailable: '503 Service Unavailable',
  'rate-limit': '429 Too Many Requests: rate limit reached for gpt-5.6-sol',
  'not-found': '404 Not Found',
  credit: 'insufficient_quota: You exceeded your current quota, please check your plan and billing details.',
};

// OMP's `message_end` `errorMessage` carries the Anthropic status and body.
export const OMP_FAILURES = {
  provider: '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: text content blocks must be non-empty"}}',
  unavailable: '503 {"type":"error","error":{"type":"api_error","message":"Service Unavailable"}}',
  'rate-limit': '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
  'not-found': 'Not Found',
  credit: '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
};
