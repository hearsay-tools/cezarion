const test = require('node:test');
const assert = require('node:assert/strict');
const { loadIntake, planIntakeMutations } = require('./apply-issue-intake.cjs');

const issueNumber = 211;
const knownLabels = new Set(['bug', 'enhancement', 'repo-setup', 'duplicate']);

test('plans a scoped duplicate close plus duplicate label', () => {
  const intake = loadIntake(JSON.stringify({
    action: 'duplicate',
    duplicate_of: 14,
    comment: 'Same work as #14.',
    labels: [],
  }));
  assert.deepEqual(planIntakeMutations({ intake, issueNumber, knownLabels }), [
    ['issue', 'close', '211', '--reason', 'duplicate', '--duplicate-of', '14', '--comment', 'Same work as #14.'],
    ['issue', 'edit', '211', '--add-label', 'duplicate'],
  ]);
});

test('closes a duplicate without adding a missing duplicate label', () => {
  const intake = loadIntake({
    action: 'duplicate',
    duplicate_of: 14,
    comment: 'Same work as #14.',
    labels: [],
  });
  assert.deepEqual(planIntakeMutations({ intake, issueNumber, knownLabels: new Set(['bug']) }), [
    ['issue', 'close', '211', '--reason', 'duplicate', '--duplicate-of', '14', '--comment', 'Same work as #14.'],
  ]);
});

test('plans label edits only from the known set and skips when none remain', () => {
  const labeled = loadIntake({
    action: 'label',
    duplicate_of: null,
    comment: null,
    labels: ['bug', 'invented', 'enhancement'],
  });
  assert.deepEqual(planIntakeMutations({ intake: labeled, issueNumber, knownLabels }), [
    ['issue', 'edit', '211', '--add-label', 'bug,enhancement'],
  ]);

  const unknown = loadIntake({
    action: 'label',
    duplicate_of: null,
    comment: null,
    labels: ['invented'],
  });
  assert.deepEqual(planIntakeMutations({ intake: unknown, issueNumber, knownLabels }), []);
});

test('skip produces no mutations', () => {
  const intake = loadIntake({
    action: 'skip',
    duplicate_of: null,
    comment: null,
    labels: ['bug'],
  });
  assert.deepEqual(planIntakeMutations({ intake, issueNumber, knownLabels }), []);
});

test('rejects malformed intake and refuses to act on another issue', () => {
  assert.throws(() => loadIntake('not-json'), /Invalid intake JSON/);
  assert.throws(() => loadIntake({ action: 'duplicate', duplicate_of: 14, comment: 'x' }), /labels/);
  assert.throws(() => planIntakeMutations({
    intake: loadIntake({ action: 'duplicate', duplicate_of: 211, comment: 'self', labels: [] }),
    issueNumber,
    knownLabels,
  }), /itself/);
  assert.throws(() => planIntakeMutations({
    intake: loadIntake({ action: 'duplicate', duplicate_of: null, comment: 'x', labels: [] }),
    issueNumber,
    knownLabels,
  }), /duplicate_of/);
});

test('a duplicate outside the candidate set labels instead of closing, and says why', () => {
  const warnings = [];
  const warn = (message) => warnings.push(message);
  const intake = loadIntake({ action: 'duplicate', duplicate_of: 211, comment: 'self', labels: ['bug'] });
  assert.deepEqual(planIntakeMutations({ intake, issueNumber, knownLabels, candidateNumbers: new Set([14]), warn }), [
    ['issue', 'edit', '211', '--add-label', 'bug'],
  ]);
  assert.match(warnings[0], /#211 is not a duplicate candidate/);

  const parent = loadIntake({ action: 'duplicate', duplicate_of: 13, comment: 'Same as #13.', labels: [] });
  assert.deepEqual(planIntakeMutations({ intake: parent, issueNumber, knownLabels, candidateNumbers: new Set([14]), warn }), []);
  assert.equal(warnings.length, 2);
});

test('a duplicate inside the candidate set still closes', () => {
  const intake = loadIntake({ action: 'duplicate', duplicate_of: 14, comment: 'Same work as #14.', labels: [] });
  assert.deepEqual(planIntakeMutations({ intake, issueNumber, knownLabels, candidateNumbers: new Set([14]) }), [
    ['issue', 'close', '211', '--reason', 'duplicate', '--duplicate-of', '14', '--comment', 'Same work as #14.'],
    ['issue', 'edit', '211', '--add-label', 'duplicate'],
  ]);
  assert.throws(() => planIntakeMutations({ intake, issueNumber, knownLabels, candidateNumbers: [14] }), /candidateNumbers/);
});

test('ordinary intake cannot assign friction routing labels even when they exist', () => {
  const labels = ['friction', 'friction-auto', 'friction-design', 'friction-guarded', 'friction-diagnostics', 'friction-unclassified', 'bug'];
  const intake = loadIntake({ action: 'label', duplicate_of: null, comment: null, labels });
  assert.deepEqual(planIntakeMutations({ intake, issueNumber, knownLabels: new Set(labels) }), [
    ['issue', 'edit', '211', '--add-label', 'bug'],
  ]);
});
