import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { expect } from 'vitest'

import { captureBrowserArgs } from './v8-log.ts'

/**
 * Spec-map capture (hearsay-tools/cezarion#1816). Only `spec-map/vitest.config.ts` loads this file;
 * `npm run test:e2e` never does.
 *
 * Vitest runs this file before it imports each spec, and `expect.getState().testPath` names that
 * spec. It points every browser the spec launches at a V8 function-event log under
 * `$E2E_SPEC_MAP_LOG_DIR/<spec>/`. The seam passes `AGENT_BROWSER_ARGS` to Chrome at launch, and
 * every spec opens its own session, so each log holds one spec's evidence. The variable is set
 * here, before the spec's own module code runs: a spec that reads it at load and adds a flag of
 * its own, as `selection-states.e2e.ts` does, keeps the log flags. `--no-sandbox` lets the renderer
 * write the log file.
 */

// A worker that runs several specs imports this file once per spec; keep the caller's own value.
const INHERITED = Symbol.for('cezar.spec-map.inherited-browser-args')
const scope = globalThis as { [INHERITED]?: string }
scope[INHERITED] ??= process.env.AGENT_BROWSER_ARGS ?? ''

const root = process.env.E2E_SPEC_MAP_LOG_DIR
if (!root) throw new Error('spec-map capture: set E2E_SPEC_MAP_LOG_DIR to the directory for the V8 logs')
const spec = (expect.getState() as { testPath?: string }).testPath
if (!spec) throw new Error('spec-map capture: Vitest named no test file for this setup run')
const dir = join(root, basename(spec, '.e2e.ts'))
mkdirSync(dir, { recursive: true })
process.env.AGENT_BROWSER_ARGS = captureBrowserArgs(scope[INHERITED] ?? '', dir)
