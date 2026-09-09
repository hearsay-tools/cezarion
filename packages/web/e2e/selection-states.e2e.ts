import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { applyContrastQaVariant, contrastQaVariants, contrastSampleExpression, focusWithKeyboard, hoverVisiblePoint, type ContrastSample } from './contrast'

const originalBrowserArgs = process.env.AGENT_BROWSER_ARGS
const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
let browser: AgentBrowser
let server: ChildProcess
let root: string
let baseUrl: string
let project: string
let variantId: string
const samples: Array<{ variant: string; target: string; state: string } & ContrastSample> = []

beforeAll(async () => {
  // Headless Chrome can report hover:none even for mouse events. Exercise the actual
  // hover CSS at both widths; moving a pointer alone would silently test the rest style.
  process.env.AGENT_BROWSER_ARGS = [originalBrowserArgs, '--blink-settings=primaryHoverType=2'].filter(Boolean).join(',')
  // No Git: the real composer must disable variants while leaving model selection available.
  root = mkdtempSync(join(tmpdir(), 'cez-states-'))
  mkdirSync(join(root, '.ai/cezar'), { recursive: true })
  mkdirSync(join(root, '.ai/skills'), { recursive: true })
  for (const name of ['review', 'ship']) writeFileSync(join(root, `.ai/skills/${name}.md`), `---\ndescription: ${name} the changes\n---\nCheck the work.\n`)
  writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify(['one', 'two'].map((id) => ({
    id, title: `Review task ${id}`, task: 'Check the work', workflow: 'default', status: 'review', tokensUsed: 0,
    createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), archived: false, steps: [],
  }))))
  const probe = createServer()
  const port = await new Promise<number>((done) => probe.listen(0, '127.0.0.1', () => {
    const address = probe.address() as { port: number }
    probe.close(() => done(address.port))
  }))
  baseUrl = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(root), stdio: 'ignore',
  })
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(`${baseUrl}/api/v1/health`)).ok) break } catch { /* booting */ }
    await new Promise((done) => setTimeout(done, 250))
  }
  expect((await (await fetch(`${baseUrl}/api/v1/runs`)).json()).map((run: { id: string }) => run.id).sort()).toEqual(['one', 'two'])
  project = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(`states-${process.pid}`)
})

afterAll(() => {
  mkdirSync(artifacts, { recursive: true })
  writeFileSync(join(artifacts, 'selection-state-contrast.json'), JSON.stringify(samples, null, 2))
  browser?.close()
  if (originalBrowserArgs === undefined) delete process.env.AGENT_BROWSER_ARGS
  else process.env.AGENT_BROWSER_ARGS = originalBrowserArgs
  server?.kill()
  if (root) rmSync(root, { recursive: true, force: true })
})

