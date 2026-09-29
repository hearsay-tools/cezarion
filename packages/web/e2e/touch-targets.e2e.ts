import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { stopFixtureServer } from './fixture-server'
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
    // Both references (#617 01b): the sidebar row shows them as plain text on touch, and the
    // task header carries them as the real 44px links.
    pullRequestUrl: 'https://github.com/o/r/pull/594', referencedIssueUrl: 'https://github.com/o/r/issues/451',
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
  await stopFixtureServer(server)
  if (root) rmSync(root, { recursive: true, force: true })
})

const controls = 'button, select, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"], nav a, a[data-slot="button"], [data-slot="run-tabs"] a'

function appearance(density: string, theme: string) {
  browser.evaluate(`(() => {
    document.documentElement.dataset.density = ${JSON.stringify(density)};
    document.documentElement.classList.toggle('light', ${JSON.stringify(theme)} === 'light');
  })()`)
}

// The mobile menu keeps a 20px icon box with an explicit 44px ::after hit region.
// Measure that authored region, then region() verifies all eight perimeter points through elementFromPoint.
const hitRectExpression = `(el) => {
  const box = el.getBoundingClientRect();
  if (!el.matches('[aria-label="Open menu"], [data-slot="wb-step-grip"], [data-slot="wb-step-actions"]')) return box;
  const pseudo = getComputedStyle(el, '::after');
  if (pseudo.content === 'none' || pseudo.position !== 'absolute') return box;
  const left = box.left + parseFloat(pseudo.left), top = box.top + parseFloat(pseudo.top);
  const width = parseFloat(pseudo.width), height = parseFloat(pseudo.height);
  return { left, top, right: left + width, bottom: top + height, width, height };
}`

function smallTargets() {
  return browser.evaluate(`(() => {
    return [...document.querySelectorAll(${JSON.stringify(controls)})]
      .filter(el => el.checkVisibility())
      .map(el => {
        const r = (${hitRectExpression})(el);
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
      const x=(${hitRectExpression})(a), y=(${hitRectExpression})(b);
      if (Math.min(x.right,y.right)-Math.max(x.left,y.left) > 1 &&
          Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top) > 1)
        overlaps.push([a.getAttribute('aria-label') || a.textContent.trim(), b.getAttribute('aria-label') || b.textContent.trim()]);
    }
    return overlaps;
  })()`)
}

