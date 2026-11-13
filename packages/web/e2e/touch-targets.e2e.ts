import { execFileSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { RUN_STATUS, STEP_STATUS, STEP_KIND } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { seedRuns } from './seed-runs'
import { waitForSettledSample } from './visual-ready'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { AgentBrowser, bootProjectId, squawkCli, fixtureServeEnv } from './agent-browser'
import { contrastSampleExpression, focusWithKeyboard, type ContrastSample } from './contrast'
import { openSessionActivityRow } from './session-activity'
// fixture-server starts: 1

// Real layout regression: jsdom cannot resolve density, clipping, or hit testing.
// Rules: docs/areas/web-ui.md § Touch and phone rules and § Accessibility rules.
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
  seedRuns(root, [({
    id: runId, title: 'Touch target fixture', task: 'Touch target fixture', workflow: 'quick-task',
    runner: 'claude', status: RUN_STATUS.done, archived: false, createdAt: new Date().toISOString(), tokensUsed: 0,
    // Both references (#617 01b): the sidebar row shows them as plain text on touch, and the
    // Workspace carries them as the real 44px links.
    pullRequestUrl: 'https://github.com/o/r/pull/594', referencedIssueUrl: 'https://github.com/o/r/issues/451',
    steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent, status: STEP_STATUS.done, iterations: 1, tokensUsed: 0, sessionId: 'touch-fixture-session' }],
  } satisfies Partial<RunRecord>) satisfies RunRecord])
  server = spawnFixtureServer([squawkCli, 'serve', '--repo', root, '--port', '0', '--no-open'], {
    env: fixtureServeEnv(root), stdio: 'ignore',
  })
  baseUrl = await waitForFixtureServer(server)
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

// The workbench grip and actions keep a small glyph box with an explicit 44px ::after hit region.
// Measure that authored region, then region() verifies all eight perimeter points through elementFromPoint.
// The mobile menu button is a real 64x44 box (#620), so it is measured as it is.
const hitRectExpression = `(el) => {
  const box = el.getBoundingClientRect();
  if (!el.matches('[data-slot="wb-step-grip"], [data-slot="wb-step-actions"]')) return box;
  const pseudo = getComputedStyle(el, '::after');
  if (pseudo.content === 'none' || pseudo.position !== 'absolute') return box;
  const left = box.left + parseFloat(pseudo.left), top = box.top + parseFloat(pseudo.top);
  const width = parseFloat(pseudo.width), height = parseFloat(pseudo.height);
  return { left, top, right: left + width, bottom: top + height, width, height };
}`

/** Small targets, overlapping targets and page overflow, from ONE held observation of an
 * unchanged page state. Each part keeps its own assertion and diagnostic label. */
