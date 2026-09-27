import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { stopFixtureServer } from './fixture-server'
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
    // One reference, on the row this spec hovers: the pointer path keeps it a real link (#617 01b).
    ...(id === 'two' ? { referencedPullRequestUrl: 'https://github.com/o/r/pull/594' } : {}),
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

afterAll(async () => {
  mkdirSync(artifacts, { recursive: true })
  writeFileSync(join(artifacts, 'selection-state-contrast.json'), JSON.stringify(samples, null, 2))
  browser?.close()
  if (originalBrowserArgs === undefined) delete process.env.AGENT_BROWSER_ARGS
  else process.env.AGENT_BROWSER_ARGS = originalBrowserArgs
  await stopFixtureServer(server)
  if (root) rmSync(root, { recursive: true, force: true })
})

function style(selector: string, pseudo?: string): Record<string, string> {
  return browser.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    const s = getComputedStyle(el, ${JSON.stringify(pseudo ?? null)})
    return { content: s.content, width: s.width, height: s.height, background: s.backgroundColor, color: s.color,
      border: s.borderStyle, borderColor: s.borderColor, opacity: s.opacity, outline: s.outlineStyle }
  })()`) as Record<string, string>
}

function selectedSurface(selector: string, filled = true): void {
  const facts = browser.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const s = getComputedStyle(el), parent = getComputedStyle(el.parentElement);
    return { background: s.backgroundColor, color: s.color, parent: parent.backgroundColor,
      selected: el.getAttribute('data-active') === 'true' || el.getAttribute('aria-current') === 'page' };
  })()`) as { background: string; parent: string; selected: boolean }
  expect(facts.selected).toBe(true)
  if (filled) {
    expect(facts.background).not.toBe('rgba(0, 0, 0, 0)')
    expect(facts.background).not.toBe(facts.parent)
  }
  const sample = browser.evaluate(contrastSampleExpression(selector)) as ContrastSample
  samples.push({ variant: variantId, target: selector, state: 'selected surface text', ...sample })
  expect(sample.ratio, JSON.stringify(sample)).toBeGreaterThanOrEqual(4.5)
}

function focus(selector: string): void {
  focusWithKeyboard(browser, selector)
  expect(browser.evaluate(`document.querySelector(${JSON.stringify(selector)}) === document.activeElement && document.activeElement.matches(':focus-visible')`)).toBe(true)
  expect(style(selector).outline).not.toBe('none')
  const sample = browser.evaluate(contrastSampleExpression(selector, 'outline-color', 'parent')) as ContrastSample
  samples.push({ variant: variantId, target: selector, state: 'keyboard focus', ...sample })
  expect(sample.ratio, JSON.stringify(sample)).toBeGreaterThanOrEqual(3)
}

