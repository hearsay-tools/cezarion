const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRequest, callJev, mapAnswers, THRESHOLDS, NEVER_ASKED, ENDPOINT } = require('./jev-issue-intake.cjs');
const { validateIntake } = require('./apply-issue-intake.cjs');

const labels = [
  'accessibility', 'bug', 'documentation', 'duplicate', 'enhancement', 'question', 'repo-setup',
  'area-cezar', 'area-web', 'area-ci', 'needs-qa', 'in-progress', 'epic', 'upstream-port', 'friction',
].map((name) => ({ name, description: `${name} description` }));

const issue = { number: 211, title: 'Focus ring missing', body: 'The cockpit drops focus.' };
const candidates = [
  { number: 14, title: 'Focus lost on dialog close', body: 'x'.repeat(1000), labels: ['area-web'] },
  { number: 15, title: 'Release notes', body: '', labels: [] },
];
const request = buildRequest({ issue, candidates, labels });

function choice(picked, p) {
  return { type: 'choice', choice: picked, probabilities: { [picked]: p }, confidence: p };
}
function noul(p) {
  return { type: 'noul', noul: p };
}
function response(overrides = {}) {
  return {
    model: 'jev-1.13.0',
    answers: {
      duplicate: choice('none', 0.97),
      main_area: choice('area-web', 0.8),
      type: choice('bug', 0.9),
      'area:area-cezar': noul(0.1),
      'area:area-web': noul(0.95),
      'area:area-ci': noul(0.1),
      accessibility: noul(0.1),
      ...overrides,
    },
  };
}

test('asks one duplicate choice over the candidates plus none, never the new issue', () => {
  assert.equal(request.model, 'jev-1.13.0');
  assert.deepEqual(request.state, { title: issue.title, body: issue.body });
  assert.equal(request.questions.duplicate.type, 'choice');
  assert.deepEqual(Object.keys(request.questions.duplicate.criteria), ['#14', '#15', 'none']);
  assert.equal(request.questions.duplicate.criteria['#14'].title, 'Focus lost on dialog close');
  assert.ok(request.questions.duplicate.criteria['#14'].excerpt.length <= 301, 'excerpts stay short');
});

test('asks about areas, type and accessibility only, never the labels other processes set', () => {
  const keys = Object.keys(request.questions).sort();
  assert.deepEqual(keys, [
    'accessibility', 'area:area-cezar', 'area:area-ci', 'area:area-web', 'duplicate', 'main_area', 'type',
  ]);
  assert.deepEqual(Object.keys(request.questions.main_area.criteria), ['area-cezar', 'area-web', 'area-ci', 'none']);
  assert.deepEqual(Object.keys(request.questions.type.criteria), ['bug', 'enhancement', 'documentation', 'none']);
  const asked = JSON.stringify(request.questions);
  for (const name of NEVER_ASKED) assert.doesNotMatch(asked, new RegExp(`"${name}"`), name);
  assert.doesNotMatch(asked, /"duplicate description"|"question"/);
});

test('a long candidate list drops excerpts to stay inside the context budget', () => {
  const many = Array.from({ length: 254 }, (_, i) => ({ number: i + 1, title: `Issue title number ${i + 1} `.repeat(4), body: 'y'.repeat(2000), labels: [] }));
  const big = buildRequest({ issue: { ...issue, body: 'z'.repeat(50_000) }, candidates: many, labels });
  assert.equal(Object.keys(big.questions.duplicate.criteria).length, 255);
  assert.ok(big.state.body.length <= 12_001);
  assert.ok(JSON.stringify(big.state).length + JSON.stringify(big.questions.duplicate.criteria).length <= 28_000 * 3);
});

test('a duplicate closes only at or above its threshold, with a templated comment', () => {
  const at = mapAnswers({ request, response: response({ duplicate: choice('#14', THRESHOLDS.duplicate) }) });
  assert.deepEqual(at, { action: 'duplicate', duplicate_of: 14, comment: `Duplicate of #14 (Jev probability ${THRESHOLDS.duplicate.toFixed(2)}).`, labels: [] });
  validateIntake(at);

  const below = mapAnswers({ request, response: response({ duplicate: choice('#14', THRESHOLDS.duplicate - 0.01) }) });
  assert.equal(below.action, 'label');
  assert.equal(below.duplicate_of, null);
});

