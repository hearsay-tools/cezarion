import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

import e2e from '../vitest.config.ts'

/**
 * The browser suite with spec-map capture on (hearsay-tools/cezarion#1816): the same specs,
 * sequencer, globalSetup and setup files as `npm run test:e2e`, plus `capture-setup.ts`.
 * The `E2E spec map` workflow runs it; `npm run test:e2e` keeps its own config.
 */
const base = e2e.test ?? {}
const setupFiles = typeof base.setupFiles === 'string' ? [base.setupFiles] : (base.setupFiles ?? [])

export default defineConfig({
  ...e2e,
  test: {
    ...base,
    name: 'e2e-spec-map',
    setupFiles: [...setupFiles, resolve(import.meta.dirname, 'capture-setup.ts')],
  },
})
