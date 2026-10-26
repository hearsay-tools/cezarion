// Counts the test files Stryker's dry run would execute for some mutated files. Stryker selects them
// with Vitest's related mode, so this asks Vitest the same question and runs nothing. STRYKER_PROJECT
// names the package project (vitest.stryker.config.ts). The last stdout line is {"count": N}.
// Advisory job helper: mutants-run.cjs uses the count to skip a package whose tests are too many.
import { resolve } from 'node:path'
import { createVitest } from 'vitest/node'

const files = process.argv.slice(2).map(file => resolve(file))
const vitest = await createVitest('test', { config: 'vitest.stryker.config.ts', watch: false, reporters: [] })
try {
  vitest.config.related = files
  const specifications = await vitest.getRelevantTestSpecifications()
  console.log(JSON.stringify({ count: specifications.length }))
} finally {
  await vitest.close()
}
