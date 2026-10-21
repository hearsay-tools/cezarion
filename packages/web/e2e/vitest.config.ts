import { defineConfig } from 'vitest/config'
import CockpitTestSequencer from '../../../.github/scripts/cockpit-test-sequencer.mjs'

/**
 * The root configuration exposes this project to Squeal's slow tier. `npm test` selects
 * only unit projects, so the fast gate never needs a server or browser. Project globalSetup
 * prepares the environment when Squeal runs a browser file directly; `npm run test:e2e`
 * also bootstraps first so it can preserve the wrapper's passed/failed/skipped contract.
 *
 * Plain node environment and no React plugin — the specs shell out to agent-browser and drive
 * a real Chrome; nothing here is bundled or rendered in jsdom.
 */
export default defineConfig({
  test: {
    name: 'e2e',
    root: import.meta.dirname,
    environment: 'node',
    // failure-setup names the running test for the seam's failure bundles and writes one for a
    // plain `expect` failure, so a red spec always leaves page state behind (#408).
    setupFiles: ['../../../scripts/test-git-env.mjs', './fetch-setup.mjs', './failure-setup.ts'],
    include: ['**/*.e2e.ts'],
    // One browser session, one server: parallel specs would fight over both.
    fileParallelism: false,
    sequence: { sequencer: CockpitTestSequencer },
    // Pins the shared env's workspace registry to the single-project shape before any spec runs,
    // and restores it afterwards — otherwise whatever the operator last registered in the
    // gitignored `.ai/qa/cez-home` decides whether the sidebar renders its flat or its grouped
    // shell, and every spec asserting flat-shell selectors becomes a coin flip. See the module.
    // Environment owns registry setup/restore so it releases its lease AFTER restoration.
    globalSetup: ['./environment.ts'],
    // A real browser is slower than jsdom, but a smoke test that needs more than this is broken.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
