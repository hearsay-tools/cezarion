const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRequest, buildRecheckRequest, shortlist, triage, callJev, mapAnswers, excerptOf,
  THRESHOLDS, TYPE_CRITERIA, NEVER_ASKED, ENDPOINT,
} = require('./jev-issue-intake.cjs');
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
  assert.deepEqual(keys, ['accessibility', 'duplicate', 'main_area', 'type']);
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

function recheckFor(numbers, overrides = {}) {
  const recheckRequest = buildRecheckRequest({ issue, candidates, numbers });
  const answers = { duplicate: choice('none', 0.9) };
  for (const number of numbers) answers[`same_work:#${number}`] = noul(0.1);
  return { request: recheckRequest, response: { model: 'jev-1.13.0', answers: { ...answers, ...overrides } } };
}

test('the recheck re-reads the shortlisted candidates in full and can reject them all', () => {
  const recheck = buildRecheckRequest({ issue, candidates, numbers: [14, 15] });
  assert.deepEqual(Object.keys(recheck.questions).sort(), ['duplicate', 'same_work:#14', 'same_work:#15']);
  assert.deepEqual(Object.keys(recheck.questions.duplicate.criteria), ['#14', '#15', 'none']);
  assert.equal(recheck.questions.duplicate.criteria['#14'].body, candidates[0].body, 'full body, not an excerpt');
  assert.match(recheck.questions.duplicate.instructions, /follows up on, builds on, or was split out of/);
  assert.deepEqual(recheck.questions['same_work:#14'].instructions.open_issue, { title: candidates[0].title, body: candidates[0].body });
  assert.throws(() => buildRecheckRequest({ issue, candidates, numbers: [211] }), /not a duplicate candidate/);
});

test('the shortlist is the top three candidates once the best reaches its threshold', () => {
  const ranked = { answers: { duplicate: { type: 'choice', choice: 'none', probabilities: { none: 0.5, '#14': 0.3, '#15': 0.1, '#16': 0.06, '#17': 0.04 } } } };
  assert.deepEqual(shortlist({ response: ranked }), [14, 15, 16]);
  const low = { answers: { duplicate: { type: 'choice', choice: 'none', probabilities: { none: 0.9, '#14': THRESHOLDS.shortlist - 0.01 } } } };
  assert.deepEqual(shortlist({ response: low }), []);
  const at = { answers: { duplicate: { type: 'choice', choice: '#14', probabilities: { none: 0.1, '#14': THRESHOLDS.shortlist } } } };
  assert.deepEqual(shortlist({ response: at }), [14]);
});

test('a duplicate closes only when the recheck pick and its same-work answer both reach their thresholds', () => {
  const close = recheckFor([14, 15], { duplicate: choice('#14', THRESHOLDS.duplicate), 'same_work:#14': noul(THRESHOLDS.sameWork) });
  const at = mapAnswers({ request, response: response(), recheck: close });
  assert.deepEqual(at, {
    action: 'duplicate',
    duplicate_of: 14,
    comment: `Duplicate of #14 (Jev probability ${THRESHOLDS.duplicate.toFixed(2)}, same work ${THRESHOLDS.sameWork.toFixed(2)}).`,
    labels: [],
  });
  validateIntake(at);

  const weakPick = recheckFor([14], { duplicate: choice('#14', THRESHOLDS.duplicate - 0.01), 'same_work:#14': noul(0.99) });
  assert.equal(mapAnswers({ request, response: response(), recheck: weakPick }).action, 'label');
  const notSameWork = recheckFor([14], { duplicate: choice('#14', 0.99), 'same_work:#14': noul(THRESHOLDS.sameWork - 0.01) });
  assert.equal(mapAnswers({ request, response: response(), recheck: notSameWork }).action, 'label');
  const rejected = recheckFor([14], { duplicate: choice('none', 0.99), 'same_work:#14': noul(0.99) });
  assert.equal(mapAnswers({ request, response: response(), recheck: rejected }).action, 'label');
});

test('the first call alone never closes a duplicate, however sure it is', () => {
  const result = mapAnswers({ request, response: response({ duplicate: choice('#14', 1) }) });
  assert.equal(result.action, 'label');
  assert.equal(result.duplicate_of, null);
});

test('excerpts drop template headings and HTML comments', () => {
  assert.equal(excerptOf('## Context / Why\n\nUnder load, git collides.\n<!-- note -->\n### What\nFix it.', 300), 'Under load, git collides. Fix it.');
  assert.equal(excerptOf('a'.repeat(400), 300).length, 301);
  assert.equal(request.questions.duplicate.criteria['#14'].excerpt.startsWith('xxx'), true);
});

