import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '../../..')

/** Prepare browser E2E even when Vitest is driven directly by Squeal. */
export async function setup(): Promise<void> {
  try {
    const { stdout, stderr } = await exec('sh', [resolve(root, '.ai/scripts/test-env-up.sh')], {
      cwd: root,
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    if (stdout.trim()) console.log(stdout.trim())
    if (stderr.trim()) console.error(stderr.trim())
  } catch (cause) {
    throw new Error('Browser E2E environment bootstrap failed', { cause })
  }

  const descriptor = JSON.parse(await readFile(resolve(root, '.ai/qa/test-env.json'), 'utf8')) as {
    browser?: { installed?: boolean; notes?: string; runtimeEnv?: Record<string, unknown> }
  }
  if (descriptor.browser?.installed !== true) {
    throw new Error(`Browser E2E could not run: ${descriptor.browser?.notes ?? 'browser unavailable'}`)
  }
  // Match e2e.sh: Chrome and the Vitest workers must use the provider's scratch paths.
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
    const value = descriptor.browser.runtimeEnv?.[key]
    if (typeof value === 'string' && value) process.env[key] = value
  }
}
