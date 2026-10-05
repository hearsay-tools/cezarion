import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { waitForSettledSample } from './visual-ready'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'

// A sidebar row's meta line truncates with an ellipsis, and Chromium keeps hit-testing a reference
// chip the ellipsis hid. A click on the blank space right of the `…` opened that hidden reference
// instead of the task's session. Real CSS and a real pointer: jsdom has neither layout nor paint.
const id = 'ellipsis-row'
const row = `[data-slot="task-row"][data-run-id="${id}"]`
const meta = `${row} [data-slot="task-row-meta"]`
const originalArgs = process.env.AGENT_BROWSER_ARGS
let browser: AgentBrowser
let server: ChildProcess
let root: string
let base: string
let project: string

beforeAll(async () => {
  // References are links only where the pointer can hover (#617 01b). Headless Linux Chrome
  // reports a primary pointer that cannot, which would render them as inert text.
  process.env.AGENT_BROWSER_ARGS = [originalArgs, '--blink-settings=primaryHoverType=2'].filter(Boolean).join(',')
  root = mkdtempSync(join(tmpdir(), 'cez-ellipsis-click-'))
  mkdirSync(join(root, '.ai/cezar'), { recursive: true })
  const finished = new Date(Date.now() - 60 * 60_000).toISOString()
  // Three references with long numbers: wider than the default 264px column's meta line.
  writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify([{
    id, title: 'Designing remote MCP operations', task: 'Designing remote MCP operations', workflow: 'quick-task',
    runner: 'claude', status: 'failed', createdAt: finished, finishedAt: finished, tokensUsed: 0, archived: false, pinned: true,
    pullRequestUrl: 'https://github.com/o/r/pull/47240001',
    referencedPullRequestUrl: 'https://github.com/o/r/pull/47120002',
    referencedIssueUrl: 'https://github.com/o/r/issues/46390003',
    steps: [{ id: 'task', name: 'Task', kind: 'agent', status: 'failed', iterations: 1, tokensUsed: 0, sessionId: 'ellipsis-fixture' }],
  }]))
  server = spawnFixtureServer([cezarCli, 'serve', '--repo', root, '--port', '0', '--no-open'], {
    env: fixtureServeEnv(root, { CEZ_SKILLS_AUTO_UPDATE: '0' }), stdio: 'ignore',
  })
  base = await waitForFixtureServer(server)
  project = await bootProjectId(base)
  browser = AgentBrowser.open(`sidebar-ellipsis-click-${process.pid}`)
  browser.setViewport(1440, 900)
}, 90_000)

afterAll(async () => {
  browser?.close()
  if (originalArgs === undefined) delete process.env.AGENT_BROWSER_ARGS
  else process.env.AGENT_BROWSER_ARGS = originalArgs
  await stopFixtureServer(server)
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('sidebar meta line ellipsis', () => {
  it('a click right of the `…` opens the session, not the reference the ellipsis hid', () => {
    browser.goto(`${base}/p/${project}`)
    // Settled, not first truth: the web font changes every width on the line, and the marks follow
    // it a ResizeObserver callback later. The line overflows, so the ellipsis hid a reference.
    const point = waitForSettledSample<{ hover: boolean; x: number; y: number; hit: string | null; firstChip: string | null; hidden: string[] }>(browser, `(() => {
      const line = document.querySelector(${JSON.stringify(meta)})
      const chip = line?.querySelector('[data-slot="pr-chip"]')
      if (!line || !chip || line.scrollWidth <= line.clientWidth) return null
      const box = line.getBoundingClientRect(), first = chip.getBoundingClientRect()
      const x = Math.round(box.right - 2), y = Math.round(box.top + box.height / 2)
      const at = (px, py) => document.elementFromPoint(px, py)?.closest('a')?.getAttribute('href') ?? null
      const hidden = [...line.querySelectorAll(':scope > [data-ellipsis-hidden]')].map((el) => el.getAttribute('href') ?? el.textContent)
      return { hover: matchMedia('(hover: hover)').matches, x, y, hit: at(x, y), firstChip: at(first.left + first.width / 2, first.top + first.height / 2), hidden }
    })()`, undefined, meta)
    expect(point.hover, 'references are links only under a hover-capable pointer').toBe(true)
    // The reference the line still paints stays a link; the space behind the ellipsis is the row.
    expect(point.firstChip, `marked hidden: ${point.hidden.join(', ')}`).toBe('https://github.com/o/r/pull/47240001')
    expect(point.hit).toBeNull()
    browser.tapAt(point.x, point.y)
    const path = browser.waitForValue<string>(`location.pathname`, (value) => value.endsWith(`/tasks/${id}`))
    expect(path).toBe(`/p/${project}/tasks/${id}`)
  }, 60_000)
})
