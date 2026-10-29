const fs = require('node:fs');
const tty = require('node:tty');

// Docs: paths no Vitest test or cockpit browser spec reads (testReadDocuments
// below names the exceptions). A change confined to them skips both suites and
// the automated review; scripts/test-changed.mjs skips the same set through
// isDocsPath. build-and-package still runs every node:test file, so a docs
// path that only a node:test file reads stays docs; put a check on a docs file
// there (hearsay-tools/cezarion#2166). change-surface-readers.test.cjs fails
// when package code outside those files reads a docs path not listed below.
const docsAllowlisted = [
  /^[^/]+\.md$/,
  /^docs\/(?:[^/]+\/)*[^/]+$/,
  /^\.ai\/specs\/(?:[^/]+\/)*[^/]+$/,
  /^\.ai\/analysis\/(?:[^/]+\/)*[^/]+$/,
  // Markdown at any depth under packages/, except in a fixture or snapshot
  // directory, where it may be test data (hearsay-tools/cezarion#1099).
  // change-surface-readers.test.cjs fails when package code reads one.
  /^packages\/(?!(?:[^/]+\/)*(?:__fixtures__|fixtures|__snapshots__)\/)(?:[^/]+\/)*[^/]+\.md$/,
  // Generated scan data only, not arbitrary files under .ai/upstream. The
  // unconditional build-and-package job validates the ledger via test:unit.
  /^\.ai\/upstream\/(?:ledger\.yaml|LEDGER\.md)$/,
  /^\.ai\/upstream\/scans\/\d{4}-\d{2}-\d{2}(?:-(?:[2-9]|[1-9]\d+))?\.md$/,
  /^(?:AGENTS|CODE_REVIEW|SDLC)\.md$/,
  /^LICENSE[^/]*$/,
];

// Markdown a Vitest test or a cockpit browser spec reads. A listed path is
// never docs, so changing it runs the full matrix and the test that reads it.
const testReadDocuments = [
  'AGENT_PROTOCOL.md', // packages/cezar/src/core/harness-parity.test.ts
  '.ai/specs/2026-09-04-harness-parity-matrix.md', // packages/cezar/src/core/harness-parity.test.ts
];

// Ops workflows that never run product-test suites, plus the engine scripts of
// the allowlisted workflows, each with its .test.cjs sibling (#468; spec
// docs/superpowers/specs/2026-09-25-infra-only-change-surface-design.md).
// Exact-file allowlist on purpose: a new or renamed file fails closed to
// full-matrix until deliberately listed here, and harness files — ci.yml,
// automated-code-review.yml, ci-benchmark.yml,
// release.yml and nightly.yml (both run `npm test` themselves — #565 review),
// change-surface.cjs, require-e2e-passed.cjs, ci-test-sequencer.mjs,
// automated-review.cjs, release-bump-pr.cjs, the *.workflow.test.cjs pins —
// must never appear (issue constraint #5: a PR that widens skips or alters a
// harness that executes product suites runs the suites it affects).
// Engine-script tests stay covered: they run under `npm run test:unit` inside
// the unconditional build-and-package job.
const infraAllowlisted = [
  /^\.github\/workflows\/(?:report-workflow-failure|sweep-ci-failures|upstream-scan|npm-preview-cleanup|publish-pr-snapshot|issue-intake)\.yml$/,
  /^\.github\/scripts\/(?:ci-sweep-api|ci-sweep-collect|ci-sweep-patterns|ci-sweep-report|apply-issue-intake|issue-intake-candidates|jev-issue-intake|jev-intake-replay)(?:\.test)?\.cjs$/,
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

function isDocsPath(path) {
  return isSafePath(path)
    && docsAllowlisted.some((pattern) => pattern.test(path))
    && !testReadDocuments.includes(path);
}

function classifyPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every(isSafePath)) {
    return 'full-matrix';
  }
  if (paths.every(isDocsPath)) {
    return 'docs-only';
  }
  if (paths.every((path) => infraAllowlisted.some((pattern) => pattern.test(path)))) {
    return 'infra-only';
  }
  return 'full-matrix';
}

// null marks malformed input; an empty list retains the no-path verdict.
function parseJsonLines(input) {
  if (typeof input !== 'string' || input.length === 0) {
    return [];
  }

  const withoutFinalNewline = input.endsWith('\n') ? input.slice(0, -1) : input;
  if (withoutFinalNewline.length === 0) {
    return [];
  }

  const paths = [];
  try {
    for (const line of withoutFinalNewline.split('\n')) {
      const value = JSON.parse(line);
      if (typeof value !== 'string') {
        return null;
      }
      paths.push(value);
    }
  } catch {
    return null;
  }
  return paths;
}

function classifyJsonLines(input) {
  return classifyPaths(parseJsonLines(input));
}

const usage = `usage: <changed paths, one JSON string per line> | node .github/scripts/change-surface.cjs
Prints docs-only, infra-only or full-matrix. To classify the current branch:
  git diff --name-only --no-renames origin/main...HEAD | jq -R . | node .github/scripts/change-surface.cjs
`;

if (require.main === module) {
  // A terminal on stdin means no pipe: reading it would wait for input that
  // never comes (hearsay-tools/cezarion#1640). CI always pipes.
  if (tty.isatty(0)) {
    process.stderr.write(usage);
    process.exitCode = 2;
  } else {
    const paths = parseJsonLines(fs.readFileSync(0, 'utf8'));
    if (paths === null) process.stderr.write(usage);
    process.stdout.write(`${classifyPaths(paths)}\n`);
  }
}

module.exports = { classifyPaths, classifyJsonLines, isDocsPath, testReadDocuments, usage };
