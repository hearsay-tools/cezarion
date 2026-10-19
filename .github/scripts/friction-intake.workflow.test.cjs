const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');
const { classify } = require('./jev-friction-intake.cjs');
const workflow = () => yaml.parse(fs.readFileSync(path.join(__dirname, '../workflows/friction-intake.yml'), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

test('manual classification rejects branch and tag refs outside the current default branch', () => {
  // Evaluate this workflow's Boolean expression with GitHub's label projection
  // and the two expression functions it uses, without calling Jev or GitHub.
  const condition = workflow().jobs.classify.if.replace('github.event.issue.labels.*.name', 'github.event.issue.labels.map(label => label.name)');
  const admits = github => new Function('github', 'contains', 'format', `return Boolean(${condition});`)(
    github,
    (values, value) => values.includes(value),
    (template, value) => template.replace('{0}', value),
  );
  for (const defaultBranch of ['main', 'development']) {
    for (const [ref, expected] of [
      [`refs/heads/${defaultBranch}`, true],
      ['refs/heads/classifier-preview', false],
      [`refs/tags/${defaultBranch}`, false],
    ]) {
      assert.equal(admits({
        event_name: 'workflow_dispatch', ref,
        event: { repository: { default_branch: defaultBranch } },
      }), expected, `${defaultBranch}: ${ref}`);
    }
    assert.equal(admits({
      event_name: 'issues', ref: `refs/heads/${defaultBranch}`,
      event: { action: 'edited', repository: { default_branch: defaultBranch }, issue: { labels: [{ name: 'friction' }] } },
    }), true, 'ordinary friction issue events still classify');
  }
});

test('classification has read permissions and only its job receives the Jev credential', () => {
  const w = workflow();
  assert.deepEqual(w.permissions, {});
  assert.deepEqual(w.jobs.classify.permissions, { contents: 'read', issues: 'read' });
  assert.deepEqual(w.jobs.apply.permissions, { contents: 'read', issues: 'write' });
  assert.equal(w.concurrency['cancel-in-progress'], false);
  assert.equal(w.concurrency.queue, 'max');
  assert.ok(w.on.issues.types.includes('edited'));
  assert.ok(w.on.issues.types.includes('labeled'));
  assert.ok(w.on.issues.types.includes('unlabeled'));
  assert.ok(w.on.workflow_dispatch.inputs.issue_number.required);
  for (const job of Object.values(w.jobs)) {
    const checkout = job.steps.find(s => s.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with['persist-credentials'], false);
    assert.match(checkout.uses, /@[a-f0-9]{40}$/);
  }
  const classifier = w.jobs.classify.steps.find(s => s.uses?.startsWith('actions/github-script@'));
  assert.equal(classifier.env.TYPESAFE_API_KEY, '${{ secrets.TYPESAFE_API_KEY }}');
  assert.doesNotMatch(JSON.stringify(w.jobs.apply), /TYPESAFE_API_KEY/);
  assert.ok(w.jobs.classify.if.includes("github.event.label.name == 'friction'"), 'managed category labels must not trigger another paid call');
});

test('the real workflow entrypoints turn a Jev classification into only the expected issue labels', async () => {
  const w = workflow();
  const current = { number: 12, title: 'Missing evidence', body: 'Print events.', state: 'open', labels: [{ name: 'friction' }, { name: 'area-cezar' }] };
  let artifact;
  const github = { rest: { issues: {
    get: async () => ({ data: structuredClone(current) }), getLabel: async () => ({}),
    addLabels: async ({ labels }) => { current.labels.push(...labels.map(name => ({ name }))); },
    removeLabel: async ({ name }) => { current.labels = current.labels.filter(l => l.name !== name); },
  } } };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ answers: {
    category: { type: 'choice', choice: 'diagnostics', probabilities: { diagnostics: 0.99 } },
    established: { type: 'noul', noul: 0.99 },
    policy_change: { type: 'noul', noul: 0.01 },
    authority_change: { type: 'noul', noul: 0.01 },
    verification_change: { type: 'noul', noul: 0.01 },
    runtime_change: { type: 'noul', noul: 0.01 },
  } }) });
  const core = { info() {}, summary: { addRaw() { return this; }, async write() {} } };
  const context = { repo: { owner: 'hearsay-tools', repo: 'cezarion' }, eventName: 'issues', payload: { issue: structuredClone(current) } };
  const fakeProcess = { env: { ISSUE_NUMBER: '12', TYPESAFE_API_KEY: 'test-only', FRICTION_OUTPUT: '/output/friction.json' } };
  const resolve = name => {
    if (name === 'node:fs') return { mkdirSync() {}, writeFileSync(_p, value) { artifact = value; }, readFileSync() { return artifact; } };
    if (name === 'node:path') return path;
    if (name.endsWith('/jev-friction-intake.cjs')) return { classify: opts => classify({ ...opts, fetchImpl }) };
    return require(path.resolve(__dirname, '../..', name));
  };
  for (const job of [w.jobs.classify, w.jobs.apply]) {
    const script = job.steps.find(s => s.uses?.startsWith('actions/github-script@')).with.script;
    await new AsyncFunction('require', 'github', 'context', 'core', 'process', script)(resolve, github, context, core, fakeProcess);
  }
  assert.deepEqual(current.labels.map(l => l.name), ['friction', 'area-cezar', 'friction-diagnostics', 'friction-auto']);
  assert.doesNotMatch(artifact, /test-only/);
});

