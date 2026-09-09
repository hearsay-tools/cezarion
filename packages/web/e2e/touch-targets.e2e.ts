import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { contrastSampleExpression, focusWithKeyboard, type ContrastSample } from './contrast'

// Real layout regression: jsdom cannot resolve density, clipping, or hit testing.
let browser: AgentBrowser
let baseUrl: string
let project: string
let root: string
let server: ChildProcess
const runId = randomUUID()
const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e/touch-targets')

beforeAll(async () => {
  mkdirSync(artifacts, { recursive: true })
  root = mkdtempSync(join(tmpdir(), 'cez-touch-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@cezar.test')
  git('config', 'user.name', 'Touch test')
  writeFileSync(join(root, 'README.md'), '# Touch fixture\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  mkdirSync(join(root, '.ai/skills'), { recursive: true })
  writeFileSync(join(root, '.ai/skills/touch-check.md'), '---\ndescription: Verify touch targets\n---\nCheck the UI.\n')
  mkdirSync(join(root, '.ai/cezar/workflows'), { recursive: true })
  writeFileSync(join(root, '.ai/cezar/workflows/touch-flow.yaml'), 'name: touch-flow\nskills:\n  - touch-check\n')
  writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify([{
    id: runId, title: 'Touch target fixture', task: 'Touch target fixture', workflow: 'quick-task',
    runner: 'claude', status: 'done', archived: false, createdAt: new Date().toISOString(), tokensUsed: 0,
    steps: [{ id: 'task', name: 'Task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, sessionId: 'touch-fixture-session' }],
  } satisfies RunRecord]))
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((done) => probe.close(() => done()))
  baseUrl = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(root, { CEZ_SKILLS_AUTO_UPDATE: '0' }), stdio: 'ignore',
  })
  let healthy = false
  for (let attempt = 0; attempt < 60; attempt++) {
    try { healthy = (await fetch(`${baseUrl}/api/v1/health`)).ok } catch { /* booting */ }
    if (healthy) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  if (!healthy) throw new Error('Touch fixture server did not become healthy')
  project = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(`touch-${process.pid}`)
})
afterAll(async () => {
  browser?.close()
  if (server && server.exitCode === null) {
    server.kill()
    await once(server, 'exit')
  }
  if (root) rmSync(root, { recursive: true, force: true })
})

const controls = 'button, select, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"], nav a, a[data-slot="button"], [data-slot="run-tabs"] a'

function appearance(density: string, theme: string) {
  browser.evaluate(`(() => {
    document.documentElement.dataset.density = ${JSON.stringify(density)};
    document.documentElement.classList.toggle('light', ${JSON.stringify(theme)} === 'light');
  })()`)
}

function smallTargets() {
  return browser.evaluate(`(() => {
    return [...document.querySelectorAll(${JSON.stringify(controls)})]
      .filter(el => el.checkVisibility())
      .map(el => {
        const r = el.getBoundingClientRect();
        return {name: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 60), width: r.width, height: r.height};
      }).filter(r => r.width < 44 || r.height < 44);
  })()`)
}

function overlappingTargets() {
  return browser.evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(controls + ', [data-slot="wb-count"]')})]
      .filter(el => el.checkVisibility() && getComputedStyle(el).opacity !== '0');
    const overlaps = [];
    for (let i=0; i<nodes.length; i++) for (let j=i+1; j<nodes.length; j++) {
      const a=nodes[i], b=nodes[j];
      // Row navigation contains its own pin; dnd-kit palette contains its Add action.
      if (a.contains(b) || b.contains(a)) continue;
      const x=a.getBoundingClientRect(), y=b.getBoundingClientRect();
      if (Math.min(x.right,y.right)-Math.max(x.left,y.left) > 1 &&
          Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top) > 1)
        overlaps.push([a.getAttribute('aria-label') || a.textContent.trim(), b.getAttribute('aria-label') || b.textContent.trim()]);
    }
    return overlaps;
  })()`)
}

/** Scroll the actual action into view, then test its edge midpoints and center through the
 * browser's hit tester. A 44px CSS box covered/clipped by another element is not a pass. */
function region(selector: string, mobile: boolean) {
  browser.waitForFunction(`(() => {
    for (let el=document.querySelector(${JSON.stringify(selector)}); el; el=el.parentElement)
      if (el.getAnimations().some(a => a.effect?.getComputedTiming().iterations !== Infinity && a.playState === 'running')) return false;
    return true;
  })()`)
  const result = browser.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.scrollIntoView({block: 'center', inline: 'center'});
    const r = el.getBoundingClientRect();
    const cx=r.left+r.width/2, cy=r.top+r.height/2;
    const points = [[r.left+1,cy], [r.right-1,cy], [cx,r.top+1], [cx,r.bottom-1], [cx,cy]];
    return {width:r.width, height:r.height, x:r.left+2, y:cy,
      hits: points.map(([x,y]) => el.contains(document.elementFromPoint(x,y)))};
  })()`) as { width: number; height: number; x: number; y: number; hits: boolean[] }
  if (mobile) {
    expect(result.width, selector).toBeGreaterThanOrEqual(44)
    expect(result.height, selector).toBeGreaterThanOrEqual(44)
  }
  expect(result.hits, selector).toEqual([true, true, true, true, true])
  return result
}

