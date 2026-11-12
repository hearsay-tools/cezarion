// The repository's Actions token has one core quota (5,000 calls an hour) for
// every workflow. This helper counts what one job spends and lets a
// low-priority job stand down when the quota is nearly gone.
// GET /rate_limit does not count against the quota, so neither does it here.
const DEFAULT_FLOOR = 800;

function isRateLimitRead(options) {
  return /(?:^|\/)rate_limit$/.test(String(options?.url || '').split('?')[0]);
}

// The core quota from GET /rate_limit, or undefined when it cannot be read.
async function readCoreLimit(github) {
  try {
    const {data} = await github.request('GET /rate_limit');
    const core = data?.resources?.core;
    return Number.isFinite(core?.remaining) ? core : undefined;
  } catch {
    return undefined;
  }
}

// Installs an Octokit request hook. Every request except GET /rate_limit adds
// one call, pages and failed requests included. `summary()` returns the line a
// job logs at its end; core remaining comes from the last core response's
// headers, so the summary itself makes no request.
function countApiCalls(github) {
  let calls = 0, coreRemaining;
  const observe = headers => {
    if (headers?.['x-ratelimit-resource'] !== 'core') return;
    const remaining = Number(headers['x-ratelimit-remaining']);
    if (Number.isFinite(remaining)) coreRemaining = remaining;
  };
  github.hook.wrap('request', async (request, options) => {
    if (isRateLimitRead(options)) return request(options);
    calls++;
    try {
      const response = await request(options);
      observe(response?.headers);
      return response;
    } catch (error) {
      observe(error?.response?.headers);
      throw error;
    }
  });
  return {
    get calls() { return calls; },
    summary() {
      return `GitHub API calls: ${calls} (core remaining ${coreRemaining ?? 'unknown'})`;
    },
  };
}

// Reads the core quota before a low-priority job starts. `proceed` is false
// only when the remaining quota is known and under the floor; the caller then
// ends successfully. An unreadable quota does not stop the job.
async function checkFloor({github, floor = DEFAULT_FLOOR, log = () => {}}) {
  if (!Number.isSafeInteger(floor) || floor < 0) throw new Error('API budget floor must be a non-negative integer');
  const core = await readCoreLimit(github);
  if (!core) {
    log('GitHub API budget: the core rate limit could not be read; continuing.');
    return {proceed: true};
  }
  if (core.remaining >= floor) return {proceed: true, remaining: core.remaining};
  const reset = Number.isFinite(core.reset) ? new Date(core.reset * 1000).toISOString() : 'an unknown time';
  log(`GitHub API budget: core remaining ${core.remaining} is under the floor of ${floor}; this low-priority job stops without work. The quota resets at ${reset}.`);
  return {proceed: false, remaining: core.remaining};
}

module.exports = {DEFAULT_FLOOR, countApiCalls, checkFloor};
