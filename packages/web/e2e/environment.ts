import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { tmpdirExceedsSocketBudget } from '../../../.ai/scripts/resolve-browser-launch.mjs'

const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '../../..')

const TEMP_KEYS = ['TMPDIR', 'TMP', 'TEMP'] as const

/**
 * Point TMPDIR/TMP/TEMP at a fresh short directory under /tmp when this caller's own temp dir
 * would overflow Chrome's SingletonSocket path. Returns the release: restore the previous values
 * (deleting the ones that were unset) and remove the directory. A no-op otherwise.
 */
export function useSocketSafeTmpdir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): () => void {
  if (!tmpdirExceedsSocketBudget(env, platform)) return () => {}
  const dir = mkdtempSync('/tmp/cez-e2e-')
  const previous = TEMP_KEYS.map((key) => [key, env[key]] as const)
  for (const key of TEMP_KEYS) env[key] = dir
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Prepare browser E2E even when Vitest is driven directly by Squeal. */
export async function setup(): Promise<() => void> {
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
    browser?: { installed?: boolean; notes?: string }
  }
  if (descriptor.browser?.installed !== true) {
    throw new Error(`Browser E2E could not run: ${descriptor.browser?.notes ?? 'browser unavailable'}`)
  }
  // Chrome and the Vitest workers need a socket-safe TMPDIR, decided from THIS caller's env:
  // the descriptor's runtimeEnv is the answer for whoever booted the shared env, which may have
  // had a short TMPDIR when ours is long, or the reverse (hearsay-tools/cezarion#1090). Only
  // after test-env-up.sh: a server it cold-boots inherits our env and outlives this run, so it
  // must never get a directory the teardown below deletes.
  return useSocketSafeTmpdir()
}
