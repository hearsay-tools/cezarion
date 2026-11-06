/**
 * Harness-only cockpit build for React commit timing (benchmark-tabs.ts --workload index,
 * hearsay-tools/cezarion#2729). The production config with `react-dom/client` aliased to
 * `react-dom/profiling`, so fibers carry `actualDuration` for the benchmark's DevTools-hook shim.
 * Product code has no instrumentation, and no shipped build uses this file.
 *
 *   npx vite build --config packages/web/scripts/vite.profiling.config.ts
 *
 * Copy it to the same path in a baseline checkout to build that side the same way.
 */
import { mergeConfig } from 'vite'
import base from '../vite.config.ts'

export default mergeConfig(base, {
  resolve: { alias: [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }] },
})
