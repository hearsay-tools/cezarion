import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { waitForSettledSample } from './visual-ready'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { stopFixtureServer } from './fixture-server'
import { AgentBrowser } from './agent-browser'
import { pollFor } from './poll'
import { contrastSampleExpression, focusWithKeyboard, type ContrastSample } from './contrast'

// Browser component coverage of the real wait details + production CSS. They moved from the run
// header into the Session activity card's status row (hearsay-tools/cezarion#1333). The parent integration
// suite owns server lifecycle/SSE evidence; this fixture deliberately needs no CI controller.
const webRoot = resolve(import.meta.dirname, '..')
const viteCli = resolve(dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin/vite.js')
// The fixture must sit under the Vite root to share its config and `./src` imports, but in a
// gitignored directory: a tracked-tree file would be a new worktree revision on every run.
const fixtureDir = resolve(webRoot, '.e2e-fixtures', `ci-header-${process.pid}`)
const artifacts = resolve(webRoot, '../../.ai/qa/artifacts_e2e/run-header-ci-wait')
const repository = `${'long-owner-'.repeat(3)}/${'long-repository-'.repeat(5)}`
type CiWait = Extract<NonNullable<ApiRun['waits']>[number], { kind: 'pr' }>
type TimerWait = Extract<NonNullable<ApiRun['waits']>[number], { kind: 'timer' }>
const wait: CiWait = {
  id: '00000000-0000-4000-8000-000000000474', kind: 'pr', source: 'agent', via: 'cezar_wait',
  generation: 'generation', turnId: 'turn', timeoutSeconds: 1800, until: 'checks' as const, wakeOnConflict: true,
  repository, prNumber: 474, prUrl: 'https://github.com/owner/repo/pull/474',
  headSha: '123456789abcdef', registeredAt: '2026-09-22T12:00:00.000Z',
  deadline: '2026-09-22T12:30:00.000Z', phase: 'open',
}
const timer: TimerWait = {
  id: '00000000-0000-4000-8000-000000000005', kind: 'timer', source: 'agent', via: 'cezar_wait',
  turnId: 'turn', seconds: 300, registeredAt: '2026-09-22T12:00:00.000Z',
  deadline: '2026-09-22T12:05:00.000Z', phase: 'open',
  note: `Re-check ${'the-staging-deployment-'.repeat(4)}after the migration finishes`,
}
const run: ApiRun = {
  id: 'ci-browser', task: 'Wait for checks', title: 'Wait for checks', workflow: 'quick-task',
  status: 'waiting', createdAt: wait.registeredAt,
  archived: false, tokensUsed: 0, steps: [], waits: [wait],
}
let browser: AgentBrowser
let server: ChildProcess
let url: string
const status = '[data-slot="ci-wait-status"]'
const link = `${status} a`

beforeAll(async () => {
  mkdirSync(artifacts, { recursive: true })
  mkdirSync(fixtureDir, { recursive: true })
  writeFileSync(resolve(fixtureDir, 'index.html'), `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>`)
  writeFileSync(resolve(fixtureDir, 'fixture.tsx'), `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { QueryClientProvider } from '@tanstack/react-query';
    import { MemoryRouter } from 'react-router';
    import { createQueryClient } from '../../src/api/query-client';
    import { RunWaitDetails } from '../../src/routes/task-thread/run-waits';
    import '../../src/styles/index.css';
    window.fetch = async input => {
      const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
      return new Response(JSON.stringify(path.endsWith('/run-summaries') ? [] : {}), {headers: {'content-type': 'application/json'}});
    };
    const client = createQueryClient();
    function Fixture() {
      const [run, setRun] = useState(${JSON.stringify(run)});
      window.setCiRun = setRun;
      return <QueryClientProvider client={client}><MemoryRouter><main className="h-dvh min-w-0 overflow-y-auto p-4"><RunWaitDetails run={run} /></main></MemoryRouter></QueryClientProvider>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  `)
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = (probe.address() as { port: number }).port
  await new Promise<void>(done => probe.close(() => done()))
  url = `http://127.0.0.1:${port}/.e2e-fixtures/ci-header-${process.pid}/index.html`
  server = spawn(process.execPath, [viteCli, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: webRoot, stdio: 'ignore' })
  await pollFor(async signal => (await fetch(url, { signal })).ok || undefined,
    () => 'CI header browser fixture did not start', { tries: 60 })
  browser = AgentBrowser.open(`ci-header-${process.pid}`)
  browser.goto(url)
  browser.waitForFunction(`Boolean(document.querySelector('${link}'))`)
})

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  rmSync(fixtureDir, { recursive: true, force: true })
})

