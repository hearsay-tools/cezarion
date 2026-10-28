// One verdict list for the docs rule (hearsay-tools/cezarion#1099). Both
// selectors assert it: change-surface.test.cjs for CI's docs-only surface and
// scripts/test-changed.test.mjs for `npm run test:changed`'s skip, so the two
// cannot drift. `docs: true` means no Vitest test or cockpit browser spec reads
// the path. Every path here is creatable in a fixture repo.
module.exports = [
  { path: 'README.md', docs: true },
  { path: 'AGENTS.md', docs: true },
  { path: 'docs/guide.md', docs: true },
  { path: 'docs/assets/diagram.svg', docs: true },
  { path: '.ai/specs/2026-09-16.md', docs: true },
  { path: '.ai/analysis/notes.md', docs: true },
  { path: '.ai/upstream/LEDGER.md', docs: true },
  { path: 'LICENSE', docs: true },
  { path: 'packages/web/e2e/README.md', docs: true },
  { path: 'packages/api-client/README.md', docs: true },
  { path: 'packages/contract/README.md', docs: true },
  { path: 'packages/cezar/notes.md', docs: true },
  { path: 'packages/web/src/components/design-icons/README.md', docs: true },

  // Markdown a test reads: changing it must run that test.
  { path: 'AGENT_PROTOCOL.md', docs: false },
  { path: 'BACKWARD_COMPATIBILITY.md', docs: true },
  { path: '.ai/specs/2026-09-04-harness-parity-matrix.md', docs: false },
  // Markdown in a fixture or snapshot directory may be test data.
  { path: 'packages/web/e2e/fixtures/README.md', docs: false },
  { path: 'packages/cezar/src/core/__fixtures__/omp/README.md', docs: false },
  { path: 'packages/cezar/src/__snapshots__/notes.md', docs: false },
  // Only lowercase `.md`, like the root rule; never code or config.
  { path: 'packages/web/e2e/README.MD', docs: false },
  { path: 'packages/web/e2e/notes.mdx', docs: false },
  { path: 'packages/web/e2e/smoke.e2e.ts', docs: false },
  { path: 'packages/web/package.json', docs: false },
  { path: 'package.json', docs: false },
  { path: '.github/README.md', docs: false },
];
