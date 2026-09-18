import { basename } from 'node:path'
import { beforeAll, beforeEach } from 'vitest'

import { configureFailureCapture, lastAttachedBrowser } from './agent-browser'

/**
 * Failure bundles for every spec (#408), registered once here rather than in each file.
 *
 * Two jobs. First, tell the seam which `<spec>/<test>` is running, so a wait that times out
 * inside it writes its bundle under the right name — the seam imports nothing from vitest, so
 * this file is the only place the two meet. Second, give a plain `expect` failure the same
 * evidence a timed-out wait gets: `onTestFailed` reaches the browser through the last attached
 * seam and writes the bundle, and the seam declines when the test already has one from a wait.
 *
 * `beforeAll` runs before any spec-level `beforeAll`, so a wait that gives up while a spec is
 * still opening its browser lands under `<spec>/hooks-<n>` instead of `unknown-spec`. There is
 * deliberately no `afterEach` renaming the test back: vitest runs `afterEach` before
 * `onTestFailed`, so a rename there made the hook see a different test than the wait did and
 * write a second bundle for the same failure. The next test's `beforeEach` renames instead, and
 * a failure in a spec's own `afterAll` is attributed to its last test, which is where it
 * belongs.
 */
const specName = (file: string) => basename(file).replace(/\.e2e\.ts$/, '')

beforeAll(({}, suite) => {
  const filepath = 'filepath' in suite ? suite.filepath : suite.file.filepath
  configureFailureCapture({ spec: specName(filepath), test: 'hooks' })
})

beforeEach((context) => {
  const name = { spec: specName(context.task.file.filepath), test: context.task.name }
  configureFailureCapture(name)
  context.onTestFailed(({ task }) => {
    const browser = lastAttachedBrowser()
    if (!browser) return
    // Re-assert the name: the hook runs after the spec's own `afterEach`, which may have
    // driven the browser and must not move this test's bundle under a later name.
    configureFailureCapture(name)
    const bundle = browser.captureTestFailure(task.result?.errors ?? [])
    if (bundle) console.error(`cezar e2e: failure bundle for "${task.name}" at ${bundle}`)
  })
})