test('one main area, one type, and secondary areas only above their own threshold', () => {
  assert.deepEqual(mapAnswers({ request, response: response() }).labels, ['area-web', 'bug']);

  const secondary = mapAnswers({ request, response: response({
    'area:area-ci': noul(THRESHOLDS.secondaryArea),
    'area:area-cezar': noul(THRESHOLDS.secondaryArea - 0.01),
  }) });
  assert.deepEqual(secondary.labels, ['area-web', 'area-ci', 'bug']);
  assert.equal(secondary.labels.filter((label) => ['bug', 'enhancement', 'documentation'].includes(label)).length, 1);
});

test('main area and type apply at their threshold and not below it', () => {
  const at = mapAnswers({ request, response: response({ main_area: choice('area-cezar', THRESHOLDS.mainArea), type: choice('enhancement', THRESHOLDS.type), 'area:area-web': noul(0) }) });
  assert.deepEqual(at.labels, ['area-cezar', 'enhancement']);

  const below = mapAnswers({ request, response: response({ main_area: choice('area-cezar', THRESHOLDS.mainArea - 0.01), type: choice('enhancement', THRESHOLDS.type - 0.01), 'area:area-web': noul(0) }) });
  assert.deepEqual(below, { action: 'skip', duplicate_of: null, comment: null, labels: [] });
});

test('none answers and accessibility map as asked', () => {
  const result = mapAnswers({ request, response: response({ main_area: choice('none', 0.99), type: choice('none', 0.99), accessibility: noul(THRESHOLDS.accessibility) }) });
  assert.deepEqual(result.labels, ['area-web', 'accessibility']);
  const quiet = mapAnswers({ request, response: response({ accessibility: noul(THRESHOLDS.accessibility - 0.01) }) });
  assert.ok(!quiet.labels.includes('accessibility'));
});

test('a malformed answer fails instead of guessing', () => {
  assert.throws(() => mapAnswers({ request, response: {} }), /no answers/);
  assert.throws(() => mapAnswers({ request, response: response({ duplicate: choice('#211', 0.99) }) }), /not offered/);
  assert.throws(() => mapAnswers({ request, response: response({ type: noul(0.5) }) }), /not a choice/);
  assert.throws(() => mapAnswers({ request, response: response({ accessibility: noul(1.5) }) }), /not a probability/);
  assert.throws(() => mapAnswers({ request, response: response({ 'area:area-ci': undefined }) }), /missing/);
});

function reply(status, body = {}, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test('callJev posts the request with the key and retries rate limits and overload', async () => {
  const calls = [];
  const sleeps = [];
  const replies = [reply(429, {}, { 'retry-after': '2' }), reply(529), reply(200, { answers: {} })];
  const result = await callJev({
    request,
    apiKey: 'test-key',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return replies.shift(); },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.deepEqual(result, { answers: {} });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(calls[0].init.body), request);
  assert.deepEqual(sleeps, [2000, 2000]);
});

test('callJev fails closed on a client error, on exhausted retries and without a key', async () => {
  await assert.rejects(callJev({ request, apiKey: 'k', fetchImpl: async () => reply(422, { detail: 'bad question' }), sleep: async () => {} }), /HTTP 422: .*bad question/);
  await assert.rejects(callJev({ request, apiKey: 'k', fetchImpl: async () => reply(529), sleep: async () => {}, maxAttempts: 2 }), /HTTP 529/);
  await assert.rejects(callJev({ request, apiKey: 'k', fetchImpl: async () => { throw new Error('socket hang up'); }, sleep: async () => {}, maxAttempts: 2 }), /after 2 attempts: socket hang up/);
  await assert.rejects(callJev({ request, apiKey: '', fetchImpl: async () => reply(200) }), /TYPESAFE_API_KEY/);
});
