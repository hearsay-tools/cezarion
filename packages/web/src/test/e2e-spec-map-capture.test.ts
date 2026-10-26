// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'

// hearsay-tools/cezarion#1816: capture-setup.ts points each spec's browser at its own V8 log.
// The capture config loads it before each spec, as this file loads it here.
const logs = mkdtempSync(join(tmpdir(), 'cez-spec-map-capture-'))
const inherited = process.env.AGENT_BROWSER_ARGS
process.env.E2E_SPEC_MAP_LOG_DIR = logs
process.env.AGENT_BROWSER_ARGS = '--lang=en'
await import('../../e2e/spec-map/capture-setup')
// What a spec module that reads the variable at load sees, as selection-states.e2e.ts does.
const atLoad = process.env.AGENT_BROWSER_ARGS

afterAll(() => {
  delete process.env.E2E_SPEC_MAP_LOG_DIR
  if (inherited === undefined) delete process.env.AGENT_BROWSER_ARGS
  else process.env.AGENT_BROWSER_ARGS = inherited
  rmSync(logs, { recursive: true, force: true })
})

it('points the browser at a log directory named after the spec before the spec module runs, keeping the inherited arguments', () => {
  const dir = join(logs, 'e2e-spec-map-capture.test.ts')
  expect(existsSync(dir)).toBe(true)
  expect(atLoad).toBe(`--lang=en,--no-sandbox,--js-flags=--log-function-events --logfile=${dir}/v8.log`)
})
