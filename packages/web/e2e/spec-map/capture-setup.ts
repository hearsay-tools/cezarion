import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { beforeAll } from 'vitest'

import { captureBrowserArgs } from './v8-log.ts'

/**
 * Spec-map capture (hearsay-tools/cezarion#1816). Only `spec-map/vitest.config.ts` loads this file;
 * `npm run test:e2e` never does.
 *
 * Before each spec, it points every browser the spec launches at a V8 function-event log under
 * `$E2E_SPEC_MAP_LOG_DIR/<spec>/`. The seam passes `AGENT_BROWSER_ARGS` to Chrome at launch, and
 * every spec opens its own session, so each log holds one spec's evidence. `--no-sandbox` lets
 * the renderer write the log file.
 */

// A worker that runs several specs imports this file once per spec; keep the caller's own value.
const INHERITED = Symbol.for('cezar.spec-map.inherited-browser-args')
const scope = globalThis as { [INHERITED]?: string }
scope[INHERITED] ??= process.env.AGENT_BROWSER_ARGS ?? ''

beforeAll(({}, suite) => {
  const root = process.env.E2E_SPEC_MAP_LOG_DIR
  if (!root) throw new Error('spec-map capture: set E2E_SPEC_MAP_LOG_DIR to the directory for the V8 logs')
  const filepath = 'filepath' in suite ? suite.filepath : suite.file.filepath
  const dir = join(root, basename(filepath, '.e2e.ts'))
  mkdirSync(dir, { recursive: true })
  process.env.AGENT_BROWSER_ARGS = captureBrowserArgs(scope[INHERITED] ?? '', dir)
})
