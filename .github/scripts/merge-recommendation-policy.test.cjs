const test = require('node:test');
const assert = require('node:assert/strict');
const { gate, decide, snapshotKey, validateAssessment } = require('./merge-recommendation-policy.cjs');

const { snapshot, assessment } = require('./fixtures/merge-recommendation.cjs');
const { headSha: head, baseSha: base } = snapshot();

test('requires two valid, revision-bound semantic judgments after the hard gates pass', () => {
  const s = snapshot();
  assert.equal(gate(s).decision, 'candidate');
  assert.equal(decide(s, assessment(s), assessment(s)).decision, 'recommend');
  assert.equal(decide(s, assessment(s), undefined).decision, 'pending');
  assert.equal(decide(s, undefined, assessment(s)).decision, 'pending');
  assert.equal(decide(s, assessment(s), assessment(s, { decision: 'human-review', reason: 'This changes policy.' })).decision, 'human-review');
});

test('counts every added and deleted line and every file without waivers', () => {
  for (const [count, additions, deletions, want] of [[5, 149, 1, 'candidate'], [5, 150, 1, 'human-review'], [6, 1, 0, 'human-review']]) {
    const files = Array.from({ length: count }, (_, i) => ({ path: `docs/page-${i}.md`, mode: '100644', status: 'modified', additions: i ? 0 : additions, deletions: i ? 0 : deletions }));
    const s = snapshot({ files });
    assert.equal(gate(s).decision, want);
    if (want !== 'candidate') assert.equal(decide(s, assessment(s), assessment(s)).decision, want);
  }
});

test('small instructions, policy, CI, dependencies, generated files and runtime changes require human review', () => {
  for (const path of ['AGENTS.md', 'CLAUDE.md', 'CODE_REVIEW.md', 'SDLC.md', 'BACKWARD_COMPATIBILITY.md', '.ai/skills/example/SKILL.md', 'docs/sdlc/ci.md', '.github/workflows/ci.yml', 'squeal.config.json', 'package.json', 'pnpm-lock.yaml', 'packages/cezar/src/workflows/run.ts', 'docs/example.generated.md', '.ai/upstream/LEDGER.md']) {
    const s = snapshot({ files: [{ path, mode: '100644', status: 'modified', additions: 1, deletions: 0 }] });
    assert.equal(gate(s).decision, 'human-review', path);
  }
});

test('admits additive test assertions but rejects deletions, renames, symlinks and unsafe paths', () => {
  for (const patch of [
    { path: 'packages/cezar/src/example.test.ts', status: 'modified', mode: '100644', additions: 8, deletions: 0, want: 'candidate' },
    { path: '.github/scripts/example.test.cjs', status: 'added', mode: '100644', additions: 8, deletions: 0, want: 'candidate' },
    { path: 'packages/cezar/src/example.test.ts', deletions: 1, want: 'human-review' },
    { status: 'renamed', want: 'human-review' }, { status: 'removed', want: 'human-review' },
    { mode: '120000', want: 'human-review' }, { path: '../README.md', want: 'human-review' },
    { path: 'docs/AGENTS.md', want: 'human-review' }, { path: 'docs/strange\nname.md', want: 'human-review' },
  ]) {
    const { want, ...file } = patch;
    assert.equal(gate(snapshot({ files: [{ ...snapshot().files[0], ...file }] })).decision, want, JSON.stringify(file));
  }
});

test('missing or incomplete inputs and unknown GitHub state never imply eligibility', () => {
  for (const patch of [
    { complete: false }, { trusted: false }, { diff: '' }, { files: [] }, { files: null },
    { headSha: null }, { baseSha: null }, { policyVersion: 0 }, { mergeable: null },
    { openThreads: null }, { checks: null }, { requiredChecks: [] },
    { files: [{ ...snapshot().files[0], additions: undefined }] },
  ]) assert.equal(gate(snapshot(patch)).decision, 'pending', JSON.stringify(patch));
});

test('drafts, conflicts, other targets and requested changes cannot receive recommendations', () => {
  for (const patch of [{ draft: true }, { state: 'closed' }, { sameRepository: false }, { targetDefault: false }, { mergeable: false }, { openThreads: 1 }, { reviewDecision: 'CHANGES_REQUESTED' }]) {
    assert.notEqual(gate(snapshot(patch)).decision, 'candidate', JSON.stringify(patch));
  }
});

test('requires successful latest checks on the pinned head from each required GitHub App', () => {
  for (const patch of [{ appId: 7 }, { headSha: base }, { conclusion: 'skipped' }, { conclusion: 'neutral' }, { conclusion: 'failure' }, { status: 'in_progress' }]) {
    const s = snapshot(); s.checks[0] = { ...s.checks[0], ...patch };
    assert.equal(gate(s).decision, 'pending', JSON.stringify(patch));
  }
  const s = snapshot();
  s.checks.push({ ...s.checks[0], id: 3, conclusion: 'failure' });
  assert.equal(gate(s).decision, 'pending');
  s.requiredChecks.push({ name: 'Another required check', appId: 15368 });
  assert.equal(gate(s).decision, 'pending');
});

test('rejects stale keys, fabricated file evidence, omitted files and extra model authority', () => {
  const s = snapshot();
  for (const patch of [{ key: 'stale' }, { evidence: [] }, { evidence: [{ path: 'other.md', reason: 'Looks fine.' }] }, { intent: '' }, { waiveLimit: true }, { decision: 'merge' }]) {
    assert.throws(() => validateAssessment(s, assessment(s, patch)));
    assert.notEqual(decide(s, assessment(s, patch), assessment(s)).decision, 'recommend');
  }
  for (const patch of [{ headSha: base }, { baseSha: head }, { policyCommit: head }, { diff: 'different' }]) {
    assert.notEqual(snapshotKey(snapshot(patch)), snapshotKey(s));
  }
});
