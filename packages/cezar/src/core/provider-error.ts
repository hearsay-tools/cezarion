/**
 * Which runner failures are provider errors: the model provider, or the proxy in front of it,
 * refused or failed the request, and the same request can succeed later without any change on
 * this side (hearsay-tools/squawk#3337). A run that fails on one parks and retries with back-off
 * instead of failing (`AutoResumeScheduler`).
 *
 * It reads the error text every runner already emits; no runner reports a structured kind. Shared
 * code calls it with the failure text alone, never a runner id. A request the provider rejects as
 * invalid (HTTP 400) is not a provider error, except when its text names the credit balance: the
 * Anthropic API reports a spent balance as a 400.
 *
 * Never throws: it runs on the failure path of every run.
 */
export type ProviderErrorKind = 'rate-limit' | 'credit' | 'overloaded' | 'server' | 'proxy-not-found' | 'access';
export type ProviderError = { kind: ProviderErrorKind; detail: string };

const CREDIT_RE = /credit balance (?:is )?too low|insufficient[\s_-]?(?:credits?|balance|funds|quota)|out of credits|payment required|\b402\b/i;
const REQUEST_ERROR_RE = /\b400\b|invalid_request_error|bad request/i;
const RATE_LIMIT_RE = /\b429\b|rate[\s_-]?limit|too many requests|(?:usage|spend(?:ing)?|session|weekly|hourly|monthly)[\s_-]?limit|quota (?:exceeded|reached)|resource[\s_-]?exhausted/i;
const OVERLOADED_RE = /overloaded|\b529\b/i;
const SERVER_RE = /(?:HTTP|status|API Error:?|error|code|request failed:)\W{0,3}5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout|upstream connect error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed|stream disconnected|Connection failed: error sending request/i;
const NOT_FOUND_RE = /\b404\b|request failed: Not Found|\bNot Found\b/;
const ACCESS_RE = /\b40[13]\b|unauthori[sz]ed|forbidden|failed to authenticate|authentication (?:failed|error)|ProviderAuthError|invalid (?:x-)?api[\s_-]?key|access token has been revoked|model_not_found|model (?:\S+ )?(?:is )?(?:not available|not found|does not exist|may not exist)|(?:no|not have) access to (?:the )?model/i;

const RULES: [ProviderErrorKind, RegExp][] = [
  ['rate-limit', RATE_LIMIT_RE], ['overloaded', OVERLOADED_RE], ['server', SERVER_RE],
  ['proxy-not-found', NOT_FOUND_RE], ['access', ACCESS_RE],
];

/** The longest detail a hold reason carries: one line, enough to name the status and the cause. */
const DETAIL_MAX = 200;

export function classifyProviderError(message: string | undefined): ProviderError | null {
  if (!message?.trim()) return null;
  const detail = message.replace(/\s+/g, ' ').trim().slice(0, DETAIL_MAX);
  if (CREDIT_RE.test(message)) return { kind: 'credit', detail };
  if (REQUEST_ERROR_RE.test(message)) return null;
  for (const [kind, pattern] of RULES) if (pattern.test(message)) return { kind, detail };
  return null;
}

/** What the run shows for a provider-error hold: `rate limit`, `credit balance`, … */
export const PROVIDER_ERROR_LABELS: Record<ProviderErrorKind, string> = {
  'rate-limit': 'rate limit', credit: 'credit balance', overloaded: 'provider overloaded',
  server: 'provider server error', 'proxy-not-found': 'model endpoint not found', access: 'model access denied',
};
