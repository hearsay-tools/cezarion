import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { acquireTestEnvLease } from '../../../.ai/scripts/test-env-lease.mjs'
import { setup as pinWorkspaceRegistry } from './workspace-registry.ts'
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

/** Prepare browser E2E even when Vitest is driven directly by Squeal.
 * Provenance: hearsay-tools/cezarion#1304. A local reproduction on main
 * 049628d0d ran the actual try_reuse/teardown_stale functions against a live
 * temporary HTTP server: stale TTL changed HTTP 200 to ECONNREFUSED while its
 * caller was active. The launcher regression pins that replacement boundary.
 * With the lease, two concurrent smoke.e2e.ts invocations (second TTL=1),
 * and a separate --force pair, each passed 24 tests / 1 skip after queueing.
 * This setup applies the same lifetime protection to direct Vitest/Squeal.
 */
export async function setup(): Promise<() => void> {
  const previousToken = process.env.TEST_ENV_LEASE_TOKEN
  const lease = await acquireTestEnvLease(root, {
    ...(previousToken === undefined ? {} : { token: previousToken }),
    onWait: message => console.error(`[test-env] ${message}`),
  })
  process.env.TEST_ENV_LEASE_TOKEN = lease.token
  let restoreTmpdir = () => {}
  let restoreRegistry = () => {}
  const release = () => {
    try { restoreRegistry() }
    finally {
      try { restoreTmpdir() }
      finally {
        if (previousToken === undefined) delete process.env.TEST_ENV_LEASE_TOKEN
        else process.env.TEST_ENV_LEASE_TOKEN = previousToken
        lease.release()
      }
    }
  }
  try {
    // The wrapper already bootstrapped with its requested --server-env flags. Booting
    // again here would discard those flags, and could replace our own server at the TTL.
    if (!(previousToken && process.env.TEST_ENV_LEASE_BOOTSTRAPPED === '1')) {
      const { stdout, stderr } = await exec('sh', [resolve(root, '.ai/scripts/test-env-up.sh')], {
        cwd: root,
        timeout: 300_000,
        maxBuffer: 8 * 1024 * 1024,
      })
      if (stdout.trim()) console.log(stdout.trim())
      if (stderr.trim()) console.error(stderr.trim())
    }
    const descriptor = JSON.parse(await readFile(resolve(root, '.ai/qa/test-env.json'), 'utf8')) as {
      browser?: { installed?: boolean; notes?: string }
    }
    if (descriptor.browser?.installed !== true) {
      throw new Error(`Browser E2E could not run: ${descriptor.browser?.notes ?? 'browser unavailable'}`)
    }
    // Decide from THIS caller's TMPDIR only after boot: the detached server must not
    // inherit a temporary directory that test teardown later removes.
    restoreTmpdir = useSocketSafeTmpdir()
    restoreRegistry = await pinWorkspaceRegistry()
    return release
  } catch (cause) {
    release()
    throw new Error('Browser E2E environment bootstrap failed', { cause })
  }
}
