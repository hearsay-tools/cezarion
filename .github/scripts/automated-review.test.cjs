const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateReview,
  loadReview,
  changedLinesFromFiles,
  countAutomatedReviews,
  postReview,
} = require('./automated-review.cjs');

const sha = 'a'.repeat(40);

test('counts no automated reviews when review history is empty', () => {
  assert.equal(countAutomatedReviews([]), 0);
});

test('counts three automated reviews from review history', () => {
  assert.equal(countAutomatedReviews([
    { user: { login: 'github-actions[bot]' }, submitted_at: '2026-08-18T10:00:00Z' },
    { user: { login: 'github-actions[bot]' }, submitted_at: '2026-08-18T10:01:00Z' },
    { user: { login: 'github-actions[bot]' }, submitted_at: '2026-08-18T10:02:00Z' },
  ]), 3);
});

test('does not count pending automated reviews', () => {
  assert.equal(countAutomatedReviews([
    { user: { login: 'github-actions[bot]' }, submitted_at: null },
    { user: { login: 'github-actions[bot]' }, submitted_at: '2026-08-18T10:00:00Z' },
  ]), 1);
});

test('does not count human reviews', () => {
  assert.equal(countAutomatedReviews([
    { user: { login: 'octocat' } },
    { user: { login: 'github-actions[bot]' }, submitted_at: '2026-08-18T10:00:00Z' },
  ]), 1);
});

test('does not count malformed review entries', () => {
  assert.equal(countAutomatedReviews([
    null,
    {},
    { user: null },
    { user: {} },
    { user: { login: 'octocat' } },
  ]), 0);
  assert.equal(countAutomatedReviews(null), 0);
});

test('keeps unique findings on changed new-side lines', () => {
  const result = validateReview({
    review: { head_sha: sha, outcome: 'reviewed', summary: null, findings: [{ path: 'src/a.ts', line: 4, body: 'Handle the null value.', severity: null }] },
    headSha: sha,
    changedLines: new Map([['src/a.ts', new Set([4])]]),
    noFindingsSummary: 'No issues found',
  });
  assert.deepEqual(result, { comments: [{ path: 'src/a.ts', line: 4, body: 'Handle the null value.' }], body: null });
});

test('preserves a useful later-round summary when no current inline findings survive', () => {
  const result = validateReview({
    review: {
      head_sha: sha,
      outcome: 'reviewed',
      summary: 'The earlier finding at src/a.ts:4 was addressed by the null guard.',
      findings: [],
    },
    headSha: sha,
    changedLines: new Map(),
    noFindingsSummary: 'No issues found',
  });

  assert.deepEqual(result, {
    comments: [],
    body: 'The earlier finding at src/a.ts:4 was addressed by the null guard.',
  });
});

test('returns an empty no-op result for findings outside the patch', () => {
  assert.deepEqual(validateReview({
    review: { head_sha: sha, outcome: 'reviewed', summary: null, findings: [{ path: 'src/a.ts', line: 3, body: 'No.', severity: null }] },
    headSha: sha,
    changedLines: new Map(),
  }), { comments: [], body: null });
});

test('supplies the shared verdict when no findings survive validation', () => {
  assert.deepEqual(validateReview({
    review: { head_sha: sha, outcome: 'reviewed', summary: null, findings: [] },
    headSha: sha,
    changedLines: new Map(),
    noFindingsSummary: 'No issues found',
  }), { comments: [], body: 'No issues found' });
  assert.deepEqual(validateReview({
    review: { head_sha: sha, outcome: 'reviewed', summary: '  ', findings: [] },
    headSha: sha,
    changedLines: new Map(),
    noFindingsSummary: 'No issues found',
  }), { comments: [], body: 'No issues found' });
  assert.deepEqual(validateReview({
    review: { head_sha: sha, outcome: 'reviewed', summary: null, findings: [{ path: 'missing.ts', line: 1, body: 'Out of patch.', severity: null }] },
    headSha: sha,
    changedLines: new Map(),
    noFindingsSummary: 'No issues found',
  }), { comments: [], body: 'No issues found' });
  assert.deepEqual(validateReview({
    review: { head_sha: sha, outcome: 'reviewed', summary: null, findings: [{ path: 'missing.ts', line: 1, body: 'Out of patch.', severity: null }] },
    headSha: sha,
    changedLines: new Map(),
  }), { comments: [], body: null });
});