function targetAudit() {
  return waitForSettledSample<{ small: Array<{ name: string; width: number; height: number }>; overlaps: string[][]; fitsWidth: boolean }>(browser, `(() => {
    const small = [...document.querySelectorAll(${JSON.stringify(controls)})]
      .filter(el => el.checkVisibility())
      .map(el => {
        const r = (${hitRectExpression})(el);
        return {name: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 60), width: r.width, height: r.height};
      }).filter(r => r.width < 44 || r.height < 44);
    const nodes = [...document.querySelectorAll(${JSON.stringify(controls + ', [data-slot="wb-count"]')})]
      .filter(el => el.checkVisibility() && getComputedStyle(el).opacity !== '0');
    const overlaps = [];
    for (let i=0; i<nodes.length; i++) for (let j=i+1; j<nodes.length; j++) {
      const a=nodes[i], b=nodes[j];
      // Row navigation contains its own pin; dnd-kit palette contains its Add action.
      if (a.contains(b) || b.contains(a)) continue;
      // The tab bar (#621) is its own grid row: a control scrolled out of the main column's bottom edge is
      // clipped there, not underneath the bar, so a rect overlap between the two is not one.
      if ((a.closest('[data-slot="mobile-tab-bar"]') && b.closest('[data-slot="main"]')) || (b.closest('[data-slot="mobile-tab-bar"]') && a.closest('[data-slot="main"]'))) continue;
      const x=(${hitRectExpression})(a), y=(${hitRectExpression})(b);
      if (Math.min(x.right,y.right)-Math.max(x.left,y.left) > 1 &&
          Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top) > 1)
        overlaps.push([a.getAttribute('aria-label') || a.textContent.trim(), b.getAttribute('aria-label') || b.textContent.trim()]);
    }
    return { small, overlaps, fitsWidth: document.documentElement.scrollWidth <= innerWidth };
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
  const result = waitForSettledSample(browser, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.scrollIntoView({block: 'center', inline: 'center'});
    const r = (${hitRectExpression})(el);
    const cx=r.left+r.width/2, cy=r.top+r.height/2;
    const points = [[r.left+1,cy], [r.right-1,cy], [cx,r.top+1], [cx,r.bottom-1], [cx,cy]];
    if (el.matches('[data-slot="wb-step-grip"], [data-slot="wb-step-actions"]'))
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

/** A native click on a control the journey reaches below the fold: scroll it to the centre first. */
function clickInView(selector: string) {
  browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center', inline: 'center' })`)
  browser.click(selector)
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

// The product supports one accent (`cezarion`), and no CSS reads `data-accent`, so the outline
// matrix checks it once per density and theme (hearsay-tools/cezarion#2905).
describe('density-independent mobile action targets (#166)', () => {
  for (const density of ['comfortable', 'compact', 'ultra']) {
    // Hit areas follow density, not theme, so the audit runs once per density.
    it(`${density}: mobile shell, composer, appearance and workflow targets`, () => {
      browser.setViewport(360, 640)
      for (const path of [`/p/${project}/new`, '/settings/global/appearance', `/p/${project}/workflows`]) {
        browser.goto(`${baseUrl}${path}`)
        browser.waitForFunction(`document.querySelector('[data-slot="composer"] textarea, [data-slot="appearance-section"], [data-slot="wb-name"]') !== null`)
        appearance(density, 'dark')
        // Below the fold at 360×640 the summary sits behind the tab bar's row until scrolled to.
        if (path.endsWith('/new')) {
          browser.evaluate(`document.querySelector('[data-slot="execution-options"] summary').scrollIntoView({ block: 'center' })`)
          browser.click('[data-slot="execution-options"] summary')
        }
        browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop = 0`)
        const audit = targetAudit()
        expect(audit.small, path).toEqual([])
        expect(audit.overlaps, path).toEqual([])
        expect(audit.fitsWidth, path).toBe(true)
      }
    })

    for (const theme of ['light', 'dark']) {
      it(`${density}/${theme}: mobile keyboard outline contrast`, () => {
        browser.setViewport(360, 640)
        browser.goto(`${baseUrl}/settings/global/appearance`)
        browser.waitForFunction(`document.querySelector('[data-slot="appearance-density"]') !== null`)
        appearance(density, theme)
        browser.evaluate(`document.querySelector('.settings-section-picker').open = true`)
        for (const selector of ['[data-slot="settings-nav-mobile"] a:last-child', '[data-slot="appearance-density"] button:nth-child(2)', '[data-slot="mobile-nav-drawer"] [data-slot="drawer-global-settings"]', '[data-slot="mobile-nav-drawer"] a[data-slot="drawer-project"]']) {
          if (selector.includes('mobile-nav-drawer') && !browser.count('[data-slot="mobile-nav-drawer"]')) {
            browser.click('[aria-label^="Open projects"]')
            browser.waitForFunction(`document.querySelector('[data-slot="mobile-nav-drawer"]')?.getBoundingClientRect().x === 0`)
          }
          focusWithKeyboard(browser, selector)
          region(selector, true)
          // Focus, outline width, opacity and contrast come from one held observation.
          const style = waitForSettledSample<{ active: boolean; width: number; opaque: boolean; contrast: ContrastSample }>(browser, `(() => {
            const el = document.querySelector(${JSON.stringify(selector)}), s = getComputedStyle(el);
            return { active: document.activeElement === el && el.matches(':focus-visible'),
              width: parseFloat(s.outlineWidth),
              opaque: (() => { for (let node=el; node; node=node.parentElement) if (getComputedStyle(node).opacity !== '1') return false; return true })(),
              contrast: ${contrastSampleExpression(selector, 'outline-color', 'parent')} };
          })()`)
          expect(style.active).toBe(true)
          expect(style.width).toBeGreaterThanOrEqual(2)
          expect(style.opaque).toBe(true)
          const sample = style.contrast
          appendFileSync(`${artifacts}/focus-${process.pid}.jsonl`, JSON.stringify({ density, theme, selector, ...sample }) + '\n')
          expect(sample.ratio, `${selector}: ${sample.foreground} on ${sample.background}`).toBeGreaterThanOrEqual(3)
        }
        browser.screenshot(`${artifacts}/focus-${density}-${theme}.png`, { viewport: true })
        // Icon-only view tabs have tooltips. Let the departed tab's tooltip
        // close before Escape addresses the drawer rather than that nested layer.
        browser.moveTo(0, 0)
        browser.waitForFunction(`document.querySelector('[data-slot="tooltip-content"]') === null`)
        browser.press('Escape')
        browser.waitForFunction(`document.querySelector('[data-slot="mobile-nav-drawer"]') === null`)
      })

      // Rendering and hit regions change with width, density and theme, so every variant keeps
      // the real pointer edge taps, the hit tests and the screenshots. The keyboard, draft and
      // choice journeys do not depend on the variant: they run once per width below.
      for (const [width, height] of [[360, 640], [1440, 900]] as const) {
        it(`${density}/${theme}/${width}: edge taps, hit regions, pending controls and rendering`, () => {
          const mobile = width === 360
          browser.setViewport(width, height)
          browser.goto(`${baseUrl}/p/${project}/new`)
          const textarea = '[data-slot="composer"] textarea'
          // The composer stays disabled until the providers query answers; wait for it before the first click.
          browser.waitForFunction(`document.querySelector('${textarea}')?.disabled === false`)
          appearance(density, theme)
          browser.waitForFunction(`document.querySelector('[data-slot="model-pill"]') !== null`)
          browser.click('[data-slot="mode-seg"] button:first-child')
          browser.click(textarea)
          browser.press('Control+a')
          browser.press('Backspace')
          const send = '[data-slot="composer"] button[aria-label="Start task"]'
          browser.waitForFunction(`document.querySelector('${send}')?.disabled === true`)
          // Empty/disabled action still reserves its space; a real tap cannot submit it.
          const disabled = waitForSettledSample(browser, `(() => {
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
          browser.waitForFunction(`document.querySelector('[data-slot="mode-plan"]').getAttribute('aria-checked') === 'true'`)
          tapEdge('[data-slot="execution-options"] summary', mobile)
          tapEdge('[data-slot="model-pill"]', mobile)
          browser.waitForFunction(`document.querySelector('[role="menu"]') !== null`)
          region('[role="menuitemradio"]', mobile)
          browser.press('ArrowDown')
          browser.press('Enter')
          browser.waitForFunction(`document.querySelector('[role="menu"]') === null`)
          if (!mobile) expect(region('[data-slot="model-pill"]', false).height).toBeGreaterThanOrEqual(44)
          browser.screenshot(`${artifacts}/${width}-${density}-${theme}-composer.png`, { viewport: true })
          if (mobile) {
            tapEdge('[aria-label^="Open projects"]', true)
            browser.waitForFunction(`document.querySelector('[data-slot="mobile-nav-drawer"]')?.getBoundingClientRect().x === 0`)
            region('[aria-label="Close menu"]', true)
          }

          browser.goto(`${baseUrl}/p/${project}`)
          browser.waitForFunction(`document.querySelector('[data-slot="main"] [data-slot="pin-toggle"]') !== null`)
          appearance(density, theme)
          const pin = mobile ? '[data-slot="task-card"] [data-slot="pin-toggle"]' : '[data-slot="main"] [role="table"] [data-slot="pin-toggle"]'
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
          expect(waitForSettledSample(browser, 'document.documentElement.scrollWidth <= innerWidth')).toBe(true)
          browser.screenshot(`${artifacts}/${width}-${density}-${theme}-follow-up.png`, { viewport: true })

          browser.goto(`${baseUrl}/p/${project}/workflows`)
          browser.waitForFunction(`document.querySelector('[data-slot="wb-step-actions"]') !== null`)
          appearance(density, theme)
          browser.click('[data-slot="wb-name"]')
          browser.press('Control+a')
          browser.press('Backspace')
          browser.waitForFunction(`document.querySelector('[data-slot="wb-name"]').value === ''`)
          browser.fill('[data-slot="wb-name"]', 'Kept workflow draft')
          expect(targetAudit().overlaps).toEqual([])
          region('[data-slot="wb-step-grip"]', mobile)
          tapEdge('[data-slot="wb-step-actions"]', mobile)
          browser.waitForFunction(`document.querySelector('[data-slot="wb-step-remove"]') !== null`)
          tapEdge('[data-slot="wb-step-remove"]', mobile)
          expect(browser.count('[data-slot="wb-step"]')).toBe(0)
          tapEdge('[data-slot="wb-skill"][data-skill="touch-check"] [data-slot="wb-skill-add"]', mobile)
          expect(browser.count('[data-slot="wb-step"]')).toBe(1)
          tapEdge('[data-slot="wb-yaml-toggle"]', mobile)
          expect(browser.evaluate(`document.querySelector('[data-slot="wb-yaml-toggle"]').parentElement.open`)).toBe(true)
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
          const pending = waitForSettledSample(browser, `(() => { const r=document.querySelector('${toggle}').getBoundingClientRect(); return {x:r.x+2,y:r.y+r.height/2,w:r.width,h:r.height}; })()`) as { x: number; y: number; w: number; h: number }
          if (mobile) {
            expect(pending.w).toBeGreaterThanOrEqual(44)
            expect(pending.h).toBeGreaterThanOrEqual(44)
          }
          browser.tapAt(Math.round(pending.x), Math.round(pending.y))
          browser.evaluate('window.releaseTouchSave(); window.fetch = window.touchFetch')
          browser.waitForFunction(`!document.querySelector('${toggle}').disabled && document.querySelector('${toggle}').getAttribute('aria-checked') !== ${JSON.stringify(before)}`)
          browser.screenshot(`${artifacts}/${width}-${density}-${theme}-settings.png`, { viewport: true })

          browser.goto(`${baseUrl}/settings/global/appearance`)
          browser.waitForFunction(`document.querySelector('[data-slot="appearance-density"]') !== null`)
          appearance(density, theme)
          const choice = `[data-slot="appearance-density"] [data-value="${density}"]`
          tapEdge(choice, mobile)
          expect(browser.evaluate(`document.querySelector(${JSON.stringify(choice)}).getAttribute('aria-checked')`)).toBe('true')
          if (mobile) {
            browser.click('.settings-section-picker summary')
            region('[data-slot="settings-nav-mobile"] a:last-child', true)
          }
          if (mobile) expect(waitForSettledSample(browser, `[...document.querySelectorAll('[data-slot="settings-nav-mobile"] a')].every(el => el.scrollWidth <= el.clientWidth)`)).toBe(true)
          expect(waitForSettledSample(browser, 'document.documentElement.scrollWidth <= innerWidth')).toBe(true)
          browser.screenshot(`${artifacts}/${width}-${density}-${theme}-appearance.png`, { viewport: true })
        }, 60_000)
      }
    }
  }
})

// The state these journeys protect does not depend on the density or theme a case starts in:
// each journey cycles density itself. The variant matrix above keeps the edge taps.
describe('keyboard, draft and choice journeys across appearance changes (hearsay-tools/cezarion#166)', () => {
  for (const [width, height] of [[360, 640], [1440, 900]] as const) {
    it(`${width}: keyboard activation, drafts, model choice and pending state survive appearance changes`, () => {
      const mobile = width === 360
      const density = 'comfortable', theme = 'dark'
      browser.setViewport(width, height)
      browser.goto(`${baseUrl}/p/${project}/new`)
      const textarea = '[data-slot="composer"] textarea'
      browser.waitForFunction(`document.querySelector('${textarea}')?.disabled === false`)
      appearance(density, theme)
      browser.waitForFunction(`document.querySelector('[data-slot="model-pill"]') !== null`)
      clickInView('[data-slot="mode-seg"] button:first-child')
      browser.click(textarea)
      browser.press('Control+a')
      browser.press('Backspace')
      const send = '[data-slot="composer"] button[aria-label="Start task"]'
      browser.waitForFunction(`document.querySelector('${send}')?.disabled === true`)
      browser.fill(textarea, 'Preserve this draft while changing density')
      browser.waitForFunction(`document.querySelector('${send}')?.disabled === false`)
      clickInView('[data-slot="mode-plan"]')
      browser.waitForFunction(`document.querySelector('[data-slot="mode-plan"]').getAttribute('aria-checked') === 'true'`)
      for (const next of ['comfortable', 'compact', 'ultra', density]) appearance(next, theme)
      expect(browser.evaluate(`document.querySelector('${textarea}').value`)).toBe('Preserve this draft while changing density')
      expect(browser.evaluate(`document.querySelector('[data-slot="mode-plan"]').getAttribute('aria-checked')`)).toBe('true')
      focus('[data-slot="mode-seg"] button:first-child')
      browser.press('Enter')
      expect(browser.evaluate(`document.querySelector('[data-slot="mode-plan"]').getAttribute('aria-checked')`)).toBe('false')
      clickInView('[data-slot="execution-options"] summary')
      clickInView('[data-slot="model-pill"]')
      browser.waitForFunction(`document.querySelector('[role="menu"]') !== null`)
      browser.press('ArrowDown')
      browser.press('Enter')
      browser.waitForFunction(`document.querySelector('[role="menu"]') === null`)
      const model = browser.text('[data-slot="model-pill"]')
      appearance('ultra', theme)
      appearance(density, theme)
      expect(browser.text('[data-slot="model-pill"]')).toBe(model)
      if (mobile) {
        clickInView('[aria-label^="Open projects"]')
        browser.waitForFunction(`document.querySelector('[data-slot="mobile-nav-drawer"]')?.getBoundingClientRect().x === 0`)
        focus('[aria-label="Close menu"]')
        browser.press('Enter')
        browser.waitForFunction(`document.querySelector('[data-slot="mobile-nav-drawer"]') === null`)
      }

      browser.goto(`${baseUrl}/p/${project}/tasks/${runId}`)
      browser.waitForFunction(`document.querySelector('[data-slot="composer"] button[aria-label="Continue"]') !== null`)
      appearance(density, theme)
      browser.fill(textarea, 'Follow-up draft')
      appearance('compact', theme)
      appearance(density, theme)
      expect(browser.evaluate(`document.querySelector('${textarea}').value`)).toBe('Follow-up draft')

      browser.goto(`${baseUrl}/p/${project}/workflows`)
      browser.waitForFunction(`document.querySelector('[data-slot="wb-step-actions"]') !== null`)
      appearance(density, theme)
      clickInView('[data-slot="wb-name"]')
      browser.press('Control+a')
      browser.press('Backspace')
      browser.waitForFunction(`document.querySelector('[data-slot="wb-name"]').value === ''`)
      browser.fill('[data-slot="wb-name"]', 'Kept workflow draft')
      clickInView('[data-slot="wb-step-actions"]')
      browser.waitForFunction(`document.querySelector('[data-slot="wb-step-remove"]') !== null`)
      clickInView('[data-slot="wb-step-remove"]')
      browser.waitForFunction(`document.querySelectorAll('[data-slot="wb-step"]').length === 0`)
      clickInView('[data-slot="wb-skill"][data-skill="touch-check"] [data-slot="wb-skill-add"]')
      browser.waitForFunction(`document.querySelectorAll('[data-slot="wb-step"]').length === 1`)
      appearance('compact', theme)
      appearance(density, theme)
      expect(browser.evaluate(`document.querySelector('[data-slot="wb-name"]').value`)).toBe('Kept workflow draft')
      // The variant matrix opens the YAML panel with an edge tap; here the keyboard toggles it.
      clickInView('[data-slot="wb-yaml-toggle"]')
      browser.waitForFunction(`document.querySelector('[data-slot="wb-yaml-toggle"]').parentElement.open === true`)
      focus('[data-slot="wb-yaml-toggle"]')
      browser.press('Enter')
      expect(browser.evaluate(`document.querySelector('[data-slot="wb-yaml-toggle"]').parentElement.open`)).toBe(false)
      browser.press('Space')
      expect(browser.evaluate(`document.querySelector('[data-slot="wb-yaml-toggle"]').parentElement.open`)).toBe(true)
      focus('[data-slot="wb-copy"]')
      browser.press('Enter')
      expect(browser.text('[data-slot="wb-copy"]')).toContain('Copied')

      browser.goto(`${baseUrl}/p/${project}/settings/agents`)
      const toggle = '[data-slot="agents-review-gate"]'
      browser.waitForFunction(`document.querySelector('${toggle}') !== null`)
      appearance(density, theme)
      const before = browser.evaluate(`document.querySelector('${toggle}').getAttribute('aria-checked')`)
      focus(toggle)
      browser.press('Space')
      browser.waitForFunction(`!document.querySelector('${toggle}').disabled && document.querySelector('${toggle}').getAttribute('aria-checked') !== ${JSON.stringify(before)}`)
      // The pending save disables the switch, which drops its focus: focus it again for the second key.
      focus(toggle)
      browser.press('Space')
      browser.waitForFunction(`!document.querySelector('${toggle}').disabled && document.querySelector('${toggle}').getAttribute('aria-checked') === ${JSON.stringify(before)}`)

      browser.goto(`${baseUrl}/settings/global/appearance`)
      browser.waitForFunction(`document.querySelector('[data-slot="appearance-density"]') !== null`)
      appearance(density, theme)
      focus(`[data-slot="appearance-density"] [data-value="${density}"]`)
    }, 60_000)
  }
})

/** Keep the next missed click diagnosable without changing its readiness or input sequence. */
function traceSidebarClick(row: string, width: number): (failed: boolean) => void {
  try {
    browser.evaluate(`(() => {
    const selector = ${JSON.stringify(row)};
    const originalRow = document.querySelector(selector);
    const originalChip = originalRow?.querySelector('[data-slot="pr-chip"]');
    const describe = el => el instanceof Element ? {
      tag: el.tagName, slot: el.getAttribute('data-slot'), text: el.textContent?.slice(0, 120),
      runId: el.closest('[data-run-id]')?.getAttribute('data-run-id'),
    } : null;
    const box = el => el?.getBoundingClientRect().toJSON() ?? null;
    const sample = () => {
      const currentRow = document.querySelector(selector);
      const chip = currentRow?.querySelector('[data-slot="pr-chip"]');
      const rect = chip?.getBoundingClientRect();
      const centre = rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
      return { time: performance.now(), row: box(currentRow), chip: box(chip), chipTarget: describe(chip), centre,
        centreHit: centre ? describe(document.elementFromPoint(centre.x, centre.y)) : null,
        sameRow: currentRow === originalRow, sameChip: chip === originalChip,
        url: location.href, viewport: { width: innerWidth, height: innerHeight } };
    };
    const initial = sample();
    const events = [];
    const types = ['pointermove', 'pointerdown', 'pointerup', 'click'];
    const listener = event => {
      if (events.length >= 16) return;
      events.push({ type: event.type, x: event.clientX, y: event.clientY,
        target: describe(event.target), path: event.composedPath().map(describe).filter(Boolean),
        hit: describe(document.elementFromPoint(event.clientX, event.clientY)), ...sample() });
    };
    types.forEach(type => document.addEventListener(type, listener, true));
    window.__sidebarClickTrace = () => {
      types.forEach(type => document.removeEventListener(type, listener, true));
      delete window.__sidebarClickTrace;
      return { selector, initial, events, final: sample() };
    };
  })()`)
  } catch (error) {
    console.error('Sidebar click trace installation unavailable:', error)
    return () => {}
  }
  return (failed) => {
    try {
      const evidence = browser.evaluate('window.__sidebarClickTrace?.()')
      if (failed) {
        const directory = resolve(import.meta.dirname, '../../../.ai/qa/failures/touch-targets')
        mkdirSync(directory, { recursive: true })
        writeFileSync(join(directory, `${width}-sidebar-row-click.json`), JSON.stringify(evidence, null, 2))
      }
    } catch (error) {
      // Diagnostic collection must preserve the click/navigation failure.
      console.error('Sidebar click evidence unavailable:', error)
    }
  }
}

describe('references on a device that cannot hover (#617 01b)', () => {
  for (const [width, height] of [[360, 640], [390, 844]] as const) {
    it(`${width}px: Session activity carries the 44px links, and the touch sidebar row is the tap target`, () => {
      browser.setViewport(width, height)
      browser.goto(`${baseUrl}/p/${project}/tasks/${runId}`)
      // The matrix above leaves its last density and theme on the root; start from the defaults.
      appearance('comfortable', 'dark')
      // The chips live in the Session activity card's Workspace row (hearsay-tools/cezarion#1333).
      openSessionActivityRow(browser, 'workspace')
      type Header = {
        noHover: boolean
        chips: Array<{ w: number; h: number; top: number; bottom: number; left: number; right: number }>
        groups: Array<{ kind: string; slots: string[] }>
        inner: number
        scroll: number
      }
      const header = waitForSettledSample(browser, `(() => {
        const chips = [...document.querySelectorAll('[data-slot="run-activity-workspace"] :is([data-slot="pr-chip"], [data-slot="issue-chip"])')]
        if (chips.length !== 2 || chips.some((chip) => chip.getBoundingClientRect().width === 0)) return null
        return { noHover: matchMedia('(hover: none)').matches, inner: innerWidth, scroll: document.documentElement.scrollWidth,
          chips: chips.map((chip) => { const r = chip.getBoundingClientRect(); return { w: r.width, h: r.height, top: Math.round(r.top), bottom: Math.round(r.bottom), left: r.left, right: r.right } }),
          groups: [...document.querySelectorAll('[data-slot="run-activity-workspace"] [data-reference-kind]')].map(group => ({
            kind: group.dataset.referenceKind,
            slots: [...group.querySelectorAll('[data-slot="pr-chip"], [data-slot="issue-chip"]')].map(chip => chip.dataset.slot),
          })) }
      })()`) as Header
      // The whole point is the touch path; a pointer-capable run would prove nothing here.
      expect(header.noHover).toBe(true)
      for (const chip of header.chips) {
        expect(chip.w, JSON.stringify(chip)).toBeGreaterThanOrEqual(44)
        expect(chip.h, JSON.stringify(chip)).toBeGreaterThanOrEqual(44)
        expect(chip.right, JSON.stringify(chip)).toBeLessThanOrEqual(header.inner)
      }
      // PRs and Issues have separate rows. Keep the 44px targets and overflow guard.
      expect(header.groups).toEqual([
        { kind: 'PR', slots: ['pr-chip'] },
        { kind: 'Issue', slots: ['issue-chip'] },
      ])
      expect(header.chips[1]!.top).toBeGreaterThanOrEqual(header.chips[0]!.bottom)
      expect(header.scroll).toBeLessThanOrEqual(header.inner)
      browser.screenshot(`${artifacts}/${width}-touch-header-references.png`, { viewport: true })

      // The sidebar row is a `hover: none` affordance, not a width one, and the phone drawer no
      // longer holds the quick list (#621): measure it in the desktop sidebar of this hover-less
      // browser. The phone half of the test is the Session activity card above.
      browser.setViewport(1440, 900)
      browser.goto(`${baseUrl}/p/${project}`)
      const row = `[data-slot="sidebar"] [data-slot="task-row"][data-run-id="${runId}"]`
      const meta = browser.waitForValue(`(() => {
        const meta = document.querySelector('${row} [data-slot="task-row-meta"]')
        if (!meta) return null
        return { text: meta.textContent, links: meta.querySelectorAll('a').length, focusable: meta.querySelectorAll('[tabindex], a, button').length,
          inert: [...meta.querySelectorAll('[data-slot="pr-chip"], [data-slot="issue-chip"]')].map((chip) => chip.dataset.inert) }
      })()`) as { text: string; links: number; focusable: number; inert: string[] }
      expect(meta.text).toMatch(/^#594#451 · /)
      expect(meta).toMatchObject({ links: 0, focusable: 0, inert: ['true', 'true'] })
      // Tapping the reference text opens the task: the row is the one target. A plain click on
      // the text, not `tapEdge`: on the 390px run its right-edge hit test missed this inline
      // span (hits [true, false, true, true, true]); the edge probes are for block controls.
      // hearsay-tools/cezarion#3048: retain event-time geometry if this click misses again.
      const finishTrace = traceSidebarClick(row, width)
      let failed = true
      try {
        browser.click(`${row} [data-slot="task-row-meta"] [data-slot="pr-chip"]`)
        browser.waitForFunction(`location.pathname.endsWith('/tasks/${runId}')`)
        failed = false
      } finally {
        finishTrace(failed)
      }
    })
  }
})
