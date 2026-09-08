import { defineConfig } from 'vitest/config'
import CiTestSequencer from './.github/scripts/ci-test-sequencer.mjs'

// Three packages, one `npm test`. Each owns its own vitest config — this file only names
// them, so `npm test -w <pkg>` and the whole-repo run execute the identical setup:
//   - packages/cezar     Node ESM (NodeNext, `.js` relative imports)
//   - packages/api-client the Node-free contract package between the two
//   - packages/web        DOM code, resolved exactly as Vite bundles it
export default defineConfig({
  test: {
    // The suites are still being grown; a project that currently matches no file must not
    // fail the validation gate. Root-level only — vitest rejects this inside a project.
    passWithNoTests: true,
    // Balance CI shards by measured duration; new tests remain automatically discovered.
    sequence: { sequencer: CiTestSequencer },
    // Pin reporters so Actions gets exactly one `github-actions` job summary for the whole
    // multi-project run (#62). Leaving this unset lets Vitest auto-append the reporter when
    // GITHUB_ACTIONS=true; an explicit list replaces the defaults and documents the
    // single-summary contract. Local runs keep `default` only.
    reporters:
      process.env.GITHUB_ACTIONS === 'true'
        ? ['default', ['github-actions', { jobSummary: { title: 'Vitest Test Report' } }]]
        : ['default'],
    projects: [
      './packages/cezar/vitest.config.ts',
      './packages/api-client/vitest.config.ts',
      './packages/web/vitest.config.ts',
    ],
  },
})