test('rejects stale, malformed, and unknown-key output', () => {
  for (const outcome of ['reviewed', 'skipped']) {
    assert.throws(() => validateReview({ review: { head_sha: null, outcome, summary: 'Review result.', findings: [] }, headSha: sha, changedLines: new Map() }), /requires head_sha/);
  }
  assert.throws(() => validateReview({ review: { head_sha: 'b'.repeat(40), outcome: 'reviewed', summary: null, findings: [] }, headSha: sha, changedLines: new Map() }), /stale PR head SHA/);
  assert.throws(() => validateReview({ review: { head_sha: sha, outcome: 'reviewed', summary: null, findings: 'no' }, headSha: sha, changedLines: new Map() }), /findings/);
  assert.throws(() => validateReview({ review: { head_sha: sha, outcome: 'reviewed', summary: null, findings: [], extra: true }, headSha: sha, changedLines: new Map() }), /unknown key/);
  assert.throws(() => validateReview({ review: { head_sha: sha, outcome: 'reviewed', summary: null, findings: [{ path: 'a', line: 0, body: 'x', severity: null }] }, headSha: sha, changedLines: new Map() }), /positive integer/);
  assert.throws(() => validateReview({ review: { head_sha: sha, outcome: 'reviewed', summary: null, findings: [{ path: 'a', line: 1, body: 'x', severity: 'urgent' }] }, headSha: sha, changedLines: new Map() }), /severity/);
  assert.throws(() => validateReview({ review: { head_sha: sha, summary: 'Review could not be completed.', findings: [] }, headSha: sha, changedLines: new Map() }), /outcome.*required/);
  assert.throws(() => validateReview({ review: { head_sha: sha, outcome: 'reviewed', findings: [] }, headSha: sha, changedLines: new Map() }), /summary.*required/);
  assert.throws(() => validateReview({ review: { head_sha: sha, outcome: 'reviewed', summary: null, findings: [{ path: 'a', line: 1, body: 'x' }] }, headSha: sha, changedLines: new Map() }), /severity.*required/);
});

test('fails closed when a provider could not complete the review', () => {
  for (const noFindingsSummary of [null, 'No issues found']) {
    assert.throws(() => validateReview({
      review: {
        head_sha: null,
        outcome: 'failed',
        summary: 'PR data was unavailable.',
        findings: [],
      },
      headSha: sha,
      changedLines: new Map(),
      noFindingsSummary,
    }), /Automated review failed: PR data was unavailable\./);
  }
  assert.throws(() => validateReview({
    review: { head_sha: null, outcome: 'failed', summary: null, findings: [] },
    headSha: sha,
    changedLines: new Map(),
  }), /must explain/);
  assert.throws(() => validateReview({
    review: {
      head_sha: null,
      outcome: 'failed',
      summary: 'Partial review only.',
      findings: [{ path: 'src/a.ts', line: 1, body: 'Untrusted partial finding.', severity: null }],
    },
    headSha: sha,
    changedLines: new Map([['src/a.ts', new Set([1])]]),
  }), /cannot include findings/);
});

test('accepts an intentional skip without publishing a no-findings verdict', () => {
  assert.deepEqual(validateReview({
    review: {
      head_sha: sha,
      outcome: 'skipped',
      summary: 'This commit was already reviewed.',
      findings: [],
    },
    headSha: sha,
    changedLines: new Map(),
    noFindingsSummary: 'No issues found',
  }), { comments: [], body: null });
  assert.throws(() => validateReview({
    review: { head_sha: sha, outcome: 'skipped', summary: null, findings: [] },
    headSha: sha,
    changedLines: new Map(),
  }), /must explain/);
});

test('rejects whitespace-only finding bodies and accepts nullable optional values', () => {
  assert.throws(() => validateReview({
    review: { head_sha: sha, outcome: 'reviewed', summary: null, findings: [{ path: 'src/a.ts', line: 1, body: ' \n\t ', severity: null }] },
    headSha: sha,
    changedLines: new Map(),
  }), /body/);
  assert.deepEqual(validateReview({
    review: { head_sha: sha, outcome: 'reviewed', summary: null, findings: [] },
    headSha: sha,
    changedLines: new Map(),
  }), { comments: [], body: null });
});

test('deduplicates findings, drops unknown paths and deleted lines, and filters duplicate summary', () => {
  const files = [{ filename: 'src/a.ts', patch: '@@ -2,2 +2,3 @@\n old\n-line deleted\n+new\n+another\n' }];
  const changed = changedLinesFromFiles(files);
  assert.deepEqual([...changed.get('src/a.ts')], [3, 4]);
  const review = { head_sha: sha, outcome: 'reviewed', summary: 'Handle null.', findings: [
    { path: 'src/a.ts', line: 3, body: 'Handle null.', severity: null },
    { path: 'src/a.ts', line: 3, body: 'Handle null.', severity: null },
    { path: 'missing.ts', line: 3, body: 'No.', severity: null },
    { path: 'src/a.ts', line: 99, body: 'No.', severity: null },
  ] };
  assert.deepEqual(validateReview({ review, headSha: sha, changedLines: changed }), {
    comments: [{ path: 'src/a.ts', line: 3, body: 'Handle null.' }], body: null,
  });
});

