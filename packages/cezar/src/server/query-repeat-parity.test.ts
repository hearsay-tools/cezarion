import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProviderAuthService } from '../core/provider-auth.ts'
import { RunStore } from '../runs/store.ts'
import type { RunManager } from '../workflows/run.ts'
import { createApp } from './server.ts'
import { apiRequest } from './loopback-request.testkit.ts'

/**
 * Moving the query string onto `queryZodValidator` changed one thing on the wire that nothing
 * else notices: Hono hands a REPEATED key to the validator as an array (`?wait=1&wait=1` →
 * `['1','1']`), where the `c.req.query('k')` these routes used before silently took the first
 * value. A plain `z.string()` therefore turns a request that answered 200 into a 400.
 *
 * `queryValue` in server.ts collapses the array back to its first element. One strict route and
 * one permissive route are enough to pin it — every query schema shares that helper. `/skills`
 * would exercise it too, but adds no coverage of the shared query helper. For
 * `/providers/status`, inject a no-spawn auth service so the parity check never waits on real CLIs.
 */
describe('a repeated query key stays 200 (c.req.query took the first value)', () => {
  let repoRoot: string
  let app: ReturnType<typeof createApp>
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-rq-'))
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true })
    app = createApp({
      repoRoot, store: RunStore.open(join(repoRoot, '.ai/cezar')),
      manager: {} as RunManager, version: '0.0.0-test',
      providerAuth: new ProviderAuthService({
        platform: 'linux',
        runCommand: async () => ({ stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 }),
      }),
    })
  })
  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }))

  it.each([
    ['/api/v1/models?runner=codex&runner=codex'],
    ['/api/v1/providers/status?refresh=1&refresh=1'],
  ])('%s is not a 400', async (url) => {
    const res = await apiRequest(app, url)
    expect(res.status).not.toBe(400)
  })
})
