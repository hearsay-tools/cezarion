const test = require('node:test');
const assert = require('node:assert/strict');
const { applyClassification } = require('./apply-friction-intake.cjs');

function harness(overrides = {}) {
  const issue = { number: 12, title: 'Show events', body: 'Print evidence.', state: 'open', labels: [{ name: 'friction' }, { name: 'area-cezar' }], ...overrides };
  const input = { issue: { number: 12, title: 'Show events', body: 'Print evidence.' }, classification: { category: 'diagnostics', handling: 'automatic', probabilities: { category: 0.95, established: 0.95, policy_change: 0.01, authority_change: 0.01, verification_change: 0.01, runtime_change: 0.01 } } };
  const mutations = [];
  const github = { rest: { issues: {
    get: async () => ({ data: structuredClone(issue) }),
    getLabel: async () => ({}),
    createLabel: async x => { mutations.push(['create', x.name]); },
    removeLabel: async x => { mutations.push(['remove', x.name]); issue.labels = issue.labels.filter(l => l.name !== x.name); },
    addLabels: async x => { mutations.push(['add', x.labels]); for (const name of x.labels) if (!issue.labels.some(l => l.name === name)) issue.labels.push({ name }); },
  } } };
  const run = (data = input) => applyClassification({ github, repo: { owner: 'hearsay-tools', repo: 'cezarion' }, issueNumber: 12, input: data });
  return { issue, input, mutations, github, run };
}

test('adds one category and handling pair without replacing unrelated labels', async () => {
  const h = harness();
  await h.run();
  assert.deepEqual(h.issue.labels.map(l => l.name), ['friction', 'area-cezar', 'friction-diagnostics', 'friction-auto']);
  assert.deepEqual(h.mutations, [['add', ['friction-diagnostics', 'friction-auto']]]);
});

test('reclassification removes old routes before adding the new pair and is idempotent', async () => {
  const h = harness({ labels: [{ name: 'friction' }, { name: 'friction-lifecycle' }, { name: 'friction-design' }, { name: 'priority-high' }] });
  await h.run();
  assert.deepEqual(h.mutations, [['remove', 'friction-lifecycle'], ['remove', 'friction-design'], ['add', ['friction-diagnostics', 'friction-auto']]]);
  h.mutations.length = 0;
  await h.run();
  assert.deepEqual(h.mutations, []);
  assert.ok(h.issue.labels.some(l => l.name === 'priority-high'));
});

test('rejects stale snapshots and an artifact for another issue before any writes', async () => {
  for (const overrides of [{ title: 'Updated' }, { body: 'New acceptance criteria' }]) {
    const h = harness(overrides);
    assert.equal((await h.run()).status, 'stale');
    assert.deepEqual(h.mutations, []);
  }
  const h = harness();
  h.input.issue.number = 99;
  await assert.rejects(h.run(), /issue/i);
  assert.deepEqual(h.mutations, []);
});

test('a closed or no-longer-friction issue loses only managed labels', async () => {
  for (const state of ['closed', 'open']) {
    const h = harness({ state, labels: [{ name: 'area-docs' }, { name: 'friction-auto' }, { name: 'friction-knowledge' }] });
    await h.run();
    assert.deepEqual(h.issue.labels, [{ name: 'area-docs' }]);
    assert.ok(h.mutations.every(m => m[0] === 'remove'));
  }
});

test('invalid or unsafe artifact routes never label an issue for automatic implementation', async () => {
  for (const change of [{ category: 'lifecycle' }, { category: 'diagnostics', handling: 'execute' }, { probabilities: { category: 0.1, established: 0.1 } }]) {
    const h = harness();
    Object.assign(h.input.classification, change);
    await assert.rejects(h.run());
    assert.deepEqual(h.mutations, []);
  }
});

test('creates a missing managed label but propagates authentication errors', async () => {
  const h = harness();
  h.github.rest.issues.getLabel = async () => { throw Object.assign(new Error('missing'), { status: 404 }); };
  await h.run();
  assert.equal(h.mutations.filter(m => m[0] === 'create').length, 2);
  const denied = harness();
  denied.github.rest.issues.getLabel = async () => { throw Object.assign(new Error('denied'), { status: 403 }); };
  await assert.rejects(denied.run(), /denied/);
  assert.deepEqual(denied.mutations, []);
});

test('rechecks eligibility and snapshot after remote label setup before mutations', async () => {
  for (const change of [issue => { issue.body = 'Different remedy'; }, issue => { issue.state = 'closed'; }, issue => { issue.labels = [{ name: 'area-cezar' }]; }]) {
    const h = harness();
    h.github.rest.issues.getLabel = async () => { change(h.issue); };
    assert.equal((await h.run()).status, 'stale');
    assert.deepEqual(h.mutations, []);
  }
});

test('no-match classification applies the design fallback labels', async () => {
  const h = harness();
  h.input.classification.category = 'unclassified';
  h.input.classification.handling = 'design';
  await h.run();
  assert.deepEqual(h.mutations, [['add', ['friction-unclassified', 'friction-design']]]);
});

test('a failed classification clears prior execution labels without inventing judgments', async () => {
  const h = harness({ labels: [{ name: 'friction' }, { name: 'friction-auto' }, { name: 'friction-diagnostics' }, { name: 'bug' }] });
  h.input.classification = null;
  assert.equal((await h.run()).status, 'cleared');
  assert.deepEqual(h.issue.labels.map(l => l.name), ['friction', 'bug']);
});