test('does not treat a no-newline marker as a changed line', () => {
  const changed = changedLinesFromFiles([{ filename: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n' }]);
  assert.deepEqual([...changed.get('src/a.ts')], [1]);
  assert.deepEqual(validateReview({
    review: { head_sha: sha, outcome: 'reviewed', summary: null, findings: [{ path: 'src/a.ts', line: 2, body: 'Not in the diff.', severity: null }] },
    headSha: sha,
    changedLines: changed,
  }).comments, []);
});

test('treats deleted hunk content beginning with two dashes as deletion', () => {
  const changed = changedLinesFromFiles([{
    filename: 'query.sql',
    patch: '@@ -1,3 +1,3 @@\n--- removed SQL comment\n unchanged\n+replacement\n trailing\n',
  }]);
  assert.deepEqual([...changed.get('query.sql')], [2]);
  assert.deepEqual(validateReview({
    review: { head_sha: sha, outcome: 'reviewed', summary: null, findings: [
      { path: 'query.sql', line: 2, body: 'Check the replacement.', severity: 'warning' },
      { path: 'query.sql', line: 4, body: 'This line does not exist.', severity: null },
    ] },
    headSha: sha,
    changedLines: changed,
  }).comments, [{ path: 'query.sql', line: 2, body: 'Check the replacement.' }]);
});

test('loads JSON and posts inline or summary-only reviews against the reviewed commit', async () => {
  assert.deepEqual(loadReview(JSON.stringify({ head_sha: sha, outcome: 'reviewed', summary: null, findings: [] })), { head_sha: sha, outcome: 'reviewed', summary: null, findings: [] });
  assert.throws(() => loadReview('{bad'), /JSON/);
  const calls = [];
  const github = { paginate: async () => [], rest: { pulls: {
    get: async (input) => { calls.push(['get', input]); return { data: { head: { sha } } }; },
    createReview: async (input) => calls.push(['createReview', input]),
  } } };
  await postReview({ github, owner: 'o', repo: 'r', pullNumber: 7, eventHeadSha: sha, reviewedHeadSha: sha, comments: [{ path: 'a', line: 2, body: 'Fix it' }], body: null });
  await postReview({ github, owner: 'o', repo: 'r', pullNumber: 7, eventHeadSha: sha, reviewedHeadSha: sha, comments: [], body: 'summary' });
  assert.deepEqual(calls, [
    ['get', { owner: 'o', repo: 'r', pull_number: 7 }],
    ['createReview', { owner: 'o', repo: 'r', pull_number: 7, commit_id: sha, event: 'COMMENT', body: '', comments: [{ path: 'a', line: 2, side: 'RIGHT', body: 'Fix it' }] }],
    ['get', { owner: 'o', repo: 'r', pull_number: 7 }],
    ['createReview', { owner: 'o', repo: 'r', pull_number: 7, commit_id: sha, event: 'COMMENT', body: 'summary', comments: [] }],
  ]);
});

test('refuses to post when the live PR head differs from the event or reviewed head', async () => {
  for (const heads of [
    { eventHeadSha: 'b'.repeat(40), reviewedHeadSha: sha },
    { eventHeadSha: sha, reviewedHeadSha: 'b'.repeat(40) },
  ]) {
    let posted = false;
    const github = { rest: { pulls: {
      get: async () => ({ data: { head: { sha } } }),
      createReview: async () => { posted = true; },
    } } };
    await assert.rejects(postReview({
      github, owner: 'o', repo: 'r', pullNumber: 7, ...heads,
      comments: [{ path: 'a', line: 2, body: 'Fix it' }], body: null,
    }), /stale PR head SHA/);
    assert.equal(posted, false);
  }
});

test('does not post another review for a commit already reviewed by Actions', async () => {
  let posted = false;
  const github = { paginate: async () => [{ user: { login: 'github-actions[bot]' }, commit_id: sha }], rest: { pulls: {
    get: async () => ({ data: { head: { sha } } }),
    listReviews: async () => assert.fail('paginate supplies existing reviews'),
    createReview: async () => { posted = true; },
  } } };
  await postReview({
    github, owner: 'o', repo: 'r', pullNumber: 7, eventHeadSha: sha, reviewedHeadSha: sha,
    comments: [{ path: 'a', line: 2, body: 'Fix it' }], body: null,
  });
  assert.equal(posted, false);
});

test('does not post after three completed automated reviews', async () => {
  let posted = false;
  const github = {
    paginate: async () => [
      { user: { login: 'github-actions[bot]' }, submitted_at: '2026-08-18T10:00:00Z' },
      { user: { login: 'github-actions[bot]' }, submitted_at: '2026-08-18T10:01:00Z' },
      { user: { login: 'github-actions[bot]' }, submitted_at: '2026-08-18T10:02:00Z' },
    ],
    rest: { pulls: {
      get: async () => ({ data: { head: { sha } } }),
      createReview: async () => { posted = true; },
    } },
  };
  await postReview({
    github, owner: 'o', repo: 'r', pullNumber: 7, eventHeadSha: sha, reviewedHeadSha: sha,
    comments: [{ path: 'a', line: 2, body: 'Fix it' }], body: null,
  });
  assert.equal(posted, false);
});

test('posts a later round when maxRounds is raised above the review count', async () => {
  let posted = false;
  const github = {
    paginate: async () => [
      { user: { login: 'github-actions[bot]' }, submitted_at: '2026-08-18T10:00:00Z' },
      { user: { login: 'github-actions[bot]' }, submitted_at: '2026-08-18T10:01:00Z' },
      { user: { login: 'github-actions[bot]' }, submitted_at: '2026-08-18T10:02:00Z' },
    ],
    rest: { pulls: {
      get: async () => ({ data: { head: { sha } } }),
      createReview: async () => { posted = true; },
    } },
  };
  await postReview({
    github, owner: 'o', repo: 'r', pullNumber: 7, eventHeadSha: sha, reviewedHeadSha: sha,
    comments: [{ path: 'a', line: 2, body: 'Fix it' }], body: null, maxRounds: 5,
  });
  assert.equal(posted, true);
});

test('refuses a non-numeric maxRounds instead of reviewing unbounded', async () => {
  const github = {
    paginate: async () => [],
    rest: { pulls: {
      get: async () => ({ data: { head: { sha } } }),
      createReview: async () => assert.fail('must not post'),
    } },
  };
  await assert.rejects(postReview({
    github, owner: 'o', repo: 'r', pullNumber: 7, eventHeadSha: sha, reviewedHeadSha: sha,
    comments: [{ path: 'a', line: 2, body: 'Fix it' }], body: null, maxRounds: Number('abc'),
  }), /positive integer/);
});

test('posts after the cap when ignoreCap is set', async () => {
  let posted = false;
  const github = {
    paginate: async () => [
      { user: { login: 'github-actions[bot]' }, submitted_at: '2026-08-18T10:00:00Z' },
      { user: { login: 'github-actions[bot]' }, submitted_at: '2026-08-18T10:01:00Z' },
      { user: { login: 'github-actions[bot]' }, submitted_at: '2026-08-18T10:02:00Z' },
    ],
    rest: { pulls: {
      get: async () => ({ data: { head: { sha } } }),
      createReview: async () => { posted = true; },
    } },
  };
  await postReview({
    github, owner: 'o', repo: 'r', pullNumber: 7, eventHeadSha: sha, reviewedHeadSha: sha,
    comments: [{ path: 'a', line: 2, body: 'Fix it' }], body: null, ignoreCap: true,
  });
  assert.equal(posted, true);
});

test('ignores malformed review entries during duplicate suppression', async () => {
  let posted = false;
  const github = {
    paginate: async () => [null, { user: { login: 'octocat' } }],
    rest: { pulls: {
      get: async () => ({ data: { head: { sha } } }),
      createReview: async () => { posted = true; },
    } },
  };
  await postReview({
    github, owner: 'o', repo: 'r', pullNumber: 7, eventHeadSha: sha, reviewedHeadSha: sha,
    comments: [{ path: 'a', line: 2, body: 'Fix it' }], body: null,
  });
  assert.equal(posted, true);
});

test('does not post a summary-only review after validation filters findings without a summary', async () => {
  const result = validateReview({
    review: { head_sha: sha, outcome: 'reviewed', summary: null, findings: [{ path: 'missing.ts', line: 1, body: 'Out of patch.', severity: null }] },
    headSha: sha,
    changedLines: new Map(),
  });
  const github = { rest: { pulls: { createReview: async () => assert.fail('must not post') } } };
  await postReview({ github, owner: 'o', repo: 'r', pullNumber: 7, eventHeadSha: sha, reviewedHeadSha: sha, ...result });
});