function style(selector: string, pseudo?: string): Record<string, string> {
  return browser.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    const s = getComputedStyle(el, ${JSON.stringify(pseudo ?? null)})
    return { content: s.content, width: s.width, height: s.height, background: s.backgroundColor,
      border: s.borderStyle, borderColor: s.borderColor, opacity: s.opacity, outline: s.outlineStyle }
  })()`) as Record<string, string>
}

function rail(selector: string): void {
  const s = style(selector, '::before')
  expect(s.content).not.toBe('none')
  expect(parseFloat(s.width ?? '')).toBeGreaterThanOrEqual(3)
  expect(parseFloat(s.height ?? '')).toBeGreaterThanOrEqual(12)
  // Composite the pseudo-element's ink against the row's real background/ancestor surfaces.
  const expression = contrastSampleExpression(selector, 'background-color')
    .replace('getComputedStyle(element).getPropertyValue', "getComputedStyle(element, '::before').getPropertyValue")
  const sample = browser.evaluate(expression) as ContrastSample
  samples.push({ variant: variantId, target: selector, state: 'selection rail', ...sample })
  expect(sample.ratio, JSON.stringify(sample)).toBeGreaterThanOrEqual(3)
}

function focus(selector: string): void {
  focusWithKeyboard(browser, selector)
  expect(browser.evaluate(`document.querySelector(${JSON.stringify(selector)}) === document.activeElement && document.activeElement.matches(':focus-visible')`)).toBe(true)
  expect(style(selector).outline).not.toBe('none')
  const sample = browser.evaluate(contrastSampleExpression(selector, 'outline-color')) as ContrastSample
  samples.push({ variant: variantId, target: selector, state: 'keyboard focus', ...sample })
  expect(sample.ratio, JSON.stringify(sample)).toBeGreaterThanOrEqual(3)
}

describe('selection and control states (#171)', () => {
  for (const variant of contrastQaVariants) {
    it(`${variant.id}: task and skill selection have a persistent rail and accessible state`, () => {
      variantId = variant.id
      browser.setViewport(variant.viewport.width, variant.viewport.height)
      browser.goto(`${baseUrl}/p/${project}/tasks/one`)
      browser.waitForFunction(`document.querySelector('[data-slot="mobile-top-bar"]') !== null`)
      applyContrastQaVariant(browser, variant)
      if (variant.viewport.width === 360) browser.click('[data-slot="mobile-top-bar"] button')
      browser.waitForFunction(`document.querySelector('[data-slot="task-row"][data-active="true"]') !== null`)
      const container = variant.viewport.width === 360 ? '[role="dialog"] ' : ''
      const row = `${container}[data-slot="task-row"][data-active="true"]`
      const link = `${row} a[aria-current="page"]`
      browser.waitForFunction(`document.querySelector(${JSON.stringify(link)}).getBoundingClientRect().width > 0`)
      rail(row)
      expect(style(`${container}[data-slot="task-row"]:not([data-active])`, '::before').content).toBe('none')
      hoverVisiblePoint(browser, row)
      rail(row)
      focus(link)
      const nav = `${container}nav a[aria-current="page"]`
      rail(nav)
      focus(nav)
      browser.screenshot(`${artifacts}/states-tasks-${variant.id}.png`, { viewport: true })

      browser.goto(`${baseUrl}/p/${project}/skills`)
      browser.waitForFunction(`document.querySelector('[data-slot="skill-row"][aria-current="page"]') !== null`)
      applyContrastQaVariant(browser, variant)
      const skill = '[data-slot="skill-row"][aria-current="page"]'
      rail(skill)
      hoverVisiblePoint(browser, skill)
      rail(skill)
      focus(skill)
      expect((browser.evaluate(contrastSampleExpression(`${skill} span span`)) as ContrastSample).ratio).toBeGreaterThanOrEqual(4.5)
      browser.screenshot(`${artifacts}/states-skills-${variant.id}.png`, { viewport: true })
      browser.click('[data-slot="skill-row"][data-skill="ship"]')
      browser.waitForFunction(`document.querySelector('[data-slot="skill-row"][data-skill="ship"]')?.getAttribute('aria-current') === 'page'`)
      expect(browser.url()).toContain('skill=ship')
      expect(style('[data-slot="skill-row"][data-skill="review"]', '::before').content).toBe('none')
    })

    it(`${variant.id}: enabled boundaries contrast and disabled selectors remain unavailable`, () => {
      variantId = variant.id
      browser.goto(`${baseUrl}/p/${project}/new`)
      const model = 'button[data-slot="model-pill"]'
      const disabled = 'button[data-slot="variants-pill"]'
      browser.waitForFunction(`document.querySelector('${model}')?.disabled === false && document.querySelector('${disabled}')?.disabled === true`)
      applyContrastQaVariant(browser, variant)
      browser.moveTo(0, 0)
      const bounds = () => browser.evaluate(`(() => {
        const r = document.querySelector('${model}').getBoundingClientRect(); return { width: r.width, height: r.height }
      })()`)
      const originalBounds = bounds()
      const source = 'button[data-slot="source-pill"]'
      expect(style(source).border).toBe('solid')
      expect((browser.evaluate(contrastSampleExpression(source)) as ContrastSample).ratio).toBeGreaterThanOrEqual(4.5)
      const enabledStyle = style(model)
      const disabledStyle = style(disabled)
      expect(enabledStyle.border).toBe('solid')
      expect(disabledStyle.border).toBe('dashed')
      expect(disabledStyle.opacity).toBe('1')
      expect((browser.evaluate(contrastSampleExpression(disabled)) as ContrastSample).ratio).toBeGreaterThanOrEqual(4.5)
      for (const state of ['rest', 'hover', 'focus']) {
        if (state === 'hover') {
          hoverVisiblePoint(browser, model)
          expect(browser.evaluate(`({
            hover: matchMedia('(hover: hover)').matches,
            target: document.querySelector('${model}').matches(':hover'),
          })`)).toEqual({ hover: true, target: true })
          expect(style(model).background).not.toBe(enabledStyle.background)
        }
        if (state === 'focus') focus(model)
        const sample = browser.evaluate(contrastSampleExpression(model, 'border-top-color')) as ContrastSample
        samples.push({ variant: variantId, target: model, state, ...sample })
        expect(sample.ratio, `${state}: ${JSON.stringify(sample)}`).toBeGreaterThanOrEqual(3)
        expect(bounds()).toEqual(originalBounds)
        expect((browser.evaluate(contrastSampleExpression(model)) as ContrastSample).ratio).toBeGreaterThanOrEqual(4.5)
      }
      browser.press('Enter')
      browser.waitForFunction(`document.querySelector('[role="menuitemradio"][aria-checked="true"]') !== null`)
      expect(browser.evaluate(`document.querySelector('[role="menuitemradio"][aria-checked="true"] svg') !== null`)).toBe(true)
      const checked = '[role="menuitemradio"][aria-checked="true"] svg'
      const indicator = browser.evaluate(contrastSampleExpression(checked, 'fill')) as ContrastSample
      samples.push({ variant: variantId, target: checked, state: 'selected radio', ...indicator })
      expect(indicator.ratio, JSON.stringify(indicator)).toBeGreaterThanOrEqual(3)
      browser.press('ArrowDown')
      browser.press('Enter')
      browser.waitForFunction(`document.querySelector('[role="menu"]') === null`)
      // Native disabled behavior, with the actual product prop supplied by a non-Git repo.
      expect(browser.evaluate(`(() => {
        const el = document.querySelector('${disabled}'); el.click(); el.focus()
        return { disabled: el.disabled, focused: document.activeElement === el, menu: !!document.querySelector('[role="menu"]') }
      })()`)).toEqual({ disabled: true, focused: false, menu: false })
      expect(browser.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true)
      browser.screenshot(`${artifacts}/states-composer-${variant.id}.png`, { viewport: true })
    })
  }
  it('keeps the same selection cue in the grouped project navigation', () => {
    const configPath = join(root, '.cez-home/config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    const sibling = join(root, 'sibling')
    mkdirSync(sibling)
    config.projects.push({ id: 'sibling', name: 'Sibling', root: sibling, source: 'local',
      addedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() })
    writeFileSync(configPath, JSON.stringify(config))
    for (const variant of contrastQaVariants) {
      variantId = variant.id
      browser.setViewport(variant.viewport.width, variant.viewport.height)
      browser.goto(`${baseUrl}/p/${project}/tasks/one`)
      browser.waitForFunction(`document.querySelector('[data-slot="project-group-header"]') !== null`)
      applyContrastQaVariant(browser, variant)
      if (variant.viewport.width === 360) browser.click('[data-slot="mobile-top-bar"] button')
      const container = variant.viewport.width === 360 ? '[role="dialog"] ' : ''
      const nav = `${container}nav a[aria-current="page"]`
      browser.waitForFunction(`document.querySelector(${JSON.stringify(nav)})?.getBoundingClientRect().width > 0`)
      rail(nav)
      focus(nav)
      browser.screenshot(`${artifacts}/states-grouped-${variant.id}.png`, { viewport: true })
    }
  })

})