test('Jev failure produces an unavailable artifact so apply can revoke a previous route', async () => {
  const w = workflow();
  const step = w.jobs.classify.steps.find(s => s.uses?.startsWith('actions/github-script@'));
  let artifact;
  const resolve = name => {
    if (name === 'node:fs') return { mkdirSync() {}, writeFileSync(_p, value) { artifact = JSON.parse(value); } };
    if (name === 'node:path') return path;
    if (name.endsWith('/jev-friction-intake.cjs')) return { classify: async () => { throw new Error('Service unavailable'); } };
    return require(path.resolve(__dirname, '../..', name));
  };
  const github = { rest: { issues: { get: async () => ({ data: { number: 12, title: 'Report', body: '', state: 'open', labels: [{ name: 'friction' }] } }) } } };
  const core = { warning() {}, summary: { addRaw() {}, async write() {} } };
  const process = { env: { ISSUE_NUMBER: '12', FRICTION_OUTPUT: '/output/friction.json' } };
  await new AsyncFunction('require', 'github', 'context', 'core', 'process', step.with.script)(resolve, github, { repo: {} }, core, process);
  assert.equal(artifact.classification, null);
  assert.equal(artifact.issue.number, 12);
});

test('superseded issue events spend no Jev call and leave no classification to apply', async () => {
  const w = workflow();
  const step = w.jobs.classify.steps.find(s => s.uses?.startsWith('actions/github-script@'));
  const evaluate = (expression, variables) => new Function(...Object.keys(variables),
    `return (${expression.replace(/^\$\{\{([\s\S]*)\}\}$/, '$1')});`)(...Object.values(variables));
  const current = { number: 12, title: 'Current title', body: 'Current body', state: 'open', labels: [{ name: 'friction' }] };
  for (const { eventName = 'issues', snapshot = current, live = current, expectedCalls, expectedSkip = false } of [
    { snapshot: { ...current, title: 'Earlier title' }, expectedCalls: 0, expectedSkip: true },
    { snapshot: { ...current, body: 'Earlier body' }, expectedCalls: 0, expectedSkip: true },
    { snapshot: { ...current, state: 'closed' }, expectedCalls: 0, expectedSkip: true },
    { snapshot: { ...current, labels: [] }, expectedCalls: 0, expectedSkip: true },
    { expectedCalls: 1 },
    { eventName: 'workflow_dispatch', expectedCalls: 1 },
    { snapshot: { ...current, title: 'Earlier title' }, live: { ...current, state: 'closed' }, expectedCalls: 0 },
    { snapshot: { ...current, body: 'Earlier body' }, live: { ...current, labels: [] }, expectedCalls: 0 },
  ]) {
    let calls = 0;
    let artifact;
    const outputs = {};
    const resolve = name => {
      if (name === 'node:fs') return { mkdirSync() {}, writeFileSync(_p, value) { artifact = JSON.parse(value); } };
      if (name === 'node:path') return path;
      if (name.endsWith('/jev-friction-intake.cjs')) return { classify: async ({ issue }) => {
        assert.deepEqual(issue, live);
        calls++;
        return { category: 'diagnostics', handling: 'automatic' };
      } };
      return require(path.resolve(__dirname, '../..', name));
    };
    const github = { rest: { issues: { get: async () => ({ data: structuredClone(live) }) } } };
    const core = { info() {}, setOutput(name, value) { outputs[name] = value; }, summary: { addRaw() {}, async write() {} } };
    const process = { env: { ISSUE_NUMBER: '12', FRICTION_OUTPUT: '/output/friction.json' } };
    await new AsyncFunction('require', 'github', 'context', 'core', 'process', step.with.script)(
      resolve, github, { repo: {}, eventName, payload: { issue: snapshot } }, core, process,
    );
    assert.equal(calls, expectedCalls, `${eventName}: ${snapshot?.title}/${snapshot?.body}`);
    assert.equal(artifact === undefined, expectedSkip);
    assert.equal(outputs.superseded === 'true', expectedSkip);
    if (!expectedSkip && expectedCalls === 0) assert.equal(artifact.classification, null, 'closing and friction removal still revoke old routes');
    const steps = { [step.id]: { outputs } };
    const superseded = evaluate(w.jobs.classify.outputs?.superseded ?? 'undefined', { steps });
    assert.equal(evaluate(w.jobs.apply.if, {
      needs: { classify: { outputs: { superseded } } }, github: { event_name: eventName }, inputs: { dry_run: false },
    }), !expectedSkip, 'superseded work must not start a label-writing job');
    const upload = w.jobs.classify.steps.find(s => s.uses?.startsWith('actions/upload-artifact@'));
    assert.equal(evaluate(upload.if ?? 'true', { steps }), !expectedSkip, 'superseded work has no artifact to upload');
  }
});
