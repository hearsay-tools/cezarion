import { projectPaths, runDataDir } from '../../cezar/src/project-paths.ts'
import { productCommand } from './product'
import { Home } from '../../cezar/src/home/home.ts';
import { execFileSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { backup, DatabaseSync } from 'node:sqlite'
import { basename, join } from 'node:path'
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { seedRuns } from './seed-runs'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { seedTranscript } from './seed-transcript'
import { focusWithKeyboard, contrastSampleExpression } from './contrast'
import { settleVisual, waitForSettledSample } from './visual-ready'
// fixture-server starts: 2

let root: string, baseUrl: string, server: ChildProcess, browser: AgentBrowser
const runIds = Array.from({ length: 25 }, () => randomUUID())
const ids = Array.from({ length: 25 }, () => randomUUID())
const LIST = '[data-slot="reports-list"]'
const ROW = '[data-slot="report-row"]'
const FRAME = '[data-slot="html-report-frame"]'
const path = '/p/shelf/reports'

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-reports-browser-')))
  const project = join(root, 'project'), empty = join(root, 'empty')
  for (const folder of [project, empty]) execFileSync('git', ['init', '-q', '-b', 'main', folder])
  // seedRuns writes the legacy `.ai/cezar` import file, so the project is a legacy one from the
  // start in both switch states; the CLI publish below must not open a fresh `.ai/squawk` first.
  const dir = join(project, '.ai/cezar/runs')
  mkdirSync(dir, { recursive: true })
  const env = fixtureServeEnv(project)
  mkdirSync(env.CEZ_HOME!, { recursive: true })
  const home = Home.sandbox(env.CEZ_HOME!)
  Home.seedBytes(home, home.workspaceConfig, Buffer.from(JSON.stringify({ projects: [{ id: 'shelf', root: project }, { id: 'empty', root: empty }] })))
  const source = join(root, 'quarterly.html')
  writeFileSync(source, '<title>Quarterly report</title><h1>Published results</h1>')
  const publication = JSON.parse(execFileSync(process.execPath, [cezarCli, 'artifact', 'publish', source], {
    cwd: project, env: { ...env, CEZ_PROJECT_ID: 'shelf', CEZ_TASK_ID: runIds[0], CEZ_ARTIFACTS_DIR: join(dir, `${runIds[0]}-artifacts`) }, encoding: 'utf8',
  })) as { artifact: { sha256: string; size: number }; id: string }
  // The first snapshot uses the real CLI. Seed the remaining owned snapshots explicitly:
  // each is a different task/id with the same filename and bytes, and a known publication date.
  const { createHash } = await import('node:crypto')
  const content = '<title>Quarterly report</title><h1>Published results</h1>'
  for (const [i, runId] of runIds.entries()) {
    const artifact = join(dir, `${runId}-artifacts`, ids[i]!)
    mkdirSync(artifact, { recursive: true })
    writeFileSync(join(artifact, 'content'), content)
    writeFileSync(join(artifact, 'metadata.json'), JSON.stringify({ id: ids[i], runId, name: 'quarterly.html', sourcePath: source,
      createdAt: new Date(Date.UTC(2026, 10, 1, 12, i)).toISOString(), size: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') }))
  }
  // Keep exactly the seeded rows, even though the CLI published one additional valid id.
  rmSync(join(dir, `${runIds[0]}-artifacts`, publication.id), { recursive: true })
  const runs = runIds.map((id, i) => makeRunRecord({ id, title: i === 9 ? 'Source task nine' : `Source task ${String(i).padStart(2, '0')}`, task: 'Published report', status: RUN_STATUS.done }))
  seedRuns(project, runs)
  seedTranscript(join(dir, `${runIds[14]}.ndjson`), JSON.stringify({
    seq: 1, ts: '2026-11-01T12:14:00Z', type: 'item.completed',
    item: { kind: 'message', id: 'shelf-integration-message', role: 'assistant',
      text: `Published results: [Quarterly report](/p/shelf/tasks/${runIds[14]}/files?artifact=${ids[14]})` },
  }) + '\n')
  rmSync(source)
  server = spawnFixtureServer([cezarCli, 'serve', '--repo', project, '--port', '0', '--no-open'], { env })
  baseUrl = await waitForFixtureServer(server)
  expect(await bootProjectId(baseUrl)).toBe('shelf')
  browser = AgentBrowser.open(`reports-${process.pid}`)
}, 120_000)
afterAll(async () => { browser?.close(); await stopFixtureServer(server); if (root) rmSync(root, { recursive: true, force: true }) })

it('lists same-name reports, searches source tasks, opens the reader and restores search, scroll and row focus', () => {
  browser.setViewport(1440, 900)
  browser.goto(baseUrl + path + '?q=quarterly')
  browser.waitForFunction(`document.querySelectorAll('${ROW}').length === 25`)
  expect(browser.waitForValue(`document.querySelector('${ROW}').textContent`)).toContain('Source task 24')
  const selector = `[data-report-id="${ids[14]}"]`
  browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`)
  const scroll = browser.waitForValue<number>(`document.querySelector('${LIST}').scrollTop`, n => n > 0)
  browser.click(selector)
  browser.waitForFunction(`document.querySelector('${FRAME}') !== null`)
  expect(browser.url()).toContain(`/tasks/${runIds[14]}/report?artifact=${ids[14]}`)
  browser.click('[data-slot="report-bar"] button[aria-label="Back"]')
  const restored = browser.waitForValue<{ scroll: number; focused: string }>(`(() => {
    const list = document.querySelector('${LIST}'); if (!list) return null;
    return { scroll: list.scrollTop, focused: document.activeElement?.getAttribute('data-report-id') };
  })()`, value => value?.focused === ids[14] && Math.abs(value.scroll - scroll) < 2)
  expect(restored.scroll).toBeCloseTo(scroll, 0)
  expect(browser.url()).toBe(baseUrl + path + '?q=quarterly')
  browser.fill('input[aria-label="Search reports"]', 'Source task nine')
  browser.waitForFunction(`document.querySelectorAll('${ROW}').length === 1`)
  browser.click(`${ROW} a[href$="/tasks/${runIds[9]}"]`)
  expect(browser.waitForValue('location.pathname')).toBe(`/p/shelf/tasks/${runIds[9]}`)
})

it.each(['light', 'dark'])('supports phone keyboard reading, contrast and 44 px targets in %s', theme => {
  browser.setViewport(360, 640)
  browser.goto(baseUrl + path + '?q=Source+task+nine')
  browser.evaluate(`localStorage.setItem('cezar-theme', ${JSON.stringify(theme)}); document.documentElement.classList.toggle('dark', ${theme === 'dark'})`)
  browser.waitForFunction(`document.querySelectorAll('${ROW}').length === 1`)
  settleVisual(browser, ROW)
  const sizes = waitForSettledSample<number[]>(browser, `[...document.querySelectorAll('${ROW} a, input[aria-label="Search reports"]')].map(a => a.getBoundingClientRect().height)`)
  expect(sizes.every(height => height >= 44)).toBe(true)
  const contrast = browser.waitForValue<{ ratio: number }>(contrastSampleExpression(`${ROW} h2`))
  expect(contrast.ratio).toBeGreaterThanOrEqual(4.5)
  focusWithKeyboard(browser, `[data-report-id="${ids[9]}"]`)
  browser.press('Enter')
  browser.waitForFunction(`document.querySelector('${FRAME}') !== null`)
  browser.click('[data-slot="report-bar"] button[aria-label="Back"]')
  browser.waitForFunction(`document.querySelector('${ROW}') !== null`)
  expect(browser.waitForValue('document.activeElement?.getAttribute("data-report-id")')).toBe(ids[9])
})

it('shows no matches, clears search, and isolates an empty project', () => {
  browser.goto(baseUrl + path + '?q=absent')
  browser.waitForFunction(`document.body.textContent.includes('No matching reports')`)
  browser.click('[data-slot="reports-clear-search"]')
  browser.waitForFunction(`document.querySelectorAll('${ROW}').length === 25`)
  browser.goto(baseUrl + '/p/empty/reports')
  browser.waitForFunction(`document.body.textContent.includes('No published reports yet')`)
  expect(browser.waitForValue(`document.querySelectorAll('${ROW}').length`)).toBe(0)
  expect(browser.waitForValue(`document.querySelector('[data-route="reports"]').textContent`)).toContain(`${productCommand} artifact publish`)
})

it('opens the same reader from a conversation card and the shelf, then returns to each source', () => {
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}/p/shelf/tasks/${runIds[14]}?thread=flat`)
  const read = '[data-slot="report-card"] a'
  const back = '[data-slot="report-bar"] button[aria-label="Back"]'
  browser.waitForFunction(`document.querySelector('${read}') !== null`)
  browser.click(read)
  browser.waitForFunction(`document.querySelector('[data-route="task-report"][data-variant="pane"] ${FRAME}') !== null`)
  const frame = `(() => {
    const reader = document.querySelector('[data-route="task-report"]');
    const frame = reader?.querySelector('${FRAME}');
    return frame && { reader: reader.dataset.route, frame: frame.dataset.slot,
      html: frame.getAttribute('srcdoc'), sandbox: frame.getAttribute('sandbox') };
  })()`
  const fromCard = browser.waitForValue(frame)
  browser.click(back)
  browser.waitForFunction(`document.querySelector('${FRAME}') === null && document.activeElement === document.querySelector('${read}')`)
  expect(browser.url()).toContain(`/tasks/${runIds[14]}?thread=flat`)

  browser.goto(baseUrl + path + '?q=quarterly')
  browser.waitForFunction(`document.querySelectorAll('${ROW}').length === 25`)
  const row = `[data-report-id="${ids[14]}"]`
  browser.evaluate(`document.querySelector('${row}').scrollIntoView({ block: 'center', behavior: 'instant' })`)
  const scroll = browser.waitForValue<number>(`document.querySelector('${LIST}').scrollTop`, n => n > 0)
  browser.click(row)
  browser.waitForFunction(`document.querySelector('[data-route="task-report"][data-variant="route"] ${FRAME}') !== null`)
  expect(browser.waitForValue(frame)).toEqual(fromCard)
  browser.click(back)
  browser.waitForFunction(`document.querySelector('${LIST}') !== null && document.activeElement?.getAttribute('data-report-id') === '${ids[14]}'`)
  expect(browser.url()).toBe(baseUrl + path + '?q=quarterly')
  expect(browser.waitForValue<number>(`document.querySelector('${LIST}').scrollTop`)).toBeCloseTo(scroll, 0)
})

it('shows a deleted snapshot as missing and drops reports after snapshot or task-history deletion', async () => {
  const deletionRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cez-report-deletion-')))
  let deletionServer: ChildProcess | undefined
  let deletionBrowser: AgentBrowser | undefined
  try {
    const project = join(deletionRoot, 'project')
    // The copy gets its own fixture homes: a copied Home keeps the source's migration marker.
    const fixtureHomes = ['.cez-home', '.server-home'].map(name => join(root, 'project', name))
    cpSync(join(root, 'project'), project, { recursive: true, filter: source => !fixtureHomes.includes(source)
      && !['runs.db', 'cockpit.lock'].some(prefix => basename(source).startsWith(prefix)) })
    const sourceData = projectPaths(join(root, 'project')).write
    const sourceDatabase = new DatabaseSync(join(sourceData, 'runs.db'), { readOnly: true })
    try {
      await backup(sourceDatabase, join(project, '.ai', basename(sourceData), 'runs.db'))
    } finally {
      sourceDatabase.close()
    }
    const env = fixtureServeEnv(project)
    mkdirSync(env.CEZ_HOME!, { recursive: true })
    const home = Home.sandbox(env.CEZ_HOME!)
    Home.seedBytes(home, home.workspaceConfig, Buffer.from(JSON.stringify({ projects: [{ id: 'shelf', root: project }] })))
    deletionServer = spawnFixtureServer([cezarCli, 'serve', '--repo', project, '--port', '0', '--no-open'], { env })
    const browser = deletionBrowser = AgentBrowser.open(`report-deletion-${process.pid}`)
    const baseUrl = await waitForFixtureServer(deletionServer)
    browser.goto(baseUrl + path)
    browser.waitForFunction(`document.querySelectorAll('${ROW}').length === 25`)
    // The tasks are done, not archived: after the boot's move they keep their artifacts in .ai/cezar/ (owner decision A).
    rmSync(join(runDataDir(projectPaths(project).write, runIds[0]!), 'runs', `${runIds[0]}-artifacts`, ids[0]!, 'content'))
    browser.click(`[data-report-id="${ids[0]}"]`)
    browser.waitForFunction(`document.body.textContent.includes('Report missing or deleted')`)
    browser.click('[data-slot="report-bar"] button[aria-label="Back"]')
    browser.waitForFunction(`document.querySelectorAll('${ROW}').length === 24`)
    const response = await fetch(`${baseUrl}/api/v1/p/shelf/runs/${runIds[1]}`, { method: 'DELETE' })
    expect(response.status).toBe(200)
    // The mounted shelf receives run-deleted and refetches through the shared debounce.
    browser.waitForFunction(`document.querySelectorAll('${ROW}').length === 23`)
    expect(browser.waitForValue(`document.querySelector('[data-report-id="${ids[1]}"]') === null`)).toBe(true)
  } finally {
    deletionBrowser?.close()
    await stopFixtureServer(deletionServer)
    rmSync(deletionRoot, { recursive: true, force: true })
  }
})
