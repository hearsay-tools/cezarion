import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, cezarCli, fixtureServeEnv } from './agent-browser'

/** Real-browser geometry and state preservation for the New Task execution disclosure.
 * Uses an isolated dry-run server; the unit suite pins the exact submission payloads. */
const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `hier-${process.pid}`

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`cezar e2e: the new-task server never answered at ${url}`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string

beforeAll(async () => {
  // A REAL git repo: the run needs a worktree, and the base-branch pill needs branches.
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-new-task-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# new-task e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  mkdirSync(join(dataRoot, '.ai/skills'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/skills/lint-fix.md'), '---\ndescription: Fix lint findings\n---\n\nFix lint findings.\n')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 180_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

const composer = '[data-slot="composer"]'
const disclosure = '[data-slot="execution-options"]'
const summary = `${disclosure} summary`
const prompt = `${composer} textarea`
const matrix = [360, 1440].flatMap((width) =>
  ['light', 'dark'].flatMap((theme) =>
    ['comfortable', 'compact', 'ultra'].map((density) => ({ width, theme, density })),
  ),
)

function geometry() {
  return browser.evaluate(`(() => {
    const root = document.querySelector('${composer}');
    const box = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, right: r.right, bottom: r.bottom, left: r.left }; };
    const controls = [...root.querySelectorAll('button, summary')].filter(el => el.checkVisibility());
    return {
      prompt: box('${prompt}'), context: box('[data-slot="composer-footer-start"]'),
      submission: box('[data-slot="composer-submit-row"]'), execution: box('${disclosure}'),
      overflow: document.documentElement.scrollWidth > innerWidth,
      clipped: controls.filter(el => { const r = el.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth; }).map(el => el.getAttribute('aria-label') || el.textContent),
      small: controls.filter(el => { const r = el.getBoundingClientRect(); return r.width < 43.9 || r.height < 43.9; }).map(el => el.getAttribute('aria-label') || el.textContent),
    };
  })()` ) as { prompt: { bottom: number }; context: { top: number; bottom: number }; submission: { top: number; right: number; bottom: number }; execution: { top: number; left: number }; overflow: boolean; clipped: string[]; small: string[] }
}

beforeAll(() => {
  browser.goto(`${baseUrl}/new`)
  browser.waitForFunction(`document.querySelector('[data-slot="source-pill"]')?.textContent.includes('Skill')`)
})

describe('New Task hierarchy (#168)', () => {
  it('separates prompt context, submission, and execution options', () => {
    expect(browser.count(`${disclosure} summary`)).toBe(1)
    expect(browser.evaluate(`document.querySelector('${disclosure}').open`)).toBe(true)
    expect(browser.isVisible('[data-slot="source-pill"]')).toBe(true)
    expect(browser.isVisible('[aria-label="Start task"]')).toBe(true)
    expect(browser.evaluate(`document.querySelector('[data-slot="model-pill"]').checkVisibility()`)).toBe(true)
    expect(browser.evaluate(`document.querySelector('[data-slot="composer-editor"]').contains(document.querySelector('[data-slot="model-pill"]'))`)).toBe(true)
    expect(browser.evaluate(`document.querySelector('${disclosure}').contains(document.querySelector('[data-slot="variants-pill"]'))`)).toBe(true)
  })

  for (const reduced of [false, true]) {
    describe(reduced ? 'reduced motion' : 'normal motion', () => {
      beforeAll(() => {
        if (reduced) browser.setReducedMotion()
        browser.fill(prompt, 'Verify the task composer')
      })
      it.each(matrix)('$width $theme $density: hierarchy, focus, target sizes, no clipping', ({ width, theme, density }) => {
        browser.setViewport(width, width === 360 ? 640 : 900)
        browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'}); document.documentElement.dataset.density = ${JSON.stringify(density)}`)
        expect(browser.evaluate(`document.documentElement.classList.contains('light')`)).toBe(theme === 'light')
        expect(browser.evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`)).toBe(reduced)
        browser.press('Tab')
        browser.evaluate(`document.querySelector('${summary}').focus()`)
        expect(browser.evaluate(`document.activeElement.matches('${summary}')`)).toBe(true)
        expect(browser.evaluate(`getComputedStyle(document.activeElement).outlineStyle`)).not.toBe('none')
        let layout = geometry()
        expect(layout.prompt.bottom).toBeLessThanOrEqual(layout.context.top)
        expect(layout.context.bottom).toBeLessThanOrEqual(layout.submission.top)
        if (width === 1440) expect(layout.submission.right).toBeLessThanOrEqual(layout.execution.left)
        else expect(layout.submission.bottom).toBeLessThanOrEqual(layout.execution.top)
        expect(layout.overflow).toBe(false)
        expect(layout.clipped).toEqual([])
        if (width === 360) expect(layout.small).toEqual([])
        browser.press('Space')
        expect(browser.evaluate(`document.querySelector('${disclosure}').open`)).toBe(false)
        expect(browser.evaluate(`document.querySelector('[data-slot="variants-pill"]')?.checkVisibility()`)).toBe(false)
        browser.press('Enter')
        expect(browser.evaluate(`document.querySelector('${disclosure}').open`)).toBe(true)
        expect(browser.evaluate(`document.querySelector('[data-slot="variants-pill"]').checkVisibility()`)).toBe(true)
        layout = geometry()
        expect(layout.overflow).toBe(false)
        expect(layout.clipped).toEqual([])
        if (width === 360) expect(layout.small).toEqual([])
        browser.screenshot(`${artifactsDir}/hierarchy-${width}-${theme}-${density}-${reduced ? 'reduced' : 'normal'}-open.png`)
        browser.click('[data-slot="mode-plan"]')
        expect(browser.evaluate(`document.querySelector('[data-slot="mode-plan"]').getAttribute('aria-checked')`)).toBe('true')
        expect(browser.evaluate(`document.querySelector('[aria-label="Plan task"]').disabled`)).toBe(false)
        browser.waitForFunction(`document.querySelector('[data-slot="mode-plan"]').getAnimations().every(animation => animation.playState !== 'running')`)
        browser.screenshot(`${artifactsDir}/hierarchy-${width}-${theme}-${density}-${reduced ? 'reduced' : 'normal'}.png`)
        browser.click('[data-slot="mode-seg"] [role="radio"]:first-child')
        expect(browser.evaluate(`document.querySelector('[aria-label="Start task"]').disabled`)).toBe(false)
      })
    })
  }

  it('keeps submission feedback and the read-only disclosure stable through a delayed failure', () => {
    browser.fill(prompt, 'Retain this failed task')
    const height = browser.evaluate(`document.querySelector('${composer}').getBoundingClientRect().height`)
    browser.evaluate(`(() => {
      window.hierarchyFetch = window.fetch;
      window.hierarchyAttempts = 0;
      window.fetch = (input, init) => {
        if (String(input).endsWith('/runs') && init?.method === 'POST') {
          window.hierarchyAttempts++;
          return new Promise(resolve => { window.hierarchyFail = () => resolve(new Response(JSON.stringify({ error: 'Service unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } })); });
        }
        return window.hierarchyFetch(input, init);
      };
    })()`)
    browser.click('[aria-label="Start task"]')
    browser.waitForFunction(`document.querySelector('${prompt}').readOnly`)
    expect(browser.evaluate(`document.querySelector('${disclosure}').closest('[inert]') !== null`)).toBe(true)
    expect(browser.evaluate(`document.querySelector('[aria-label="Start task"]').disabled`)).toBe(true)
    browser.press('Control+Enter')
    expect(browser.evaluate('window.hierarchyAttempts')).toBe(1)
    expect(browser.evaluate(`document.querySelector('${composer}').getBoundingClientRect().height`)).toBe(height)
    browser.evaluate('window.hierarchyFail()')
    browser.waitForFunction(`document.querySelector('${composer} [role="alert"]') !== null`)
    expect(browser.text(`${composer} [role="alert"]`)).toContain('Check Tasks')
    expect(browser.evaluate(`document.querySelector('${prompt}').value`)).toBe('Retain this failed task')
    expect(browser.evaluate(`document.querySelector('${disclosure}').closest('[inert]')`)).toBe(null)
    expect(browser.evaluate(`document.querySelector('${composer}').getBoundingClientRect().height`)).toBe(height)
    browser.screenshot(`${artifactsDir}/hierarchy-submission-failure.png`)
    browser.evaluate('window.fetch = window.hierarchyFetch')
  })

  it('keeps the same prompt, attachment, and option nodes through disclosure and viewport changes', () => {
    browser.click('[data-slot="source-pill"]')
    browser.click('[data-slot="source-option"][data-source-ref="lint-fix"]')
    browser.waitForFunction(`document.querySelector('[data-slot="source-menu"]') === null`)
    browser.fill(prompt, 'Keep this task and its attachment')
    browser.evaluate(`(() => {
      window.hierarchyPrompt = document.querySelector('${prompt}');
      window.hierarchyModel = document.querySelector('[data-slot="model-pill"]');
      const transfer = new DataTransfer();
      transfer.items.add(new File(['QA attachment'], 'notes.txt', { type: 'text/plain' }));
      const input = document.querySelector('${composer} input[type="file"]');
      input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    browser.waitForFunction(`document.querySelector('[aria-label="Remove notes.txt"]') !== null`)
    browser.click('[data-slot="variants-pill"]')
    browser.waitForFunction(`document.querySelectorAll('[role="menuitemradio"]').length === 3`)
    browser.click('[role="menuitemradio"]:nth-child(2)')
    browser.waitForFunction(`document.querySelector('[role="menuitemradio"]') === null`)
    browser.click(summary)
    for (const width of [360, 1440, 360]) {
      browser.setViewport(width, width === 360 ? 640 : 900)
      expect(browser.evaluate(`document.querySelector('${prompt}') === window.hierarchyPrompt && document.querySelector('[data-slot="model-pill"]') === window.hierarchyModel`)).toBe(true)
      expect(browser.evaluate(`document.querySelector('${prompt}').value`)).toBe('Keep this task and its attachment')
      expect(browser.count('[aria-label="Remove notes.txt"]')).toBe(1)
      expect(browser.text('[data-slot="source-pill"]')).toContain('lint-fix')
      browser.click(summary)
      expect(browser.text('[data-slot="variants-pill"]')).toContain('×2')
      browser.click(summary)
    }
    browser.click(summary)
    browser.click('[data-slot="variants-pill"]')
    browser.waitForFunction(`document.querySelectorAll('[role="menuitemradio"]').length === 3`)
    browser.click('[role="menuitemradio"]:nth-child(1)')
    browser.waitForFunction(`document.querySelector('[role="menuitemradio"]') === null`)
    browser.click(summary)
    browser.click('[aria-label="Start task"]')
    browser.waitForFunction(`location.pathname.includes('/tasks/')`)
  })
})