function tapEdge(selector: string, mobile: boolean) {
  const { x, y } = region(selector, mobile)
  browser.tapAt(Math.round(x), Math.round(y))
}

function focus(selector: string) {
  // Establish keyboard modality before focusing the control, then use a real key press.
  browser.press('Tab')
  browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)
  expect(browser.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)}), s = getComputedStyle(el);
    return document.activeElement === el && el.matches(':focus-visible') &&
      ((s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none');
  })()`), selector).toBe(true)
}

describe('density-independent mobile action targets (#166)', () => {
  for (const density of ['comfortable', 'compact', 'ultra']) {
    for (const theme of ['light', 'dark']) {
      it(`${density}/${theme}: mobile keyboard outline contrast for both accents`, () => {
        browser.setViewport(360, 640)
        browser.goto(`${baseUrl}/settings/global/appearance`)
        browser.waitForFunction(`document.querySelector('[data-slot="appearance-density"]') !== null`)
        appearance(density, theme)
        for (const accent of ['lime', 'violet']) {
          browser.evaluate(`document.documentElement.dataset.accent = ${JSON.stringify(accent)}`)
          for (const selector of ['[data-slot="settings-nav-mobile"] a:last-child', '[data-slot="appearance-density"] button:nth-child(2)', '[data-slot="mobile-nav-drawer"] nav a:last-child', '[data-slot="mobile-nav-drawer"] a[data-slot="button"]']) {
            if (selector.includes('mobile-nav-drawer') && !browser.count('[data-slot="mobile-nav-drawer"]')) {
              browser.click('[aria-label="Open menu"]')
              browser.waitForFunction(`document.querySelector('[data-slot="mobile-nav-drawer"]')?.getBoundingClientRect().x === 0`)
            }
            focusWithKeyboard(browser, selector)
            region(selector, true)
            const style = browser.evaluate(`(() => {
              const el = document.querySelector(${JSON.stringify(selector)}), s = getComputedStyle(el);
              return { active: document.activeElement === el && el.matches(':focus-visible'),
                outline: s.outlineStyle, width: parseFloat(s.outlineWidth), offset: parseFloat(s.outlineOffset),
                opaque: (() => { for (let node=el; node; node=node.parentElement) if (getComputedStyle(node).opacity !== '1') return false; return true })() };
            })()`) as { active: boolean; outline: string; width: number; offset: number; opaque: boolean }
            expect(style.active).toBe(true)
            expect(style.outline).toBe('solid')
            expect(style.width).toBeGreaterThanOrEqual(2)
            expect(style.offset).toBeGreaterThanOrEqual(2)
            expect(style.opaque).toBe(true)
            const sample = browser.evaluate(contrastSampleExpression(selector, 'outline-color', 'parent')) as ContrastSample
            appendFileSync(`${artifacts}/focus-${process.pid}.jsonl`, JSON.stringify({ density, theme, accent, selector, ...sample }) + '\n')
            expect(sample.ratio, `${accent} ${selector}: ${sample.foreground} on ${sample.background}`).toBeGreaterThanOrEqual(3)
          }
          browser.screenshot(`${artifacts}/focus-${density}-${theme}-${accent}.png`, { viewport: true })
          browser.press('Escape')
          browser.waitForFunction(`document.querySelector('[data-slot="mobile-nav-drawer"]') === null`)
        }
      })

      it(`${density}/${theme}: mobile shell, composer, appearance and workflow targets`, () => {
        browser.setViewport(360, 640)
        for (const path of [`/p/${project}/new`, '/settings/global/appearance', `/p/${project}/workflows`]) {
          browser.goto(`${baseUrl}${path}`)
          browser.waitForFunction(`document.querySelector('[data-slot="composer"] textarea, [data-slot="appearance-section"], [data-slot="wb-name"]') !== null`)
          appearance(density, theme)
          expect(smallTargets(), path).toEqual([])
          expect(overlappingTargets(), path).toEqual([])
          expect(browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), path).toBe(true)
        }
      })

      for (const [width, height] of [[360, 640], [1440, 900]] as const) {
        it(`${density}/${theme}/${width}: edge taps, keyboard, drafts, pins and pending controls`, () => {
          const mobile = width === 360
          browser.setViewport(width, height)
          browser.goto(`${baseUrl}/p/${project}/new`)
          const textarea = '[data-slot="composer"] textarea'
          browser.waitForFunction(`document.querySelector('${textarea}') !== null`)
          appearance(density, theme)
          browser.waitForFunction(`document.querySelector('[data-slot="model-pill"]') !== null`)
          browser.click('[data-slot="mode-seg"] button:first-child')
          browser.click(textarea)
          browser.press('Control+a')
          browser.press('Backspace')
          const send = '[data-slot="composer"] button[aria-label="Start task"]'
          browser.waitForFunction(`document.querySelector('${send}')?.disabled === true`)
          // Empty/disabled action still reserves its space; a real tap cannot submit it.
          const disabled = browser.evaluate(`(() => {
            const el = document.querySelector('${send}'); el.scrollIntoView({block:'center'});
            const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height};
          })()`) as { x: number; y: number; width: number; height: number }
          if (mobile) expect([disabled.width, disabled.height]).toEqual([44, 44])
          browser.tapAt(Math.round(disabled.x), Math.round(disabled.y))
          expect(browser.url()).toContain('/new')
          browser.fill(textarea, 'Preserve this draft while changing density')
          tapEdge('[data-slot="mode-plan"]', mobile)
          expect(browser.evaluate(`document.querySelector('[data-slot="mode-plan"]').getAttribute('aria-checked')`)).toBe('true')
          for (const next of ['comfortable', 'compact', 'ultra', density]) appearance(next, theme)
          expect(browser.evaluate(`document.querySelector('${textarea}').value`)).toBe('Preserve this draft while changing density')
          expect(browser.evaluate(`document.querySelector('[data-slot="mode-plan"]').getAttribute('aria-checked')`)).toBe('true')
          focus('[data-slot="mode-seg"] button:first-child')
          browser.press('Enter')
          expect(browser.evaluate(`document.querySelector('[data-slot="mode-plan"]').getAttribute('aria-checked')`)).toBe('false')
          tapEdge('[data-slot="model-pill"]', mobile)
          browser.waitForFunction(`document.querySelector('[role="menu"]') !== null`)
          region('[role="menuitemradio"]', mobile)
          browser.press('ArrowDown')
          browser.press('Enter')
          browser.waitForFunction(`document.querySelector('[role="menu"]') === null`)
          const model = browser.text('[data-slot="model-pill"]')
          if (!mobile) expect(region('[data-slot="model-pill"]', false).height).toBe(26)
          appearance('ultra', theme)
          appearance(density, theme)
          expect(browser.text('[data-slot="model-pill"]')).toBe(model)
          browser.screenshot(`${artifacts}/${width}-${density}-${theme}-composer.png`, { viewport: true })
          if (mobile) {
            tapEdge('[aria-label="Open menu"]', true)
            browser.waitForFunction(`document.querySelector('[data-slot="mobile-nav-drawer"]')?.getBoundingClientRect().x === 0`)
            region('[aria-label="Close menu"]', true)
            focus('[aria-label="Close menu"]')
            browser.press('Enter')
            browser.waitForFunction(`document.querySelector('[data-slot="mobile-nav-drawer"]') === null`)
          }

          browser.goto(`${baseUrl}/p/${project}`)
          browser.waitForFunction(`document.querySelector('[data-slot="main"] [data-slot="pin-toggle"]') !== null`)
          appearance(density, theme)
          const pin = mobile ? '[data-slot="task-card"] [data-slot="pin-toggle"]' : '[data-slot="main"] table [data-slot="pin-toggle"]'
          const wasPinned = browser.evaluate(`document.querySelector('${pin}').getAttribute('aria-pressed')`)
          tapEdge(pin, mobile)
          browser.waitForFunction(`document.querySelector('${pin}').getAttribute('aria-pressed') !== ${JSON.stringify(wasPinned)}`)
          expect(browser.url()).toContain(`/p/${project}`)
          expect(browser.url()).not.toContain(runId)

          browser.goto(`${baseUrl}/p/${project}/tasks/${runId}`)
          browser.waitForFunction(`document.querySelector('[data-slot="composer"] button[aria-label="Continue"]') !== null`)
          appearance(density, theme)
          region('[data-slot="composer"] button[aria-label="Continue"]', mobile)
          region('[data-slot="run-tabs"] a', mobile)
          if (mobile) {
            tapEdge('[aria-label="Expand composer"]', true)
            browser.waitForFunction(`document.querySelector('[aria-label="Collapse composer"]') !== null`)
          }
          browser.fill(textarea, 'Follow-up draft')
          appearance('compact', theme)
          appearance(density, theme)
          expect(browser.evaluate(`document.querySelector('${textarea}').value`)).toBe('Follow-up draft')
          if (mobile) {
            focus('[aria-label="Collapse composer"]')
            browser.press('Enter')
            expect(browser.evaluate(`document.querySelector('${textarea}').value`)).toBe('Follow-up draft')
          }
          expect(browser.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true)
          browser.screenshot(`${artifacts}/${width}-${density}-${theme}-follow-up.png`, { viewport: true })

          browser.goto(`${baseUrl}/p/${project}/workflows`)
          browser.waitForFunction(`document.querySelector('[data-slot="wb-step-remove"]') !== null`)
          appearance(density, theme)
          browser.click('[data-slot="wb-name"]')
          browser.press('Control+a')
          browser.press('Backspace')
          browser.waitForFunction(`document.querySelector('[data-slot="wb-name"]').value === ''`)
          browser.fill('[data-slot="wb-name"]', 'Kept workflow draft')
          expect(overlappingTargets()).toEqual([])
          region('[data-slot="wb-step-grip"]', mobile)
          tapEdge('[data-slot="wb-step-remove"]', mobile)
          expect(browser.count('[data-slot="wb-step"]')).toBe(0)
          tapEdge('[data-slot="wb-skill"][data-skill="touch-check"] [data-slot="wb-skill-add"]', mobile)
          expect(browser.count('[data-slot="wb-step"]')).toBe(1)
          appearance('compact', theme)
          appearance(density, theme)
          expect(browser.evaluate(`document.querySelector('[data-slot="wb-name"]').value`)).toBe('Kept workflow draft')
          focus('[data-slot="wb-copy"]')
          browser.press('Enter')
          expect(browser.text('[data-slot="wb-copy"]')).toContain('Copied')
          browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop = 0`)
          browser.screenshot(`${artifacts}/${width}-${density}-${theme}-workflow.png`, { viewport: true })

          browser.goto(`${baseUrl}/p/${project}/settings/agents`)
          const toggle = '[data-slot="agents-review-gate"]'
          browser.waitForFunction(`document.querySelector('${toggle}') !== null`)
          appearance(density, theme)
          region(toggle, mobile)
          const before = browser.evaluate(`document.querySelector('${toggle}').getAttribute('aria-checked')`)
          // Hold the real HTTP mutation to exercise the actual pending/disabled render.
          browser.evaluate(`(() => {
            window.touchFetch = window.fetch;
            window.fetch = async (...args) => {
              if (String(args[0]).endsWith('/config') && args[1]?.method === 'PUT')
                await new Promise(resolve => { window.releaseTouchSave = resolve });
              return window.touchFetch(...args);
            };
          })()`)
          tapEdge(toggle, mobile)
          browser.waitForFunction(`document.querySelector('${toggle}').disabled === true`)
          const pending = browser.evaluate(`(() => { const r=document.querySelector('${toggle}').getBoundingClientRect(); return {x:r.x+2,y:r.y+r.height/2,w:r.width,h:r.height}; })()`) as { x: number; y: number; w: number; h: number }
          if (mobile) expect([pending.w, pending.h]).toEqual([44, 44])
          browser.tapAt(Math.round(pending.x), Math.round(pending.y))
          browser.evaluate('window.releaseTouchSave(); window.fetch = window.touchFetch')
          browser.waitForFunction(`!document.querySelector('${toggle}').disabled && document.querySelector('${toggle}').getAttribute('aria-checked') !== ${JSON.stringify(before)}`)
          focus(toggle)
          browser.press('Space')
          browser.waitForFunction(`!document.querySelector('${toggle}').disabled && document.querySelector('${toggle}').getAttribute('aria-checked') === ${JSON.stringify(before)}`)
          browser.screenshot(`${artifacts}/${width}-${density}-${theme}-settings.png`, { viewport: true })

          browser.goto(`${baseUrl}/settings/global/appearance`)
          browser.waitForFunction(`document.querySelector('[data-slot="appearance-density"]') !== null`)
          appearance(density, theme)
          const choice = `[data-slot="appearance-density"] [data-value="${density}"]`
          tapEdge(choice, mobile)
          expect(browser.evaluate(`document.querySelector(${JSON.stringify(choice)}).getAttribute('aria-checked')`)).toBe('true')
          focus(choice)
          if (mobile) region('[data-slot="settings-nav-mobile"] a:last-child', true)
          if (mobile) expect(browser.evaluate(`[...document.querySelectorAll('[data-slot="settings-nav-mobile"] a')].every(el => el.scrollWidth <= el.clientWidth)`)).toBe(true)
          expect(browser.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true)
          browser.screenshot(`${artifacts}/${width}-${density}-${theme}-appearance.png`, { viewport: true })
        }, 60_000)
      }
    }
  }
})