/** Scroll the actual action into view, then test its perimeter and center through the
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
    const r = (${hitRectExpression})(el);
    const cx=r.left+r.width/2, cy=r.top+r.height/2;
    const points = [[r.left+1,cy], [r.right-1,cy], [cx,r.top+1], [cx,r.bottom-1], [cx,cy]];
    if (el.matches('[aria-label="Open menu"], [data-slot="wb-step-grip"], [data-slot="wb-step-actions"]'))
      points.push([r.left+1,r.top+1], [r.right-1,r.top+1], [r.left+1,r.bottom-1], [r.right-1,r.bottom-1]);
    return {width:r.width, height:r.height, x:r.left+2, y:cy,
      contained:r.left>=0 && r.top>=0 && r.right<=innerWidth && r.bottom<=innerHeight,
      hits: points.map(([x,y]) => el.contains(document.elementFromPoint(x,y)))};
  })()`) as { width: number; height: number; x: number; y: number; contained: boolean; hits: boolean[] }
  if (mobile) {
    expect(result.width, selector).toBeGreaterThanOrEqual(44)
    expect(result.height, selector).toBeGreaterThanOrEqual(44)
  }
  expect(result.contained, selector).toBe(true)
  expect(result.hits, selector).toEqual(Array(result.hits.length).fill(true))
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
          browser.evaluate(`document.querySelector('.settings-section-picker').open = true`)
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
          // Icon-only view tabs now have tooltips. Let the departed tab's tooltip
          // close before Escape addresses the drawer rather than that nested layer.
          browser.moveTo(0, 0)
          browser.waitForFunction(`document.querySelector('[data-slot="tooltip-content"]') === null`)
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
          if (path.endsWith('/new')) browser.click('[data-slot="execution-options"] summary')
          browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop = 0`)
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
          // New Task has a labeled submit action (#168); 44px is the minimum target,
          // while its width follows the label. Thread icon controls keep their own checks.
          if (mobile) {
            expect(disabled.width).toBeGreaterThanOrEqual(44)
            expect(disabled.height).toBeGreaterThanOrEqual(44)
          }
          browser.tapAt(Math.round(disabled.x), Math.round(disabled.y))
          expect(browser.url()).toContain('/new')
          browser.fill(textarea, 'Preserve this draft while changing density')
          browser.waitForFunction(`document.querySelector('${send}')?.disabled === false`)
          region(send, mobile)
          tapEdge('[data-slot="mode-plan"]', mobile)
          expect(browser.evaluate(`document.querySelector('[data-slot="mode-plan"]').getAttribute('aria-checked')`)).toBe('true')
          for (const next of ['comfortable', 'compact', 'ultra', density]) appearance(next, theme)
          expect(browser.evaluate(`document.querySelector('${textarea}').value`)).toBe('Preserve this draft while changing density')
          expect(browser.evaluate(`document.querySelector('[data-slot="mode-plan"]').getAttribute('aria-checked')`)).toBe('true')
          focus('[data-slot="mode-seg"] button:first-child')
          browser.press('Enter')
          expect(browser.evaluate(`document.querySelector('[data-slot="mode-plan"]').getAttribute('aria-checked')`)).toBe('false')
          tapEdge('[data-slot="execution-options"] summary', mobile)
          tapEdge('[data-slot="model-pill"]', mobile)
          browser.waitForFunction(`document.querySelector('[role="menu"]') !== null`)
          region('[role="menuitemradio"]', mobile)
          browser.press('ArrowDown')
          browser.press('Enter')
          browser.waitForFunction(`document.querySelector('[role="menu"]') === null`)
          const model = browser.text('[data-slot="model-pill"]')
          if (!mobile) expect(region('[data-slot="model-pill"]', false).height).toBe(44)
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
          // Session controls keep the follow-up editor expanded in the integrated layout.
          expect(browser.isVisible(textarea)).toBe(true)
          browser.fill(textarea, 'Follow-up draft')
          appearance('compact', theme)
          appearance(density, theme)
          expect(browser.evaluate(`document.querySelector('${textarea}').value`)).toBe('Follow-up draft')
          expect(browser.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true)
          browser.screenshot(`${artifacts}/${width}-${density}-${theme}-follow-up.png`, { viewport: true })

          browser.goto(`${baseUrl}/p/${project}/workflows`)
          browser.waitForFunction(`document.querySelector('[data-slot="wb-step-actions"]') !== null`)
          appearance(density, theme)
          browser.click('[data-slot="wb-name"]')
          browser.press('Control+a')
          browser.press('Backspace')
          browser.waitForFunction(`document.querySelector('[data-slot="wb-name"]').value === ''`)
          browser.fill('[data-slot="wb-name"]', 'Kept workflow draft')
          expect(overlappingTargets()).toEqual([])
          region('[data-slot="wb-step-grip"]', mobile)
          tapEdge('[data-slot="wb-step-actions"]', mobile)
          browser.waitForFunction(`document.querySelector('[data-slot="wb-step-remove"]') !== null`)
          tapEdge('[data-slot="wb-step-remove"]', mobile)
          expect(browser.count('[data-slot="wb-step"]')).toBe(0)
          tapEdge('[data-slot="wb-skill"][data-skill="touch-check"] [data-slot="wb-skill-add"]', mobile)
          expect(browser.count('[data-slot="wb-step"]')).toBe(1)
          appearance('compact', theme)
          appearance(density, theme)
          expect(browser.evaluate(`document.querySelector('[data-slot="wb-name"]').value`)).toBe('Kept workflow draft')
          tapEdge('[data-slot="wb-yaml-toggle"]', mobile)
          expect(browser.evaluate(`document.querySelector('[data-slot="wb-yaml-toggle"]').parentElement.open`)).toBe(true)
          focus('[data-slot="wb-yaml-toggle"]')
          browser.press('Enter')
          expect(browser.evaluate(`document.querySelector('[data-slot="wb-yaml-toggle"]').parentElement.open`)).toBe(false)
          browser.press('Space')
          expect(browser.evaluate(`document.querySelector('[data-slot="wb-yaml-toggle"]').parentElement.open`)).toBe(true)
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
          if (mobile) {
            browser.click('.settings-section-picker summary')
            region('[data-slot="settings-nav-mobile"] a:last-child', true)
          }
          if (mobile) expect(browser.evaluate(`[...document.querySelectorAll('[data-slot="settings-nav-mobile"] a')].every(el => el.scrollWidth <= el.clientWidth)`)).toBe(true)
          expect(browser.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true)
          browser.screenshot(`${artifacts}/${width}-${density}-${theme}-appearance.png`, { viewport: true })
        }, 60_000)
      }
    }
  }
})

describe('references on a device that cannot hover (#617 01b)', () => {
  for (const [width, height] of [[360, 640], [390, 844]] as const) {
    it(`${width}px: the sidebar row is the tap target, and the task header carries the 44px links`, () => {
      browser.setViewport(width, height)
      browser.goto(`${baseUrl}/p/${project}/tasks/${runId}`)
      browser.waitForFunction(`document.querySelector('[aria-label="Show run details"]') !== null`)
      // The matrix above leaves its last density and theme on the root; start from the defaults.
      appearance('comfortable', 'dark')
      // Below md the run details start collapsed; the chips live in them. Focus + Enter from the
      // start, as task-thread.e2e.ts:579-580 (and :663-664) do for the same phone header. Not a
      // flake fix: at 360px a pointer click on "Show run details" fails every time. The thread
      // scrolls `main[data-slot="main"]` to its latest message on arrival, which leaves the header
      // above the viewport (the button's rect y was -32 and -53 in two probes), and
      // `browser.click` then leaves the details closed. It does NOT fail with a "covered by"
      // refusal: after a minimal `scrollIntoView({ block: 'nearest' })` the button sits at y=52,
      // just under the 52px sticky top bar, and nothing covers it.
      // Reproduced with the click swapped in, this test only (`-t "the sidebar row is the tap
      // target"`): 360px failed 2/2, 390px passed 1/1. Local bundle (gitignored):
      // .ai/qa/failures/touch-targets/360px-the-sidebar-row-is-the-tap-target-and-the-task-header-carries-the-44px-lin-1/
      // — probe.json: kind "wait-value" for the two header chips, lastValue null; snapshot.txt:
      // `button "Show run details" [expanded=false]`. Focus + Enter does not depend on where the
      // thread has scrolled.
      browser.evaluate(`document.querySelector('[aria-label="Show run details"]').focus()`)
      browser.press('Enter')
      type Header = { noHover: boolean; chips: Array<{ w: number; h: number; top: number; right: number }>; inner: number; scroll: number }
      const header = browser.waitForValue(`(() => {
        const chips = [...document.querySelectorAll('[data-slot="run-meta"] :is([data-slot="pr-chip"], [data-slot="issue-chip"])')]
        if (chips.length !== 2 || chips.some((chip) => chip.getBoundingClientRect().width === 0)) return null
        return { noHover: matchMedia('(hover: none)').matches, inner: innerWidth, scroll: document.documentElement.scrollWidth,
          chips: chips.map((chip) => { const r = chip.getBoundingClientRect(); return { w: r.width, h: r.height, top: Math.round(r.top), right: r.right } }) }
      })()`) as Header
      // The whole point is the touch path; a pointer-capable run would prove nothing here.
      expect(header.noHover).toBe(true)
      for (const chip of header.chips) {
        expect(chip.w, JSON.stringify(chip)).toBeGreaterThanOrEqual(44)
        expect(chip.h, JSON.stringify(chip)).toBeGreaterThanOrEqual(44)
        expect(chip.right, JSON.stringify(chip)).toBeLessThanOrEqual(header.inner)
      }
      // No wrap between the two chips, and no horizontal overflow from the bigger targets.
      expect(header.chips[0]!.top).toBe(header.chips[1]!.top)
      expect(header.scroll).toBeLessThanOrEqual(header.inner)
      browser.screenshot(`${artifacts}/${width}-touch-header-references.png`, { viewport: true })

      browser.goto(`${baseUrl}/p/${project}`)
      browser.waitForFunction(`document.querySelector('[aria-label="Open menu"]') !== null`)
      browser.click('[aria-label="Open menu"]')
      const row = `[data-slot="mobile-nav-drawer"] [data-slot="task-row"][data-run-id="${runId}"]`
      const meta = browser.waitForValue(`(() => {
        const meta = document.querySelector('${row} [data-slot="task-row-meta"]')
        if (!meta || document.querySelector('[data-slot="mobile-nav-drawer"]').getBoundingClientRect().x !== 0) return null
        return { text: meta.textContent, links: meta.querySelectorAll('a').length, focusable: meta.querySelectorAll('[tabindex], a, button').length,
          inert: [...meta.querySelectorAll('[data-slot="pr-chip"], [data-slot="issue-chip"]')].map((chip) => chip.dataset.inert) }
      })()`) as { text: string; links: number; focusable: number; inert: string[] }
      expect(meta.text).toMatch(/^PR #594 · #451 · /)
      expect(meta).toMatchObject({ links: 0, focusable: 0, inert: ['true', 'true'] })
      // Tapping the reference text opens the task: the row is the one target. A plain click on
      // the text, not `tapEdge`: on the 390px run its right-edge hit test missed this inline
      // span (hits [true, false, true, true, true]); the edge probes are for block controls.
      browser.click(`${row} [data-slot="task-row-meta"] [data-slot="pr-chip"]`)
      browser.waitForFunction(`location.pathname.endsWith('/tasks/${runId}')`)
    })
  }
})
