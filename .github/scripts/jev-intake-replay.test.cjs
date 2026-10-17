const test = require('node:test');
const assert = require('node:assert/strict');
const { openAt, scoreLabels, askableSet } = require('./jev-intake-replay.cjs');

test('openAt keeps issues created earlier and still open at the target creation time', () => {
  const issues = [
    { number: 1, created_at: '2026-10-01T00:00:00Z', closed_at: null },
    { number: 2, created_at: '2026-10-01T00:00:00Z', closed_at: '2026-10-02T00:00:00Z' },
    { number: 3, created_at: '2026-10-01T00:00:00Z', closed_at: '2026-10-04T00:00:00Z' },
    { number: 4, created_at: '2026-10-03T00:00:00Z', closed_at: null },
    { number: 5, created_at: '2026-10-04T00:00:00Z', closed_at: null },
  ];
  assert.deepEqual(openAt(issues, issues[3]).map((issue) => issue.number), [1, 3]);
});

test('scoreLabels counts only the asked labels, per label and overall', () => {
  const score = scoreLabels(
    [['area-web', 'bug'], ['area-cezar'], [], ['friction']],
    [['area-web', 'bug', 'friction'], ['area-web'], ['bug'], []],
    ['area-web', 'area-cezar', 'bug'],
  );
  assert.deepEqual(score.perLabel['area-web'], { tp: 1, fp: 0, fn: 1 });
  assert.deepEqual(score.perLabel['area-cezar'], { tp: 0, fp: 1, fn: 0 });
  assert.deepEqual(score.perLabel.bug, { tp: 1, fp: 0, fn: 1 });
  assert.equal(score.precision, 2 / 3);
  assert.equal(score.recall, 2 / 4);
  assert.equal(score.exact, 2, 'issues 1 and 4 match once unasked labels are ignored');
});

test('askableSet is the areas, the three types and accessibility', () => {
  const labels = ['area-web', 'area-ci', 'bug', 'enhancement', 'documentation', 'accessibility', 'friction', 'epic', 'question']
    .map((name) => ({ name, description: '' }));
  assert.deepEqual([...askableSet(labels)].sort(), ['accessibility', 'area-ci', 'area-web', 'bug', 'documentation', 'enhancement']);
});
