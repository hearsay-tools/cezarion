import { RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { AgentBrowser, bootProjectId, squawkCli, fixtureServeEnv } from './agent-browser'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { recordedRun, seedRuns } from './seed-runs'
import { waitForStatus } from './poll'
import recordJson from './fixtures/thread-run.record.json'
// fixture-server starts: 1

const record = { ...recordedRun(recordJson), pullRequestUrl: undefined }
const RECOVERY = 'cccccccc-1111-4222-8333-dddddddddddd'
const MANUAL = 'eeeeeeee-1111-4222-8333-ffffffffffff'
let browser: AgentBrowser
let server: ChildProcess
let root: string
let oldRoot: string
let baseUrl: string
let project: string

beforeAll(async () => {
  oldRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-removed-root-'))
  root = `${oldRoot}-current`
  seedRuns(oldRoot, [
    { ...record, id: RECOVERY, title: 'Recover after moving the repository', status: RUN_STATUS.running, finishedAt: undefined,
      worktreePath: join(oldRoot, '.ai/cezar/worktrees', RECOVERY), steps: [record.steps[0]!] },
    { ...record, id: MANUAL, title: 'Continue after moving the repository',
      worktreePath: join(oldRoot, '.ai/cezar/worktrees', MANUAL), steps: [record.steps[0]!] },
  ])
  renameSync(oldRoot, root)
  server = spawnFixtureServer([squawkCli, 'serve', '--repo', root, '--port', '0', '--no-open'],
    { env: fixtureServeEnv(root), stdio: ['ignore', 'pipe', 'pipe'] })
  baseUrl = await waitForFixtureServer(server)
  project = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(`e2e-removed-root-${process.pid}`)
}, 120_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (root) rmSync(root, { recursive: true, force: true })
  if (oldRoot) rmSync(oldRoot, { recursive: true, force: true })
})

it('recovers and continues stored sessions whose old repository root is gone', async () => {
  await waitForStatus(baseUrl, RECOVERY, ['waiting'], { timeoutMs: 15_000 })
  // Both missing checkouts use the repository root. Finish recovery to release its root lease.
  const finish = await fetch(`${baseUrl}/api/v1/runs/${RECOVERY}/finish`, { method: 'POST' })
  expect(finish.ok).toBe(true)
  await waitForStatus(baseUrl, RECOVERY, ['done', 'review'])
  browser.goto(`${baseUrl}/p/${project}/tasks/${MANUAL}`)
  browser.waitForFunction(`document.querySelector('[aria-label="Continue"]')?.disabled === false`)
  browser.fill('[data-slot="composer"] textarea', 'Continue this task after moving the repository.')
  browser.click('[aria-label="Send"]')
  await waitForStatus(baseUrl, MANUAL, ['waiting'], { timeoutMs: 15_000 })
  browser.waitForFunction(`document.querySelector('[data-slot="composer"] textarea')?.disabled === false`)
  expect(existsSync(oldRoot)).toBe(false)
})