describe('selection and control states (#171)', () => {
  for (const variant of contrastQaVariants) {
    it(`${variant.id}: task and skill selection have persistent selected states and accessible state`, () => {
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
      selectedSurface(row)
      expect(style(`${container}[data-slot="task-row"]:not([data-active])`, '::before').content).toBe('none')
      hoverVisiblePoint(browser, row)
      selectedSurface(row)
      focus(link)
      const nav = `${container}nav a[aria-current="page"]`
      selectedSurface(nav)
      focus(nav)
      browser.screenshot(`${artifacts}/states-tasks-${variant.id}.png`, { viewport: true })

      browser.goto(`${baseUrl}/p/${project}/skills`)
      browser.waitForFunction(`document.querySelector('[data-slot="skill-row"][aria-current="page"]') !== null`)
      applyContrastQaVariant(browser, variant)
      const skill = '[data-slot="skill-row"][aria-current="page"]'
      // Source10C/10D uses uniform mobile rows; desktop selection has a filled surface.
      selectedSurface(skill, variant.viewport.width !== 360)
      hoverVisiblePoint(browser, skill)
      // Source10C/10D uses uniform mobile rows; desktop selection has a filled surface.
      selectedSurface(skill, variant.viewport.width !== 360)
      focus(skill)
      expect((browser.evaluate(contrastSampleExpression(`${skill} span span`)) as ContrastSample).ratio).toBeGreaterThanOrEqual(4.5)
      browser.screenshot(`${artifacts}/states-skills-${variant.id}.png`, { viewport: true })
      browser.click('[data-slot="skill-row"][data-skill="ship"]')
      browser.waitForFunction(`document.querySelector('[data-slot="skill-row"][data-skill="ship"]')?.getAttribute('aria-current') === 'page'`)
      expect(browser.url()).toContain('skill=ship')
      browser.waitForFunction(`document.querySelector('[data-slot="skills-detail"]')?.textContent.includes('ship')`)
      expect(style('[data-slot="skill-row"][data-skill="review"]', '::before').content).toBe('none')
    })

    // The calmer sidebar row (#617). Desktop only: the drawer at 360px is the same component,
    // and this spec's primaryHoverType=2 flag is what makes `hover:` CSS resolve at all.
    if (variant.viewport.width === 1440) it(`${variant.id}: the sidebar row keeps its geometry under the pointer and its ink readable (#617)`, () => {
      variantId = variant.id
      browser.goto(`${baseUrl}/p/${project}/tasks/one`)
      browser.waitForFunction(`document.querySelector('[data-slot="task-row"][data-run-id="one"][data-active="true"] [data-slot="task-row-meta"]') !== null`)
      applyContrastQaVariant(browser, variant)
      browser.moveTo(0, 0)
      const selected = '[data-slot="task-row"][data-run-id="one"]'
      const other = '[data-slot="task-row"][data-run-id="two"]'
      // The tokens the issue names, resolved by the real stylesheet in this theme.
      const fill = variant.theme === 'dark'
        ? { hover: 'rgb(27, 33, 48)', selected: 'rgb(38, 44, 62)' }
        : { hover: 'rgb(244, 245, 248)', selected: 'rgb(234, 237, 243)' }
      type Geometry = { title: string; row: number; bg: string; pin: string | null }
      const geometry = (selector: string) => `(() => {
        const row = document.querySelector(${JSON.stringify(selector)})
        const t = row.querySelector('[data-slot="task-row-title"]').getBoundingClientRect()
        const pin = row.querySelector('[data-slot="pin-toggle"]')
        return { title: [t.left, t.top, t.width, t.height].map(Math.round).join(','), row: Math.round(row.getBoundingClientRect().height),
          bg: getComputedStyle(row).backgroundColor, pin: pin && getComputedStyle(pin).opacity }
      })()`
      // At rest: no fill, pin invisible (its slot is still reserved).
      const rest = browser.waitForValue(geometry(other), (g: Geometry) => g.bg === 'rgba(0, 0, 0, 0)' && g.pin === '0') as Geometry
      expect(browser.evaluate(`getComputedStyle(document.querySelector('${selected}')).backgroundColor`)).toBe(fill.selected)
      hoverVisiblePoint(browser, other)
      // Hovered: the neutral hover fill and the pin revealed — and the title box and the row
      // height identical to rest, to the pixel. This is the jump the old w-0→w-5 pin caused.
      const hovered = browser.waitForValue(geometry(other), (g: Geometry) => g.bg === fill.hover && g.pin === '1') as Geometry
      expect({ title: hovered.title, row: hovered.row }).toEqual({ title: rest.title, row: rest.row })
      // The row as the issue specifies it, from the resolved stylesheet rather than the classes:
      // nothing in a later sheet may restyle it (an override layer once clamped the title to two
      // 12px lines and painted the selected title teal).
      const resolved = browser.evaluate(`(() => {
        const row = document.querySelector('${selected}'), s = getComputedStyle(row)
        const t = getComputedStyle(row.querySelector('[data-slot="task-row-title"]'))
        const m = getComputedStyle(row.querySelector('[data-slot="task-row-meta"]'))
        const d = getComputedStyle(row.querySelector('[data-slot="status-dot"]'))
        const probe = document.createElement('span'); probe.style.color = 'var(--foreground)'
        document.body.append(probe); const ink = getComputedStyle(probe).color; probe.remove()
        return { padding: s.padding, radius: s.borderRadius, titleSize: t.fontSize, titleWeight: t.fontWeight,
          titleWrap: t.whiteSpace, titleOverflow: t.textOverflow, titleInk: t.color === ink, metaSize: m.fontSize,
          metaWrap: m.whiteSpace, dot: d.width + ' ' + d.height, metaHeight: m.height,
          dotSlot: getComputedStyle(row.querySelector('[data-slot="task-row-dot"]')).width,
          trailing: getComputedStyle(row.querySelector('[data-slot="task-row-trailing"]')).width }
      })()`) as Record<string, string | boolean>
      // Padding follows the density scale (`ultra` shrinks `--spacing`); the rest is fixed px.
      expect(resolved).toEqual({ padding: variant.density === 'comfortable' ? '6px 8px 6px 10px' : resolved.padding, radius: '6px',
        titleSize: '13px', titleWeight: '500', titleWrap: 'nowrap', titleOverflow: 'ellipsis', titleInk: true, metaSize: '11.5px',
        metaWrap: 'nowrap', dot: '7px 7px', metaHeight: '16px', dotSlot: '12px', trailing: '16px' })
      // With a hover-capable pointer the reference is a real link (on touch it is plain text).
      expect(browser.evaluate(`(() => { const a = document.querySelector('${other} [data-slot="task-row-meta"] [data-slot="pr-chip"]'); return a && { tag: a.tagName, href: a.getAttribute('href') } })()`))
        .toEqual({ tag: 'A', href: 'https://github.com/o/r/pull/594' })
      // Every row is the same two-line height.
      expect(browser.evaluate(`Math.round(document.querySelector('${selected}').getBoundingClientRect().height)`)).toBe(rest.row)
      // Ink on both fills: text at 4.5:1, the status dot as a non-text mark at 3:1.
      for (const [row, state] of [[selected, 'selected'], [other, 'hover']] as const) {
        for (const part of ['[data-slot="task-row-title"]', '[data-slot="task-row-meta"]']) {
          const sample = browser.evaluate(contrastSampleExpression(`${row} ${part}`)) as ContrastSample
          samples.push({ variant: variantId, target: `${row} ${part}`, state: `${state} row text`, ...sample })
          expect(sample.ratio, `${state} ${part}: ${JSON.stringify(sample)}`).toBeGreaterThanOrEqual(4.5)
        }
        const dot = browser.evaluate(contrastSampleExpression(`${row} [data-slot="status-dot"]`, 'background-color', 'parent')) as ContrastSample
        samples.push({ variant: variantId, target: `${row} status-dot`, state: `${state} row dot`, ...dot })
        expect(dot.ratio, `${state} dot: ${JSON.stringify(dot)}`).toBeGreaterThanOrEqual(3)
      }
      const pin = browser.evaluate(contrastSampleExpression(`${other} [data-slot="pin-toggle"]`, 'color', 'parent')) as ContrastSample
      samples.push({ variant: variantId, target: `${other} pin`, state: 'hover pin', ...pin })
      expect(pin.ratio, `pin: ${JSON.stringify(pin)}`).toBeGreaterThanOrEqual(3)
      browser.screenshot(`${artifacts}/states-sidebar-row-${variant.id}.png`, { viewport: true })
    })

    it(`${variant.id}: enabled control icons contrast and disabled selectors remain unavailable`, () => {
      variantId = variant.id
      browser.goto(`${baseUrl}/p/${project}/new`)
      const model = 'button[data-slot="model-pill"]'
      const disabled = 'button[data-slot="variants-pill"]'
      browser.waitForFunction(`document.querySelector('${model}')?.disabled === false && document.querySelector('${disabled}')?.disabled === true`)
      applyContrastQaVariant(browser, variant)
      browser.click('[data-slot="execution-options"] summary')
      browser.moveTo(0, 0)
      const bounds = () => browser.evaluate(`(() => {
        const r = document.querySelector('${model}').getBoundingClientRect(); return { width: r.width, height: r.height }
      })()`) as { width: number; height: number }
      const originalBounds = bounds()
      if (variant.viewport.width === 360) {
        expect(originalBounds.width).toBeGreaterThanOrEqual(44)
        expect(originalBounds.height).toBeGreaterThanOrEqual(44)
      }
      const source = 'button[data-slot="source-pill"]'
      expect(style(source).border).toBe('solid')
      expect((browser.evaluate(contrastSampleExpression(source)) as ContrastSample).ratio).toBeGreaterThanOrEqual(4.5)
      const enabledStyle = style(model)
      const disabledStyle = style(disabled)
      expect(enabledStyle.border).toBe('solid')
      expect(browser.evaluate(`document.querySelector('${disabled}').disabled`)).toBe(true)
      expect(disabledStyle.opacity).toBe('1')
      expect((browser.evaluate(contrastSampleExpression(disabled)) as ContrastSample).ratio).toBeGreaterThanOrEqual(4.5)
      for (const state of ['rest', 'hover', 'focus']) {
        if (state === 'hover') {
          hoverVisiblePoint(browser, model)
          expect(browser.evaluate(`({
            hover: matchMedia('(hover: hover)').matches,
            target: document.querySelector('${model}').matches(':hover'),
          })`)).toEqual({ hover: true, target: true })
        }
        if (state === 'focus') focus(model)
        // Source1A/1B has no model border; source23 uses a subtle1px border (1.26/1.39:1).
        // The CPU glyph and label identify the control. Focus is independently checked above.
        const sample = browser.evaluate(contrastSampleExpression(`${model} svg`, 'color')) as ContrastSample
        samples.push({ variant: variantId, target: model, state: `${state} icon`, ...sample })
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
      selectedSurface(nav)
      focus(nav)
      browser.screenshot(`${artifacts}/states-grouped-${variant.id}.png`, { viewport: true })
    }
  })

})
