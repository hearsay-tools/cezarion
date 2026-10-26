// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'

// hearsay-tools/cezarion#1816: capture-setup.ts points each spec's browser at its own V8 log.
// Importing it registers its beforeAll for this file, as the capture config does for each spec.
const logs = mkdtempSync(join(tmpdir(), 'cez-spec-map-capture-'))
const inherited = process.env.AGENT_BROWSER_ARGS
process.env.E2E_SPEC_MAP_LOG_DIR = logs
process.env.AGENT_BROWSER_ARGS = '--lang=en'
await import('../../e2e/spec-map/capture-setup')

afterAll(() => {
  delete process.env.E2E_SPEC_MAP_LOG_DIR
  if (inherited === undefined) delete process.env.AGENT_BROWSER_ARGS
  else process.env.AGENT_BROWSER_ARGS = inherited
  rmSync(logs, { recursive: true, force: true })
})

it('points the browser at a log directory named after the running file and keeps the inherited arguments', () => {
  const dir = join(logs, 'e2e-spec-map-capture.test.ts')
  expect(existsSync(dir)).toBe(true)
  expect(process.env.AGENT_BROWSER_ARGS).toBe(`--lang=en,--no-sandbox,--js-flags=--log-function-events --logfile=${dir}/v8.log`)
})
