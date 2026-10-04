import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { stopFixtureServer } from './fixture-server'
import { waitForHealth } from './poll'
import { settleVisual } from './visual-ready'

// Real publication output, two registered projects and real disk-backed task records.
// No request stubs: the browser must retrieve the owner's snapshot through the scoped API.
const ownerRun = randomUUID()
const bootRun = randomUUID()
const evidenceDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_issue-776')
let root: string
let baseUrl: string
let server: ChildProcess
let browser: AgentBrowser
let publication: { id: string; link: string; markdown: string }
let bootPublication: { id: string; link: string }

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cez-artifact-projects-'))
  const boot = join(root, 'boot')
  const owner = join(root, 'owner')
  for (const project of [boot, owner]) {
    execFileSync('git', ['init', '-q', '-b', 'main', project])
    mkdirSync(join(project, '.ai/cezar/runs'), { recursive: true })
  }
  const env = fixtureServeEnv(boot)
  mkdirSync(env.CEZ_HOME!, { recursive: true })
  writeFileSync(join(env.CEZ_HOME!, 'config.json'), JSON.stringify({ projects: [
    { id: 'boot', root: boot }, { id: 'owner', root: owner },
  ] }))
  const source = join(root, 'owned-report.md')
  writeFileSync(source, '# Owning project snapshot\n\nPublished outside both project roots.\n')
  const publish = (project: string, runId: string) => JSON.parse(execFileSync(process.execPath,
    [cezarCli, 'artifact', 'publish', source], {
      // Deliberately publish from the boot cwd even when the owner is the other project.
      cwd: boot, env: { ...env, CEZ_TASK_ID: runId, CEZ_ARTIFACTS_DIR: join(project, '.ai/cezar/runs', `${runId}-artifacts`) },
      encoding: 'utf8',
    }))
  publication = publish(owner, ownerRun)
  bootPublication = publish(boot, bootRun)
  rmSync(source)
  for (const [project, id] of [[owner, ownerRun], [boot, bootRun]]) {
    const run: RunRecord = {
      id: id!, task: publication.markdown, title: 'Published artifact link', workflow: 'quick-task',
      status: 'done', archived: false, createdAt: '2026-10-04T08:00:00Z', tokensUsed: 0, steps: [],
    }
    writeFileSync(join(project!, '.ai/cezar/runs.json'), JSON.stringify([run]))
  }
  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(join(evidenceDir, 'publication.json'), JSON.stringify(publication, null, 2))
  const probe = createServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = (probe.address() as { port: number }).port
  await new Promise<void>(done => probe.close(() => done()))
  baseUrl = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', boot, '--port', String(port), '--no-open'], { env, stdio: 'ignore' })
  await waitForHealth(baseUrl, 'artifact project ownership fixture')
  expect(await bootProjectId(baseUrl)).toBe('boot')
  browser = AgentBrowser.open(`artifact-projects-${process.pid}`)
  browser.setViewport(1440, 900)
}, 120_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (root) rmSync(root, { recursive: true, force: true })
})

function expectOwnerPreview() {
  const text = browser.waitForValue<string>(`document.querySelector('[data-slot="file-preview"]')?.textContent`, value => typeof value === 'string' && value.includes('Published outside both project roots.'))
  expect(text).toContain('Owning project snapshot')
  expect(browser.url()).toBe(baseUrl + publication.link)
  expect(browser.evaluate(`document.querySelector('[data-slot="file-preview"] a[href$="/download"]')?.getAttribute('href')`))
    .toBe(`/api/v1/p/owner/runs/${ownerRun}/artifacts/${publication.id}/download`)
}

it.each([['owner', ownerRun], ['boot', bootRun]])('retains identical publication Markdown in the %s project thread', (project, runId) => {
  expect(publication.link).toBe(`/p/owner/tasks/${ownerRun}/files?artifact=${publication.id}`)
  browser.goto(`${baseUrl}/p/${project}/tasks/${runId}`)
  const selector = '[data-slot="user-bubble"] a[data-streamdown="link"]'
  const href = browser.waitForValue<string>(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('href')`)
  expect(href).toBe(publication.link)
  // Scoped links keep the cockpit's existing confirmation/new-tab semantics.
  browser.click(selector)
  browser.waitForFunction(`document.querySelector('[data-slot="link-safety-dialog"]') !== null`)
  expect(browser.text('[data-slot="link-safety-url"]')).toBe(publication.link)
  // Follow the real rendered destination in this tab. agent-browser 0.36 cannot attach
  // to a noreferrer popup (even a plain health-page anchor times out in Page.enable).
  // Keep the destination and preview assertions independent of that provider failure.
  browser.goto(baseUrl + href)
  expectOwnerPreview()
  settleVisual(browser, '[data-slot="file-preview"]')
  browser.screenshot(join(evidenceDir, `${project}-thread-preview.png`))
})

it('reopens the copied publication URL without task context', () => {
  browser.goto(`${baseUrl}/p/boot/`)
  browser.waitForFunction(`location.pathname === '/p/boot/'`)
  browser.goto(baseUrl + publication.link)
  expectOwnerPreview()
})

it('opens boot publications and supported legacy flat URLs', () => {
  expect(bootPublication.link).toBe(`/p/boot/tasks/${bootRun}/files?artifact=${bootPublication.id}`)
  for (const link of [bootPublication.link, `/tasks/${bootRun}/files?artifact=${bootPublication.id}`]) {
    browser.goto(baseUrl + link)
    const text = browser.waitForValue<string>(`document.querySelector('[data-slot="file-preview"]')?.textContent`, value => typeof value === 'string' && value.includes('Published outside both project roots.'))
    expect(text).toContain('Owning project snapshot')
    expect(browser.url()).toBe(baseUrl + bootPublication.link)
  }
})
