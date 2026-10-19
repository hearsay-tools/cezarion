const { snapshotKey } = require('../merge-recommendation-policy.cjs');
const head = 'a'.repeat(40), base = 'b'.repeat(40), trusted = 'c'.repeat(40);
function snapshot(overrides = {}) {
  return {
    repository: 'hearsay-tools/cezarion', number: 1, headSha: head, baseSha: base,
    policyCommit: trusted, policyVersion: 1, complete: true, trusted: true,
    state: 'open', draft: false, sameRepository: true, targetDefault: true,
    mergeable: true, mergeState: 'clean', reviewDecision: null, openThreads: 0,
    requiredChecks: [
      { name: 'Unit, build, E2E, and package', appId: 15368 },
      { name: 'Automated Code Review', appId: 15368 },
    ],
    checks: [
      { id: 1, name: 'Unit, build, E2E, and package', appId: 15368, headSha: head, status: 'completed', conclusion: 'success' },
      { id: 2, name: 'Automated Code Review', appId: 15368, headSha: head, status: 'completed', conclusion: 'success' },
    ],
    files: [{ path: 'README.md', status: 'modified', mode: '100644', additions: 1, deletions: 1 }],
    diff: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-tyop\n+typo\n',
    ...overrides,
  };
}
function assessment(s, overrides = {}) {
  return { key: snapshotKey(s), decision: 'recommend', reason: 'Corrects spelling without changing instructions.',
    intent: 'The existing README describes the same behavior.',
    evidence: s.files.map(f => ({ path: f.path, reason: 'The changed text preserves the existing meaning.' })), ...overrides };
}

module.exports = { snapshot, assessment };
