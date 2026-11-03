import { checkWorkspaceResolution } from '../../scripts/check-workspace-resolution.mjs'
import { defineConfig } from 'vitest/config'

checkWorkspaceResolution()

// Node environment on purpose: nothing in the contract may need a DOM to be tested, and a jsdom
// here would hide an accidental browser-only dependency in a package the Node service imports too.
export default defineConfig({
  test: {
    name: 'contract',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
