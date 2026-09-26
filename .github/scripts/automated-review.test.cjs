const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateReview,
  loadReview,
  changedLinesFromFiles,
  countAutomatedReviews,
  postReview,
  assertLiveHead,
  listReviewThreads,
  countOpenAutomatedThreads,
  applyVerdicts,
  formatReviewPatchIdMarker,
  extractReviewPatchId,
  latestAutomatedReviewPatchId,
  shouldSkipUnchangedPatch,
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
    review: { head_sha: sha, outcome: 'reviewed', prior_findings: [], summary: null, findings: [{ path: 'src/a.ts', line: 4, body: 'Handle the null value.', severity: null }] },
    headSha: sha,
    changedLines: new Map([['src/a.ts', new Set([4])]]),
    noFindingsSummary: 'No issues found',
  });
  assert.deepEqual(result, { comments: [{ path: 'src/a.ts', line: 4, body: 'Handle the null value.' }], body: null, verdicts: [] });
});

test('preserves a useful later-round summary when no current inline findings survive', () => {
  const result = validateReview({
    review: {
      head_sha: sha,
      outcome: 'reviewed',
      prior_findings: [{ comment_id: 41, verdict: 'addressed', reason: '  src/a.ts:4 now has the null guard.  ' }],
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
    verdicts: [{ commentId: 41, verdict: 'addressed', reason: 'src/a.ts:4 now has the null guard.' }],
  });
});

test('returns an empty no-op result for findings outside the patch', () => {
  assert.deepEqual(validateReview({
    review: { head_sha: sha, outcome: 'reviewed', prior_findings: [], summary: null, findings: [{ path: 'src/a.ts', line: 3, body: 'No.', severity: null }] },
    headSha: sha,
    changedLines: new Map(),
  }), { comments: [], body: null, verdicts: [] });
});

test('supplies the shared verdict when no findings survive validation', () => {
  assert.deepEqual(validateReview({
    review: { head_sha: sha, outcome: 'reviewed', prior_findings: [], summary: null, findings: [] },
    headSha: sha,
    changedLines: new Map(),
    noFindingsSummary: 'No issues found',
  }), { comments: [], body: 'No issues found', verdicts: [] });
  assert.deepEqual(validateReview({
    review: { head_sha: sha, outcome: 'reviewed', prior_findings: [], summary: '  ', findings: [] },
    headSha: sha,
    changedLines: new Map(),
    noFindingsSummary: 'No issues found',
  }), { comments: [], body: 'No issues found', verdicts: [] });
  assert.deepEqual(validateReview({
    review: { head_sha: sha, outcome: 'reviewed', prior_findings: [], summary: null, findings: [{ path: 'missing.ts', line: 1, body: 'Out of patch.', severity: null }] },
    headSha: sha,
    changedLines: new Map(),
    noFindingsSummary: 'No issues found',
  }), { comments: [], body: 'No issues found', verdicts: [] });
  assert.deepEqual(validateReview({
    review: { head_sha: sha, outcome: 'reviewed', prior_findings: [], summary: null, findings: [{ path: 'missing.ts', line: 1, body: 'Out of patch.', severity: null }] },
    headSha: sha,
    changedLines: new Map(),
  }), { comments: [], body: null, verdicts: [] });
});

test('rejects stale, malformed, and unknown-key output', () => {
  for (const outcome of ['reviewed', 'skipped']) {
    assert.throws(() => validateReview({ review: { head_sha: null, outcome, prior_findings: [], summary: 'Review result.', findings: [] }, headSha: sha, changedLines: new Map() }), /requires head_sha/);
  }
  assert.throws(() => validateReview({ review: { head_sha: 'b'.repeat(40), outcome: 'reviewed', prior_findings: [], summary: null, findings: [] }, headSha: sha, changedLines: new Map() }), /stale PR head SHA/);
  assert.throws(() => validateReview({ review: { head_sha: sha, outcome: 'reviewed', prior_findings: [], summary: null, findings: 'no' }, headSha: sha, changedLines: new Map() }), /findings/);
  assert.throws(() => validateReview({ review: { head_sha: sha, outcome: 'reviewed', prior_findings: [], summary: null, findings: [], extra: true }, headSha: sha, changedLines: new Map() }), /unknown key/);
  assert.throws(() => validateReview({ review: { head_sha: sha, outcome: 'reviewed', prior_findings: [], summary: null, findings: [{ path: 'a', line: 0, body: 'x', severity: null }] }, headSha: sha, changedLines: new Map() }), /positive integer/);
  assert.throws(() => validateReview({ review: { head_sha: sha, outcome: 'reviewed', prior_findings: [], summary: null, findings: [{ path: 'a', line: 1, body: 'x', severity: 'urgent' }] }, headSha: sha, changedLines: new Map() }), /severity/);
  assert.throws(() => validateReview({ review: { head_sha: sha, summary: 'Review could not be completed.', findings: [] }, headSha: sha, changedLines: new Map() }), /outcome.*required/);
  assert.throws(() => validateReview({ review: { head_sha: sha, outcome: 'reviewed', prior_findings: [], findings: [] }, headSha: sha, changedLines: new Map() }), /summary.*required/);
  assert.throws(() => validateReview({ review: { head_sha: sha, outcome: 'reviewed', prior_findings: [], summary: null, findings: [{ path: 'a', line: 1, body: 'x' }] }, headSha: sha, changedLines: new Map() }), /severity.*required/);
});

test('fails closed when a provider could not complete the review', () => {
  for (const noFindingsSummary of [null, 'No issues found']) {
    assert.throws(() => validateReview({
      review: {
        head_sha: null,
        outcome: 'failed',
        prior_findings: [],
        summary: 'PR data was unavailable.',
        findings: [],
      },
      headSha: sha,
      changedLines: new Map(),
      noFindingsSummary,
    }), /Automated review failed: PR data was unavailable\./);
  }
  assert.throws(() => validateReview({
    review: { head_sha: null, outcome: 'failed', prior_findings: [], summary: null, findings: [] },
    headSha: sha,
    changedLines: new Map(),
  }), /must explain/);
  assert.throws(() => validateReview({
    review: {
      head_sha: null,
      outcome: 'failed',
      prior_findings: [],
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
      prior_findings: [],
      summary: 'This commit was already reviewed.',
      findings: [],
    },
    headSha: sha,
    changedLines: new Map(),
    noFindingsSummary: 'No issues found',
  }), { comments: [], body: null, verdicts: [] });
  assert.throws(() => validateReview({
    review: { head_sha: sha, outcome: 'skipped', prior_findings: [], summary: null, findings: [] },
    headSha: sha,
    changedLines: new Map(),
  }), /must explain/);
});

test('rejects whitespace-only finding bodies and accepts nullable optional values', () => {
  assert.throws(() => validateReview({
    review: { head_sha: sha, outcome: 'reviewed', prior_findings: [], summary: null, findings: [{ path: 'src/a.ts', line: 1, body: ' \n\t ', severity: null }] },
    headSha: sha,
    changedLines: new Map(),
  }), /body/);
  assert.deepEqual(validateReview({
    review: { head_sha: sha, outcome: 'reviewed', prior_findings: [], summary: null, findings: [] },
    headSha: sha,
    changedLines: new Map(),
  }), { comments: [], body: null, verdicts: [] });
});

test('deduplicates findings, drops unknown paths and deleted lines, and filters duplicate summary', () => {
  const files = [{ filename: 'src/a.ts', patch: '@@ -2,2 +2,3 @@\n old\n-line deleted\n+new\n+another\n' }];
  const changed = changedLinesFromFiles(files);
  assert.deepEqual([...changed.get('src/a.ts')], [3, 4]);
  const review = { head_sha: sha, outcome: 'reviewed', prior_findings: [], summary: 'Handle null.', findings: [
    { path: 'src/a.ts', line: 3, body: 'Handle null.', severity: null },
    { path: 'src/a.ts', line: 3, body: 'Handle null.', severity: null },
    { path: 'missing.ts', line: 3, body: 'No.', severity: null },
    { path: 'src/a.ts', line: 99, body: 'No.', severity: null },
  ] };
  assert.deepEqual(validateReview({ review, headSha: sha, changedLines: changed }), {
    comments: [{ path: 'src/a.ts', line: 3, body: 'Handle null.' }], body: null, verdicts: [],
  });
});

test('does not treat a no-newline marker as a changed line', () => {
  const changed = changedLinesFromFiles([{ filename: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n' }]);
  assert.deepEqual([...changed.get('src/a.ts')], [1]);
  assert.deepEqual(validateReview({
    review: { head_sha: sha, outcome: 'reviewed', prior_findings: [], summary: null, findings: [{ path: 'src/a.ts', line: 2, body: 'Not in the diff.', severity: null }] },
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
    review: { head_sha: sha, outcome: 'reviewed', prior_findings: [], summary: null, findings: [
      { path: 'query.sql', line: 2, body: 'Check the replacement.', severity: 'warning' },
      { path: 'query.sql', line: 4, body: 'This line does not exist.', severity: null },
    ] },
    headSha: sha,
    changedLines: changed,
  }).comments, [{ path: 'query.sql', line: 2, body: 'Check the replacement.' }]);
});

test('loads JSON and posts inline or summary-only reviews against the reviewed commit', async () => {
  assert.deepEqual(loadReview(JSON.stringify({ head_sha: sha, outcome: 'reviewed', prior_findings: [], summary: null, findings: [] })), { head_sha: sha, outcome: 'reviewed', prior_findings: [], summary: null, findings: [] });
  assert.throws(() => loadReview('{bad'), /JSON/);
  const calls = [];
  const github = { paginate: async () => [], rest: { pulls: {
    get: async (input) => { calls.push(['get', input]); return { data: { head: { sha } } }; },
    createReview: async (input) => calls.push(['createReview', input]),
  } } };
  await postReview({ github, owner: 'o', repo: 'r', pullNumber: 7, eventHeadSha: sha, reviewedHeadSha: sha, comments: [{ path: 'a', line: 2, body: 'Fix it' }], body: null, verdicts: [] });
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
    review: { head_sha: sha, outcome: 'reviewed', prior_findings: [], summary: null, findings: [{ path: 'missing.ts', line: 1, body: 'Out of patch.', severity: null }] },
    headSha: sha,
    changedLines: new Map(),
  });
  const github = { rest: { pulls: { createReview: async () => assert.fail('must not post') } } };
  await postReview({ github, owner: 'o', repo: 'r', pullNumber: 7, eventHeadSha: sha, reviewedHeadSha: sha, ...result });
});

const patchId = 'c'.repeat(40);
const otherPatchId = 'd'.repeat(40);

test('formats and extracts a 40-hex patch-id marker', () => {
  const marker = formatReviewPatchIdMarker(patchId);
  assert.equal(marker, `<!-- cez-review-patch-id: ${patchId} -->`);
  assert.equal(extractReviewPatchId(`summary\n\n${marker}`), patchId);
  assert.equal(extractReviewPatchId(marker), patchId);
});

test('extracts no patch-id when the marker is absent or malformed', () => {
  assert.equal(extractReviewPatchId('No issues found'), null);
  assert.equal(extractReviewPatchId('<!-- cez-review-patch-id: not-a-sha -->'), null);
  assert.equal(extractReviewPatchId('<!-- cez-review-patch-id: ' + 'c'.repeat(39) + ' -->'), null);
  assert.equal(extractReviewPatchId(null), null);
  assert.equal(formatReviewPatchIdMarker('nope'), null);
  assert.equal(formatReviewPatchIdMarker(''), null);
});

test('skips only when the current three-dot patch-id matches the last posted marker', () => {
  assert.equal(shouldSkipUnchangedPatch(patchId, patchId), true);
  assert.equal(shouldSkipUnchangedPatch(patchId, otherPatchId), false);
  assert.equal(shouldSkipUnchangedPatch(patchId, null), false);
  assert.equal(shouldSkipUnchangedPatch('', patchId), false);
  assert.equal(shouldSkipUnchangedPatch(null, patchId), false);
});

test('skip decision leaves the automated-review cap count untouched', () => {
  const reviews = [
    { user: { login: 'github-actions[bot]' }, submitted_at: '2026-09-15T10:00:00Z', body: formatReviewPatchIdMarker(patchId) },
  ];
  assert.equal(countAutomatedReviews(reviews), 1);
  assert.equal(latestAutomatedReviewPatchId(reviews), patchId);
  assert.equal(shouldSkipUnchangedPatch(patchId, latestAutomatedReviewPatchId(reviews)), true);
  assert.equal(countAutomatedReviews(reviews), 1);
});

test('treats a missing marker on prior bot reviews as no match', () => {
  const reviews = [
    { user: { login: 'github-actions[bot]' }, submitted_at: '2026-09-15T10:00:00Z', body: 'No issues found' },
    { user: { login: 'octocat' }, submitted_at: '2026-09-15T10:01:00Z', body: formatReviewPatchIdMarker(patchId) },
  ];
  assert.equal(latestAutomatedReviewPatchId(reviews), null);
  assert.equal(shouldSkipUnchangedPatch(patchId, latestAutomatedReviewPatchId(reviews)), false);
});

test('uses the most recent bot review that carries a patch-id marker', () => {
  const reviews = [
    { user: { login: 'github-actions[bot]' }, submitted_at: '2026-09-15T10:00:00Z', body: formatReviewPatchIdMarker(patchId) },
    { user: { login: 'github-actions[bot]' }, submitted_at: '2026-09-15T10:02:00Z', body: formatReviewPatchIdMarker(otherPatchId) },
    { user: { login: 'github-actions[bot]' }, submitted_at: '2026-09-15T10:01:00Z', body: 'unmarked' },
  ];
  assert.equal(latestAutomatedReviewPatchId(reviews), otherPatchId);
});

test('appends the patch-id marker to summary and findings-only review bodies', async () => {
  const calls = [];
  const github = { paginate: async () => [], rest: { pulls: {
    get: async () => ({ data: { head: { sha } } }),
    createReview: async (input) => calls.push(input),
  } } };
  await postReview({
    github, owner: 'o', repo: 'r', pullNumber: 7, eventHeadSha: sha, reviewedHeadSha: sha,
    comments: [{ path: 'a', line: 2, body: 'Fix it' }], body: null, patchId,
  });
  await postReview({
    github, owner: 'o', repo: 'r', pullNumber: 7, eventHeadSha: sha, reviewedHeadSha: sha,
    comments: [], body: 'summary', patchId,
  });
  assert.equal(calls[0].body, formatReviewPatchIdMarker(patchId));
  assert.equal(calls[1].body, `summary\n\n${formatReviewPatchIdMarker(patchId)}`);
});

test('validates prior-finding verdicts and keeps the first verdict per thread', () => {
  const review = (priorFindings) => ({ head_sha: sha, outcome: 'reviewed', prior_findings: priorFindings, summary: null, findings: [] });
  const result = validateReview({
    review: review([
      { comment_id: 5, verdict: 'addressed', reason: 'Fixed by the guard.' },
      { comment_id: 5, verdict: 'unresolved', reason: 'Duplicate verdict.' },
      { comment_id: 6, verdict: 'unresolved', reason: 'The reply does not hold: the input can be null.' },
    ]),
    headSha: sha,
    changedLines: new Map(),
  });
  assert.deepEqual(result.verdicts, [
    { commentId: 5, verdict: 'addressed', reason: 'Fixed by the guard.' },
    { commentId: 6, verdict: 'unresolved', reason: 'The reply does not hold: the input can be null.' },
  ]);
  for (const [bad, pattern] of [
    [[{ comment_id: 0, verdict: 'addressed', reason: 'x' }], /comment_id/],
    [[{ comment_id: 1.5, verdict: 'addressed', reason: 'x' }], /comment_id/],
    [[{ comment_id: 1, verdict: 'maybe', reason: 'x' }], /verdict/],
    [[{ comment_id: 1, verdict: 'addressed', reason: '  ' }], /reason/],
    [[{ comment_id: 1, verdict: 'addressed' }], /reason.*required/],
    [[{ comment_id: 1, verdict: 'addressed', reason: 'x', extra: 1 }], /unknown key/],
    ['no', /prior_findings must be an array/],
  ]) assert.throws(() => validateReview({ review: review(bad), headSha: sha, changedLines: new Map() }), pattern);
  const withoutVerdicts = { head_sha: sha, outcome: 'reviewed', summary: null, findings: [] };
  assert.throws(() => validateReview({ review: withoutVerdicts, headSha: sha, changedLines: new Map() }), /prior_findings is required/);
  for (const outcome of ['skipped', 'failed']) {
    assert.throws(() => validateReview({
      review: { head_sha: sha, outcome, prior_findings: [{ comment_id: 1, verdict: 'addressed', reason: 'x' }], summary: 'Why.', findings: [] },
      headSha: sha,
      changedLines: new Map(),
    }), /cannot include findings/);
  }
});

test('postReview reports how many inline threads it opened', async () => {
  const pulls = { get: async () => ({ data: { head: { sha } } }), createReview: async () => {} };
  const fresh = { paginate: async () => [], rest: { pulls } };
  assert.equal(await postReview({ github: fresh, owner: 'o', repo: 'r', pullNumber: 7, eventHeadSha: sha, reviewedHeadSha: sha,
    comments: [{ path: 'a', line: 1, body: 'One' }, { path: 'a', line: 2, body: 'Two' }], body: null }), 2);
  assert.equal(await postReview({ github: fresh, owner: 'o', repo: 'r', pullNumber: 7, eventHeadSha: sha, reviewedHeadSha: sha,
    comments: [], body: 'No issues found' }), 0);
  assert.equal(await postReview({ github: { rest: {} }, owner: 'o', repo: 'r', pullNumber: 7, eventHeadSha: sha, reviewedHeadSha: sha,
    comments: [], body: null }), 0);
  const alreadyReviewed = { paginate: async () => [{ user: { login: 'github-actions[bot]' }, commit_id: sha }], rest: { pulls } };
  assert.equal(await postReview({ github: alreadyReviewed, owner: 'o', repo: 'r', pullNumber: 7, eventHeadSha: sha, reviewedHeadSha: sha,
    comments: [{ path: 'a', line: 1, body: 'One' }], body: null }), 0, 'a re-run on a reviewed head opens nothing new');
  const capped = { paginate: async () => [{ user: { login: 'github-actions[bot]' }, submitted_at: 'x' }], rest: { pulls } };
  assert.equal(await postReview({ github: capped, owner: 'o', repo: 'r', pullNumber: 7, eventHeadSha: sha, reviewedHeadSha: sha,
    comments: [{ path: 'a', line: 1, body: 'One' }], body: null, maxRounds: 1 }), 0, 'a cap-skipped post opens nothing new');
});

test('assertLiveHead refuses a moved head', async () => {
  const github = { rest: { pulls: { get: async () => ({ data: { head: { sha: 'b'.repeat(40) } } }) } } };
  await assert.rejects(assertLiveHead({ github, owner: 'o', repo: 'r', pullNumber: 7, eventHeadSha: sha }), /stale PR head SHA/);
});

function threadPage(nodes, endCursor = null) {
  return { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes } } } };
}
function threadNode(id, rootId, login, isResolved = false) {
  return { id, isResolved, comments: { nodes: [{ databaseId: rootId, author: login === null ? null : { login } }] } };
}

