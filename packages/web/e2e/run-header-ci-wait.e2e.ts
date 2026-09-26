import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { stopFixtureServer } from './fixture-server'
import { AgentBrowser } from './agent-browser'
import { pollFor } from './poll'
import { contrastSampleExpression, focusWithKeyboard, type ContrastSample } from './contrast'

// Browser component coverage of the real header + production CSS. The parent integration
// suite owns server lifecycle/SSE evidence; this fixture deliberately needs no CI controller.
const webRoot = resolve(import.meta.dirname, '..')
const fixtureName = `.ci-header-${process.pid}`
const artifacts = resolve(webRoot, '../../.ai/qa/artifacts_e2e/run-header-ci-wait')
const repository = `${'long-owner-'.repeat(3)}/${'long-repository-'.repeat(5)}`
const wait: NonNullable<ApiRun['ciWait']> = {
  id: 'ci-browser', generation: 'generation', turnId: 'turn', timeoutSeconds: 1800,
  repository, prNumber: 474, prUrl: 'https://github.com/owner/repo/pull/474',
  headSha: '123456789abcdef', registeredAt: '2026-09-22T12:00:00.000Z',
  deadline: '2026-09-22T12:30:00.000Z', phase: 'parked',
}
const run: ApiRun = {
  id: 'ci-browser', task: 'Wait for checks', title: 'Wait for checks', workflow: 'quick-task',
  status: 'running', activity: 'monitoring', createdAt: wait.registeredAt,
  archived: false, tokensUsed: 0, steps: [], ciWait: wait,
}
let browser: AgentBrowser
let server: ChildProcess
let url: string
const status = '[data-slot="ci-wait-status"]'
const link = `${status} a`

beforeAll(async () => {
  mkdirSync(artifacts, { recursive: true })
  writeFileSync(resolve(webRoot, `${fixtureName}.html`), `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/${fixtureName}.tsx"></script></body></html>`)
  writeFileSync(resolve(webRoot, `${fixtureName}.tsx`), `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { QueryClientProvider } from '@tanstack/react-query';
    import { MemoryRouter } from 'react-router';
    import { createQueryClient } from './src/api/query-client';
    import { RunHeader } from './src/routes/task-thread/run-header';
    import './src/styles/index.css';
    window.fetch = async input => {
      const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
      return new Response(JSON.stringify(path.endsWith('/runs') ? [] : {}), {headers: {'content-type': 'application/json'}});
    };
    const client = createQueryClient();
    function Fixture() {
      const [run, setRun] = useState(${JSON.stringify(run)});
      window.setCiRun = setRun;
      return <QueryClientProvider client={client}><MemoryRouter><main className="h-dvh min-w-0 overflow-y-auto p-4"><RunHeader run={run} tab="session" /></main></MemoryRouter></QueryClientProvider>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  `)
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = (probe.address() as { port: number }).port
  await new Promise<void>(done => probe.close(() => done()))
  url = `http://127.0.0.1:${port}/${fixtureName}.html`
  server = spawn(process.execPath, [resolve(webRoot, '../../node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: webRoot, stdio: 'ignore' })
  await pollFor(async () => (await fetch(url)).ok || undefined,
    () => 'CI header browser fixture did not start', { tries: 60 })
  browser = AgentBrowser.open(`ci-header-${process.pid}`)
  browser.goto(url)
  browser.waitForFunction(`Boolean(document.querySelector('${link}'))`)
})

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  for (const extension of ['html', 'tsx']) rmSync(resolve(webRoot, `${fixtureName}.${extension}`), { force: true })
})

describe('CI header browser accessibility', () => {
  for (const theme of ['light', 'dark']) {
    for (const width of [360, 1440]) {
      for (const zoom of [1, 2]) {
        it(`${theme}, ${width}px, ${zoom * 100}% zoom: wraps and exposes a readable 44px keyboard target`, () => {
          browser.setViewport(width, width === 360 ? 640 : 900)
          browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'}); document.documentElement.style.zoom = '${zoom}'`)
          browser.waitForFunction(`document.querySelector('${link}').getBoundingClientRect().height >= 44`)
          const geometry = browser.evaluate(`(() => {
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
          expect(browser.evaluate(`document.querySelector('${link}').getBoundingClientRect().left >= 0`)).toBe(true)
          const contrast = browser.evaluate(contrastSampleExpression(link)) as ContrastSample
          expect(contrast.ratio).toBeGreaterThanOrEqual(4.5)
          expect(browser.evaluate(`getComputedStyle(document.querySelector('${link}')).boxShadow !== 'none'`)).toBe(true)
          browser.screenshot(resolve(artifacts, `${theme}-${width}-${zoom}.png`), { viewport: true })
        })
      }
    }
  }

  it('updates from active registration to queued admission without losing the PR link', () => {
    browser.evaluate(`window.setCiRun(${JSON.stringify({ ...run, activity: undefined, ciWait: { ...wait, phase: 'registered' } })})`)
    browser.waitForFunction(`document.querySelector('${status}').textContent.includes('Waiting for CI')`)
    expect(browser.text(status)).not.toContain('waiting for capacity')
    browser.evaluate(`window.setCiRun(${JSON.stringify({ ...run, ciWait: { ...wait, phase: 'wake-pending' } })})`)
    browser.waitForFunction(`document.querySelector('${status}').textContent.includes('CI result ready — waiting for capacity')`)
    expect(browser.count(link)).toBe(1)
    expect(browser.count('[data-slot="monitoring-schedule"]')).toBe(0)
  })
  it('keeps a settled result linked while continuation admission is queued or waiting', () => {
    for (const runStatus of ['queued', 'waiting']) {
      browser.evaluate(`window.setCiRun(${JSON.stringify({ ...run, status: runStatus, activity: undefined,
        ciWait: { ...wait, phase: 'wake-pending' } })})`)
      browser.waitForFunction(`document.querySelector('${status}').textContent.includes('CI result ready — waiting for capacity')`)
      expect(browser.count(link)).toBe(1)
    }
  })

  it('retains a readable recovery error without fabricating a PR link', () => {
    const recovered = { ...run, status: 'done', activity: undefined, ciWait: undefined,
      lastCiWaitError: 'CI wait unavailable — saved observation is unreadable; register a new wait.' }
    browser.setViewport(360, 640)
    browser.evaluate(`document.documentElement.style.zoom = '1'; window.setCiRun(${JSON.stringify(recovered)})`)
    browser.waitForFunction(`document.querySelector('${status}').textContent.includes('saved observation is unreadable')`)
    expect(browser.count(link)).toBe(0)
    expect(browser.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)).toBe(true)
    browser.screenshot(resolve(artifacts, 'recovery-error-360.png'), { viewport: true })
  })

})