test('type options carry code-owned descriptions, none included', () => {
  assert.deepEqual(request.questions.type.criteria, {
    bug: TYPE_CRITERIA.bug,
    enhancement: TYPE_CRITERIA.enhancement,
    documentation: TYPE_CRITERIA.documentation,
    none: TYPE_CRITERIA.none,
  });
  assert.match(TYPE_CRITERIA.bug, /flaky test/);
  assert.match(TYPE_CRITERIA.none, /refactoring/);
});

test('an issue gets at most one area and one type', () => {
  const result = mapAnswers({ request, response: response() });
  assert.deepEqual(result.labels, ['area-web', 'bug']);
  assert.equal(result.labels.filter((label) => label.startsWith('area-')).length, 1);
  assert.equal(result.labels.filter((label) => ['bug', 'enhancement', 'documentation'].includes(label)).length, 1);
});

test('main area and type apply at their threshold and not below it', () => {
  const at = mapAnswers({ request, response: response({ main_area: choice('area-cezar', THRESHOLDS.mainArea), type: choice('enhancement', THRESHOLDS.type) }) });
  assert.deepEqual(at.labels, ['area-cezar', 'enhancement']);

  const below = mapAnswers({ request, response: response({ main_area: choice('area-cezar', THRESHOLDS.mainArea - 0.01), type: choice('enhancement', THRESHOLDS.type - 0.01) }) });
  assert.deepEqual(below, { action: 'skip', duplicate_of: null, comment: null, labels: [] });
});

test('none answers and accessibility map as asked', () => {
  const result = mapAnswers({ request, response: response({ main_area: choice('none', 0.99), type: choice('none', 0.99), accessibility: noul(THRESHOLDS.accessibility) }) });
  assert.deepEqual(result.labels, ['accessibility']);
  const quiet = mapAnswers({ request, response: response({ accessibility: noul(THRESHOLDS.accessibility - 0.01) }) });
  assert.ok(!quiet.labels.includes('accessibility'));
});

test('a malformed answer fails instead of guessing', () => {
  assert.throws(() => mapAnswers({ request, response: {} }), /no answers/);
  assert.throws(() => mapAnswers({ request, response: response({ duplicate: choice('#211', 0.99) }) }), /not offered/);
  assert.throws(() => mapAnswers({ request, response: response(), recheck: recheckFor([14], { duplicate: choice('#15', 0.99) }) }), /not offered/);
  assert.throws(() => mapAnswers({ request, response: response(), recheck: recheckFor([14], { duplicate: choice('#14', 0.99), 'same_work:#14': undefined }) }), /missing/);
  assert.throws(() => mapAnswers({ request, response: response({ type: noul(0.5) }) }), /not a choice/);
  assert.throws(() => mapAnswers({ request, response: response({ accessibility: noul(1.5) }) }), /not a probability/);
  assert.throws(() => mapAnswers({ request, response: response({ main_area: undefined }) }), /missing/);
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

test('triage makes one call when no candidate ranks high, and a recheck call when one does', async () => {
  const replies = (bodies) => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push(JSON.parse(init.body)); return reply(200, bodies.shift()); };
    return { calls, fetchImpl };
  };
  const quiet = replies([response()]);
  const one = await triage({ issue, candidates, labels, apiKey: 'k', fetchImpl: quiet.fetchImpl, sleep: async () => {} });
  assert.equal(quiet.calls.length, 1);
  assert.deepEqual(one.intake.labels, ['area-web', 'bug']);
  assert.match(one.log, /recheck: skipped/);

  const ranked = response({ duplicate: { type: 'choice', choice: '#14', probabilities: { '#14': 0.7, '#15': 0.2, none: 0.1 }, confidence: 0.6 } });
  const sure = { model: 'jev-1.13.0', answers: { duplicate: choice('#14', 0.97), 'same_work:#14': noul(0.95), 'same_work:#15': noul(0.1) } };
  const loud = replies([ranked, sure]);
  const two = await triage({ issue, candidates, labels, apiKey: 'k', fetchImpl: loud.fetchImpl, sleep: async () => {} });
  assert.equal(loud.calls.length, 2);
  assert.deepEqual(Object.keys(loud.calls[1].questions.duplicate.criteria), ['#14', '#15', 'none']);
  assert.equal(two.intake.action, 'duplicate');
  assert.equal(two.intake.duplicate_of, 14);
  assert.match(two.log, /recheck same_work:#14: 0\.95/);
});
