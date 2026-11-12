const test = require('node:test');
const assert = require('node:assert/strict');
const {DEFAULT_FLOOR, countApiCalls, checkFloor} = require('./api-budget.cjs');

// A minimal Octokit: `request` runs through the hooks registered with
// `hook.wrap('request', ...)`, as @octokit/core does, and `paginate` calls
// `request` once per page.
function octokit(respond) {
  const seen = [];
  let send = async options => { seen.push(options); return respond(options); };
  const request = (route, params = {}) => {
    const [method, url] = route.includes(' ') ? route.split(' ') : ['GET', route];
    return send({method, url, ...params});
  };
  return {
    seen,
    request,
    paginate: async (route, params) => {
      const rows = [];
      for (const page of [1, 2, 3]) rows.push(...(await request(route, {...params, page})).data);
      return rows;
    },
    hook: {wrap(name, wrapper) {
      assert.equal(name, 'request');
      const inner = send;
      send = options => wrapper(inner, options);
    }},
  };
}
const core = remaining => ({'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': String(remaining)});
const limits = core => ({data: {resources: {core, search: {remaining: 30}}}});

test('counts every request and page, failures included, but not the free rate-limit read', async () => {
  let remaining = 4000;
  const github = octokit(options => {
    if (options.url === '/rate_limit') return limits({remaining, reset: 1});
    if (options.url === '/fail') throw Object.assign(new Error('boom'), {response: {headers: core(--remaining)}});
    if (options.url === '/search/issues') return {headers: {'x-ratelimit-resource': 'search', 'x-ratelimit-remaining': '29'}, data: {}};
    return {headers: core(--remaining), data: [options.page]};
  });
  const calls = countApiCalls(github);
  assert.equal(calls.summary(), 'GitHub API calls: 0 (core remaining unknown)');
  await github.request('GET /rate_limit');
  await github.request('GET /repos/{owner}/{repo}', {owner: 'o', repo: 'r'});
  assert.deepEqual(await github.paginate('GET /repos/{owner}/{repo}/issues', {owner: 'o', repo: 'r'}), [1, 2, 3]);
  await assert.rejects(github.request('GET /fail'), /boom/);
  await github.request('GET /search/issues', {q: 'x'});
  assert.equal(calls.calls, 6);
  // The search response has its own budget; core remaining keeps the last core value.
  assert.equal(calls.summary(), 'GitHub API calls: 6 (core remaining 3995)');
  assert.equal(github.seen.length, 7);
});

test('a full-URL rate-limit read (a paginated next link form) is also free', async () => {
  const github = octokit(() => ({headers: core(10), data: []}));
  const calls = countApiCalls(github);
  await github.request('GET https://api.github.com/rate_limit');
  assert.equal(calls.calls, 0);
});

test('the floor stops a low-priority job only when the quota is known and under it', async () => {
  const messages = [];
  const log = message => messages.push(message);
  const at = remaining => octokit(() => limits({remaining, reset: 1794523443}));

  assert.deepEqual(await checkFloor({github: at(DEFAULT_FLOOR), log}), {proceed: true, remaining: 800});
  assert.equal(messages.length, 0);

  assert.deepEqual(await checkFloor({github: at(799), log}), {proceed: false, remaining: 799});
  assert.equal(messages.at(-1), 'GitHub API budget: core remaining 799 is under the floor of 800; this low-priority job stops without work. The quota resets at 2026-11-12T22:44:03.000Z.');

  assert.equal((await checkFloor({github: at(50), floor: 10, log})).proceed, true);
  assert.equal((await checkFloor({github: at(5), floor: 10, log})).proceed, false);
});

test('an unreadable quota lets the job run and says so', async () => {
  const messages = [];
  for (const respond of [() => { throw new Error('secret 500'); }, () => ({data: {}}), () => ({data: {resources: {core: {remaining: 'x'}}}})]) {
    assert.deepEqual(await checkFloor({github: octokit(respond), log: m => messages.push(m)}), {proceed: true});
  }
  assert.equal(messages.length, 3);
  assert.ok(messages.every(message => message === 'GitHub API budget: the core rate limit could not be read; continuing.'));
});

test('an invalid floor is a caller error', async () => {
  for (const floor of [-1, 1.5, '800', Number.NaN]) {
    await assert.rejects(checkFloor({github: octokit(() => limits({remaining: 1})), floor}), /non-negative integer/);
  }
});
