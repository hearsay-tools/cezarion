const fs = require('node:fs');

const docsAllowlisted = [
  /^[^/]+\.md$/,
  /^docs\/(?:[^/]+\/)*[^/]+$/,
  /^\.ai\/specs\/(?:[^/]+\/)*[^/]+$/,
  /^\.ai\/analysis\/(?:[^/]+\/)*[^/]+$/,
  // Generated scan data only, not arbitrary files under .ai/upstream. The
  // unconditional build-and-package job validates the ledger via test:unit.
  /^\.ai\/upstream\/(?:ledger\.yaml|LEDGER\.md)$/,
  /^\.ai\/upstream\/scans\/\d{4}-\d{2}-\d{2}(?:-(?:[2-9]|[1-9]\d+))?\.md$/,
  /^(?:AGENT_PROTOCOL|AGENTS|BACKWARD_COMPATIBILITY|CODE_REVIEW|SDLC)\.md$/,
  /^LICENSE[^/]*$/,
];

// Ops workflows that never run product-test suites, plus the engine scripts of
// the allowlisted workflows, each with its .test.cjs sibling (#468; spec
// docs/superpowers/specs/2026-09-25-infra-only-change-surface-design.md).
// Exact-file allowlist on purpose: a new or renamed file fails closed to
// full-matrix until deliberately listed here, and harness files — ci.yml,
// automated-code-review.yml, recover-automated-review.yml, ci-benchmark.yml,
// release.yml and nightly.yml (both run `npm test` themselves — #565 review),
// change-surface.cjs, require-e2e-passed.cjs, ci-test-sequencer.mjs,
// automated-review.cjs, release-bump-pr.cjs, the *.workflow.test.cjs pins —
// must never appear (issue constraint #5: a PR that widens skips or alters a
// harness that executes product suites runs the suites it affects).
// Engine-script tests stay covered: they run under `npm run test:unit` inside
// the unconditional build-and-package job.
const infraAllowlisted = [
  /^\.github\/workflows\/(?:report-workflow-failure|sweep-ci-failures|upstream-scan|npm-preview-cleanup|publish-pr-snapshot|issue-intake)\.yml$/,
  /^\.github\/scripts\/(?:ci-sweep-api|ci-sweep-collect|ci-sweep-patterns|ci-sweep-report|apply-issue-intake)(?:\.test)?\.cjs$/,
];

function isSafePath(path) {
  return typeof path === 'string'
    && path.length > 0
    && !path.startsWith('/')
    && !path.includes('\\')
    && !path.includes('\0')
    && !path.split('/').includes('..')
    && !path.split('/').includes('')
    && (docsAllowlisted.some((pattern) => pattern.test(path))
      || infraAllowlisted.some((pattern) => pattern.test(path)));
}

function classifyPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every(isSafePath)) {
    return 'full-matrix';
  }
  if (paths.every((path) => docsAllowlisted.some((pattern) => pattern.test(path)))) {
    return 'docs-only';
  }
  if (paths.every((path) => infraAllowlisted.some((pattern) => pattern.test(path)))) {
    return 'infra-only';
  }
  return 'full-matrix';
}

function classifyJsonLines(input) {
  if (typeof input !== 'string' || input.length === 0) {
    return 'full-matrix';
  }

  const withoutFinalNewline = input.endsWith('\n') ? input.slice(0, -1) : input;
  if (withoutFinalNewline.length === 0) {
    return 'full-matrix';
  }

  const lines = withoutFinalNewline.split('\n');
  const paths = [];
  try {
    for (const line of lines) {
      const value = JSON.parse(line);
      if (typeof value !== 'string') {
        return 'full-matrix';
      }
      paths.push(value);
    }
  } catch {
    return 'full-matrix';
  }
  return classifyPaths(paths);
}

if (require.main === module) {
  process.stdout.write(`${classifyJsonLines(fs.readFileSync(0, 'utf8'))}\n`);
}

module.exports = { classifyPaths, classifyJsonLines };