describe('CI header browser accessibility', () => {
  for (const theme of ['light', 'dark']) {
    for (const width of [360, 1440]) {
      for (const zoom of [1, 2]) {
        it(`${theme}, ${width}px, ${zoom * 100}% zoom: wraps and exposes a readable 44px keyboard target`, () => {
          browser.setViewport(width, width === 360 ? 640 : 900)
          browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'}); document.documentElement.style.zoom = '${zoom}'`)
          browser.waitForFunction(`document.querySelector('${link}').getBoundingClientRect().height >= 44`)
          const geometry = waitForSettledSample(browser, `(() => {
            const el = document.querySelector('${link}');
            const rect = el.getBoundingClientRect();
            return {height: rect.height, width: rect.width, left: rect.left, right: rect.right,
              viewport: innerWidth, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth};
          })()`) as { height: number; width: number; left: number; right: number; viewport: number; overflow: boolean }
          expect(geometry.height).toBeGreaterThanOrEqual(44)
          expect(geometry.width).toBeGreaterThanOrEqual(44)
          expect(geometry.left).toBeGreaterThanOrEqual(0)
          expect(geometry.right).toBeLessThanOrEqual(geometry.viewport)
          expect(geometry.overflow).toBe(false)
          focusWithKeyboard(browser, link)
          browser.waitForFunction(`document.activeElement === document.querySelector('${link}')`)
          expect(browser.evaluate(`window.scrollX`)).toBe(0)
          expect(waitForSettledSample(browser, `document.querySelector('${link}').getBoundingClientRect().left >= 0`)).toBe(true)
          const contrast = browser.evaluate(contrastSampleExpression(link)) as ContrastSample
          expect(contrast.ratio).toBeGreaterThanOrEqual(4.5)
          expect(browser.evaluate(`getComputedStyle(document.querySelector('${link}')).outlineStyle !== 'none'`)).toBe(true)
          browser.screenshot(resolve(artifacts, `${theme}-${width}-${zoom}.png`), { viewport: true })
        })
      }
    }
  }

  it('updates from an open wait to a resolved one without losing the PR link', () => {
    browser.evaluate(`window.setCiRun(${JSON.stringify({ ...run, status: 'running', waits: [wait] })})`)
    browser.waitForFunction(`document.querySelector('${status}').textContent.includes('Waiting for CI')`)
    expect(browser.text(status)).not.toContain('waiting for capacity')
    browser.evaluate(`window.setCiRun(${JSON.stringify({ ...run, waits: [{ ...wait, phase: 'resolved' }] })})`)
    browser.waitForFunction(`document.querySelector('${status}').textContent.includes('CI result ready — waiting for capacity')`)
    expect(browser.count(link)).toBe(1)
    expect(browser.count('[data-slot="monitoring-schedule"]')).toBe(0)
  })
  it('keeps a settled result linked while continuation admission is queued or waiting', () => {
    for (const runStatus of ['queued', 'waiting']) {
      browser.evaluate(`window.setCiRun(${JSON.stringify({ ...run, status: runStatus,
        waits: [{ ...wait, phase: 'resolved' }] })})`)
      browser.waitForFunction(`document.querySelector('${status}').textContent.includes('CI result ready — waiting for capacity')`)
      expect(browser.count(link)).toBe(1)
    }
  })

  it('keeps a cancelled CI wait beside an open timer and its note, and clears it on a new registration', () => {
    const cancelled = { ...run, waits: [timer],
      lastWaits: [{ ...wait, phase: 'cancelled', cancelledAt: '2026-09-22T12:03:00.000Z' }] }
    for (const theme of ['light', 'dark']) {
      browser.setViewport(360, 640)
      browser.evaluate(`document.documentElement.style.zoom = '1'; document.documentElement.classList.toggle('light', ${theme === 'light'}); window.setCiRun(${JSON.stringify(cancelled)})`)
      const text = browser.waitForValue(`document.querySelector('${status}')?.textContent`,
        value => typeof value === 'string' && value.includes('CI wait cancelled'))
      expect(text).toContain('Cancelled')
      const schedule = browser.text('[data-slot="monitoring-schedule"]')
      expect(schedule).toContain('Next automatic check')
      expect(schedule).toContain('after the migration finishes')
      expect(waitForSettledSample(browser, `document.documentElement.scrollWidth <= document.documentElement.clientWidth`)).toBe(true)
      browser.screenshot(resolve(artifacts, `cancelled-${theme}-360.png`), { viewport: true })
    }
    browser.evaluate(`window.setCiRun(${JSON.stringify(run)})`)
    const registered = browser.waitForValue(`document.querySelector('${status}')?.textContent`,
      value => typeof value === 'string' && value.includes('Waiting for CI'))
    expect(registered).not.toContain('cancelled')
    expect(browser.count('[data-slot="monitoring-schedule"]')).toBe(0)
  })

  it('retains a readable recovery error without fabricating a PR link', () => {
    const recovered = { ...run, status: 'done', waits: undefined,
      lastWaitsError: 'CI wait unavailable — saved observation is unreadable; register a new wait.' }
    browser.setViewport(360, 640)
    browser.evaluate(`document.documentElement.style.zoom = '1'; window.setCiRun(${JSON.stringify(recovered)})`)
    browser.waitForFunction(`document.querySelector('${status}').textContent.includes('saved observation is unreadable')`)
    expect(browser.count(link)).toBe(0)
    expect(waitForSettledSample(browser, `document.documentElement.scrollWidth <= document.documentElement.clientWidth`)).toBe(true)
    browser.screenshot(resolve(artifacts, 'recovery-error-360.png'), { viewport: true })
  })

})