test('lists every review thread page and marks the ones this workflow started', async () => {
  const cursors = [];
  const github = { graphql: async (_query, variables) => {
    cursors.push(variables.cursor);
    return variables.cursor === null
      ? threadPage([threadNode('T1', 1, 'github-actions'), threadNode('T2', 2, 'octocat')], 'next')
      : threadPage([threadNode('T3', 3, 'github-actions[bot]', true), threadNode('T4', 4, null)]);
  } };
  const threads = await listReviewThreads({ github, owner: 'o', repo: 'r', pullNumber: 7 });
  assert.deepEqual(cursors, [null, 'next']);
  assert.deepEqual(threads.map(({ id, automated, isResolved }) => [id, automated, isResolved]),
    [['T1', true, false], ['T2', false, false], ['T3', true, true], ['T4', false, false]]);
  assert.equal(countOpenAutomatedThreads(threads), 1, 'human and resolved threads do not count as open findings');
  await assert.rejects(listReviewThreads({ github: { graphql: async () => ({}) }, owner: 'o', repo: 'r', pullNumber: 7 }), /review threads/);
});

test('applies verdicts only to open threads this workflow started', async () => {
  const calls = [];
  const github = {
    rest: { pulls: { createReplyForReviewComment: async (input) => calls.push(['reply', input.comment_id, input.body]) } },
    graphql: async (_query, variables) => calls.push(['resolve', variables.threadId]),
  };
  const threads = [
    { id: 'T1', isResolved: false, rootCommentId: 1, automated: true },
    { id: 'T2', isResolved: false, rootCommentId: 2, automated: true },
    { id: 'T3', isResolved: false, rootCommentId: 3, automated: false },
    { id: 'T4', isResolved: true, rootCommentId: 4, automated: true },
  ];
  const applied = await applyVerdicts({ github, owner: 'o', repo: 'r', pullNumber: 7, threads, verdicts: [
    { commentId: 1, verdict: 'addressed', reason: 'Guarded now.' },
    { commentId: 2, verdict: 'unresolved', reason: 'Still reachable with null.' },
    { commentId: 3, verdict: 'addressed', reason: 'A human thread.' },
    { commentId: 4, verdict: 'addressed', reason: 'Already resolved.' },
    { commentId: 99, verdict: 'addressed', reason: 'No such thread.' },
  ] });
  assert.deepEqual(calls, [
    ['reply', 1, 'Addressed: Guarded now.'],
    ['resolve', 'T1'],
    ['reply', 2, 'Still unresolved: Still reachable with null.'],
  ]);
  assert.deepEqual(applied, { resolved: 1, unresolved: 1 });
  assert.equal(countOpenAutomatedThreads(threads), 1, 'the addressed thread no longer counts as open');
});
