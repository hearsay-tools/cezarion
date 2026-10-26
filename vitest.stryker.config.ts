import { defineConfig } from 'vitest/config'

// The Vitest config that Stryker loads (stryker.config.json). It runs ONE package's unit
// project, named by STRYKER_PROJECT, never the root config: the dry run executes every test
// file that imports a mutated file, and across the four projects one line of
// packages/contract/src/attention.ts reaches 466 of 477 test files, where its own package's
// project reaches 4. Browser E2E (packages/web/e2e) is not a unit project and never runs here.
// `.github/scripts/mutants-scope.cjs` names the same four packages; its test pins the pair.
const PROJECTS = ['cezar', 'contract', 'api-client', 'web']
const project = process.env.STRYKER_PROJECT ?? ''

if (!PROJECTS.includes(project)) {
  throw new Error(`STRYKER_PROJECT must be one of ${PROJECTS.join(', ')}; got "${project}"`)
}

export default defineConfig({
  test: { projects: [`./packages/${project}/vitest.config.ts`] },
})
