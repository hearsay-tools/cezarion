const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCandidates, splitParents, MAX_CANDIDATES } = require('./issue-intake-candidates.cjs');

const repo = 'hearsay-tools/cezarion';

function issue(number, extra = {}) {
  return { number, title: `Issue ${number}`, body: '', labels: [], updated_at: '2026-10-01T00:00:00Z', ...extra };
}

test('the new issue is never a candidate', () => {
  const candidates = buildCandidates({
    issue: issue(211),
    openIssues: [issue(14), issue(211), issue(15)],
    repo,
  });
  assert.deepEqual(candidates.map((c) => c.number), [14, 15]);
});

test('every split-out spelling keeps its parent out of the candidates', () => {
  for (const body of [
    'Split out of #14.',
    'split out of hearsay-tools/cezarion#14',
    'Split from #14',
    'Carved out of https://github.com/hearsay-tools/cezarion/issues/14',
    'This was carved from #14: the cursor half.',
    'Split out of [#14](https://github.com/hearsay-tools/cezarion/issues/14)',
    'Split out of Hearsay-Tools/Cezarion#14',
  ]) {
    const candidates = buildCandidates({ issue: issue(211, { body }), openIssues: [issue(14), issue(15)], repo });
    assert.deepEqual(candidates.map((c) => c.number), [15], body);
  }
});

test('a split-out reference to another repository keeps the same-numbered issue here', () => {
  for (const body of [
    'Split out of open-mercato/cezar#14',
    'Split out of https://github.com/open-mercato/cezar/issues/14',
  ]) {
    assert.deepEqual([...splitParents(body, repo)], [], body);
  }
});

test('a plain mention or a follow-up is not a split-out parent', () => {
  assert.deepEqual([...splitParents('Related to #14. Follow-up to #15. See #16.', repo)], []);
  assert.deepEqual([...splitParents(null, repo)], []);
});

test('the title counts as well as the body, and several parents are all excluded', () => {
  const parents = splitParents('Split out of #14 and split from #15', repo, 'Split out of #16');
  assert.deepEqual([...parents].sort((a, b) => a - b), [14, 15, 16]);
});

test('pull requests are never candidates and labels reduce to names', () => {
  const candidates = buildCandidates({
    issue: issue(211),
    openIssues: [issue(14, { labels: [{ name: 'bug' }, 'area-web'] }), issue(15, { pull_request: { url: 'x' } })],
    repo,
  });
  assert.deepEqual(candidates, [
    { number: 14, title: 'Issue 14', body: '', labels: ['bug', 'area-web'], updated_at: '2026-10-01T00:00:00Z' },
  ]);
});

test('past the cap the most recently updated candidates stay, in their original order', () => {
  const openIssues = [
    issue(1, { updated_at: '2026-10-03T00:00:00Z' }),
    issue(2, { updated_at: '2026-10-01T00:00:00Z' }),
    issue(3, { updated_at: '2026-10-04T00:00:00Z' }),
    issue(4, { updated_at: '2026-10-02T00:00:00Z' }),
  ];
  const candidates = buildCandidates({ issue: issue(211), openIssues, repo, max: 2 });
  assert.deepEqual(candidates.map((c) => c.number), [1, 3]);
  assert.equal(MAX_CANDIDATES, 254, 'a Jev Choice takes 255 options and one is "none"');
});

test('malformed input is rejected', () => {
  assert.throws(() => buildCandidates({ issue: { number: 0 }, openIssues: [], repo }), /issue number/);
  assert.throws(() => buildCandidates({ issue: issue(1), openIssues: {}, repo }), /openIssues/);
  assert.throws(() => buildCandidates({ issue: issue(1), openIssues: [], repo: 'nope' }), /repo/);
});
