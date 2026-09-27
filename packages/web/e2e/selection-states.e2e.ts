import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { stopFixtureServer } from './fixture-server'
import { expectGroupRowHeightMatchesTaskRow } from './row-height'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { applyContrastQaVariant, contrastQaVariants, type ContrastQaVariant, contrastSampleExpression, focusWithKeyboard, hoverVisiblePoint, type ContrastSample } from './contrast'

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
  writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify([...['one', 'two'].map((id) => ({
    id, title: `Review task ${id}`, task: 'Check the work', workflow: 'default', status: 'review', tokensUsed: 0,
    createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), archived: false, steps: [],
    // One reference, on the row this spec hovers: the pointer path keeps it a real link (#617 01b).
    ...(id === 'two' ? { referencedPullRequestUrl: 'https://github.com/o/r/pull/594' } : {}),
  })),
    // A variant group sharing one issue (#617 review round 4): its reference lives on the group
    // row's line 2 and must stay a real link with the status panel on a pointer device.
    ...['ga', 'gb'].map((id, index) => ({
      id, title: `Grouped task (${index ? 'B' : 'A'})`, task: 'Check the work', workflow: 'default', status: 'review', tokensUsed: 0,
      createdAt: new Date(Date.now() - 3_600_000).toISOString(), finishedAt: new Date(Date.now() - 3_600_000).toISOString(), archived: false, steps: [],
      groupId: 'g-sel', variant: index ? 'B' : 'A', referencedIssueUrl: 'https://github.com/o/r/issues/425',
    })),
  ]))
  // Two follow-ups for the Inbox nav count (#617 01c); the inbox itself is opt-in (CEZ_FOLLOWUPS).
  writeFileSync(join(root, '.ai/cezar/todos.json'), JSON.stringify([{ id: 'sel-1', summary: 'Review the PR' }, { id: 'sel-2', summary: 'Rerun the checks' }]))
  const probe = createServer()
  const port = await new Promise<number>((done) => probe.listen(0, '127.0.0.1', () => {
    const address = probe.address() as { port: number }
    probe.close(() => done(address.port))
  }))
  baseUrl = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(root, { CEZ_FOLLOWUPS: '1' }), stdio: 'ignore',
  })
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(`${baseUrl}/api/v1/health`)).ok) break } catch { /* booting */ }
    await new Promise((done) => setTimeout(done, 250))
  }
  expect((await (await fetch(`${baseUrl}/api/v1/runs`)).json()).map((run: { id: string }) => run.id).sort()).toEqual(['ga', 'gb', 'one', 'two'])
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

/*
 * #617 addendum 01c: one selection language. A selected nav item, New task on /new and a selected
 * task row resolve to the SAME fill; hover is the neutral row hover; badges follow their meaning.
 * Every value comes from the real stylesheet in this theme and density, in the desktop sidebar
 * and in the mobile drawer (the same nav component).
 */
function checkNavSelection(variant: ContrastQaVariant, { base, projectId, nav: navSelector }: {
  base: string; projectId: string; nav: string
}): void {
  variantId = variant.id
  const mobile = variant.viewport.width === 360
  const container = mobile ? '[role="dialog"] ' : ''
  const fill = variant.theme === 'dark'
    ? { hover: 'rgb(27, 33, 48)', selected: 'rgb(38, 44, 62)' }
    : { hover: 'rgb(244, 245, 248)', selected: 'rgb(234, 237, 243)' }
  // The addendum's hex values, as the browser serialises them (0x26 → 0.15, 0x40 → 0.25).
  const amber = variant.theme === 'dark'
    ? { fill: 'rgba(244, 197, 66, 0.15)', ink: 'rgb(244, 197, 66)' }
    : { fill: 'rgba(244, 197, 66, 0.25)', ink: 'rgb(122, 82, 0)' }
  const open = (path: string, ready: string) => {
    browser.setViewport(variant.viewport.width, variant.viewport.height)
    browser.goto(`${base}/p/${projectId}${path}`)
    browser.waitForFunction(`document.querySelector('[data-slot="mobile-top-bar"]') !== null`)
    applyContrastQaVariant(browser, variant)
    browser.moveTo(0, 0)
    if (mobile) browser.click('[data-slot="mobile-top-bar"] button')
    browser.waitForFunction(`document.querySelector(${JSON.stringify(container + ready)})?.getBoundingClientRect().width > 0`)
  }
  const record = (target: string, state: string, min: number, property = 'color') => {
    const sample = browser.evaluate(contrastSampleExpression(target, property)) as ContrastSample
    samples.push({ variant: variantId, target, state, ...sample })
    expect(sample.ratio, `${state}: ${JSON.stringify(sample)}`).toBeGreaterThanOrEqual(min)
  }
  const nav = `${container}${navSelector}`
  const tasksNav = `${nav} a[aria-current="page"]`
  const taskRow = `${container}[data-slot="task-row"][data-run-id="one"][data-active="true"]`
  const resolveFn = `const resolve = (value) => { const probe = document.createElement('span'); probe.style.color = value
    document.body.appendChild(probe); const out = getComputedStyle(probe).color; probe.remove(); return out }`
  type Facts = { tasks: string; row: string; label: string; icon: string; weight: string; ink: string
    height: number; inbox: { bg: string; color: string; text: string } | null }
  // One expression, polled whole (#409): the state checked is the state read.
  const facts = `(() => {
    const q = (sel) => document.querySelector(sel), cs = (sel) => getComputedStyle(q(sel))
    ${resolveFn}
    const inboxEl = q(${JSON.stringify(`${nav} [data-slot="nav-badge"]`)})
    return { tasks: cs(${JSON.stringify(tasksNav)}).backgroundColor, row: q(${JSON.stringify(taskRow)}) ? cs(${JSON.stringify(taskRow)}).backgroundColor : '',
      label: cs(${JSON.stringify(tasksNav)}).color, icon: cs(${JSON.stringify(`${tasksNav} svg`)}).color,
      weight: cs(${JSON.stringify(tasksNav)}).fontWeight, ink: resolve('var(--foreground)'),
      height: q(${JSON.stringify(tasksNav)}).getBoundingClientRect().height,
      inbox: inboxEl && { bg: getComputedStyle(inboxEl).backgroundColor, color: getComputedStyle(inboxEl).color, text: inboxEl.textContent } }
  })()`
  open('/tasks/one', '[data-slot="task-row"][data-run-id="one"][data-active="true"]')
  // Waited, not sampled: the inbox count lands from its own query.
  const f = browser.waitForValue(facts, (v: Facts | null) => v !== null && v.inbox?.text === '2' && v.tasks === fill.selected) as Facts
  expect({ tasks: f.tasks, row: f.row }).toEqual({ tasks: fill.selected, row: fill.selected })
  expect({ label: f.label, icon: f.icon, weight: f.weight }).toEqual({ label: f.ink, icon: f.ink, weight: '500' })
  expect({ bg: f.inbox?.bg, color: f.inbox?.color }).toEqual({ bg: amber.fill, color: amber.ink })
  // Below 48rem the unlayered floor keeps `nav a` at 44px in every density.
  if (mobile) expect(f.height).toBeGreaterThanOrEqual(44)
  record(tasksNav, 'selected nav label', 4.5)
  record(`${tasksNav} svg`, 'selected nav icon', 3)
  record(`${nav} [data-slot="nav-badge"]`, 'inbox-count number', 4.5)

  // Two badges no fixture can put on screen, resolved from their exact markup instead: the
  // skills update marker (skills-update.e2e.ts explains why Chrome cannot get one) and the Tasks
  // unread count, which only the flat fallback nav renders while the project registry is absent
  // (app-shell-container.tsx) — every booted workspace shows project groups. Each probe carries
  // the classes nav-row-styles.ts ships, sits detached on the fill it can appear on, and is
  // resolved against the real stylesheet in this theme and density.
  type Probe = { width: string; height: string; bg: string; color: string; size: string; weight: string; padding: string; radius: string
    info: string; ink: string; muted: string; sidebar: string; surface: string; ratio: number }
  const detached = (surface: string, classes: string, ink: 'color' | 'background-color') => browser.evaluate(`(() => {
    const probe = document.createElement('div'); probe.style.background = 'var(${surface})'; probe.style.display = 'flex'
    probe.innerHTML = '<span class="${classes}" style="display:block">2</span>'
    document.body.appendChild(probe)
    const tint = (value) => { const t = document.createElement('i'); t.style.color = value; probe.appendChild(t); const out = getComputedStyle(t).color; t.remove(); return out }
    const c = getComputedStyle(probe.firstElementChild), p = getComputedStyle(probe)
    const rgba = (v) => { const n = v.match(/[\\d.]+/g).map(Number); return { r: n[0], g: n[1], b: n[2], a: n[3] ?? 1 } }
    const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 })
    const lum = (x) => [x.r, x.g, x.b].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 })
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
    const back = over(rgba(${ink === 'color' ? 'c.backgroundColor' : "'rgba(0, 0, 0, 0)'"}), rgba(p.backgroundColor))
    const front = over(rgba(c.getPropertyValue('${ink}')), back)
    const a = lum(front), b = lum(back)
    const out = { width: c.width, height: c.height, bg: c.backgroundColor, color: c.color, size: c.fontSize, weight: c.fontWeight,
      padding: c.padding, radius: c.borderRadius, info: tint('var(--info)'), ink: tint('var(--foreground)'), muted: tint('var(--muted)'),
      sidebar: tint('var(--sidebar)'), surface: p.backgroundColor, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }
    probe.remove()
    return out
  })()`) as Probe
  const keep = (target: string, state: string, sample: Probe, min: number) => {
    samples.push({ variant: variantId, target, state, foreground: sample.color, background: sample.surface, ratio: sample.ratio })
    expect(sample.ratio, `${state}: ${JSON.stringify(sample)}`).toBeGreaterThanOrEqual(min)
  }
  // The update marker: a 6px --info dot, 3:1 on every fill it can sit on.
  for (const surface of ['--sidebar', '--sidebar-row-hover', '--sidebar-row-selected']) {
    const marker = detached(surface, 'size-[6px] rounded-full bg-info', 'background-color')
    expect({ width: marker.width, height: marker.height, bg: marker.bg }).toEqual({ width: '6px', height: '6px', bg: marker.info })
    keep(`update marker on ${surface}`, 'update marker', marker, 3)
  }
  // tasks-unread: neutral 11px/600, 1px 6px, radius 9px; --muted at rest, --sidebar on the selected row.
  const chipShape = 'ml-auto rounded-[9px] px-[6px] py-px text-[11px] leading-[16px] font-semibold tabular-nums text-foreground'
  for (const [surface, chipFill, expected] of [['--sidebar', 'bg-muted', 'muted'], ['--sidebar-row-hover', 'bg-muted', 'muted'], ['--sidebar-row-selected', 'bg-sidebar', 'sidebar']] as const) {
    const chip = detached(surface, `${chipShape} ${chipFill}`, 'color')
    expect({ bg: chip.bg, color: chip.color, size: chip.size, weight: chip.weight, padding: chip.padding, radius: chip.radius })
      .toEqual({ bg: chip[expected], color: chip.ink, size: '11px', weight: '600', padding: '1px 6px', radius: '9px' })
    keep(`tasks-unread on ${surface}`, 'tasks-unread number', chip, 4.5)
  }

  // Hover, any nav item: the neutral row hover, with foreground label and icon.
  const git = `${nav} a[href$="/git"]`
  hoverVisiblePoint(browser, git)
  type Ink = { bg: string; label: string; icon: string; ink: string; weight: string; width: number; height: number }
  const ink = (selector: string) => `(() => {
    const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null
    ${resolveFn}
    const s = getComputedStyle(el), r = el.getBoundingClientRect()
    return { bg: s.backgroundColor, label: s.color, icon: getComputedStyle(el.querySelector('svg')).color, ink: resolve('var(--foreground)'),
      weight: s.fontWeight, width: r.width, height: r.height }
  })()`
  const hovered = browser.waitForValue(ink(git), (v: Ink | null) => v !== null && v.bg === fill.hover) as Ink
  expect({ label: hovered.label, icon: hovered.icon }).toEqual({ label: hovered.ink, icon: hovered.ink })
  record(git, 'hover nav label', 4.5)
  record(`${git} svg`, 'hover nav icon', 3)
  browser.screenshot(`${artifacts}/states-nav-${variant.id}.png`, { viewport: true })

  // New task on /new: the same fill as the selected nav item and the selected task row.
  const newTask = `${container}[data-sidebar-item="new-task"]`
  open('/new', '[data-sidebar-item="new-task"][aria-current="page"]')
  const composer = browser.waitForValue(ink(newTask), (v: Ink | null) => v !== null && v.bg === fill.selected) as Ink
  expect({ label: composer.label, icon: composer.icon, weight: composer.weight }).toEqual({ label: composer.ink, icon: composer.ink, weight: '500' })
  record(newTask, 'new task on /new', 4.5)

  // The footer's active icon: a 36px square on the selected fill, foreground icon. Desktop only:
  // the drawer renders the same footer component, and its touch rules are not this slice's.
  if (!mobile) {
    browser.goto(`${base}/settings/global`)
    applyContrastQaVariant(browser, variant)
    const gear = '[data-slot="global-settings-link"][aria-current="page"]'
    const footer = browser.waitForValue(ink(gear), (v: Ink | null) => v !== null && v.bg === fill.selected) as Ink
    expect({ width: footer.width, height: footer.height, icon: footer.icon }).toEqual({ width: 36, height: 36, icon: footer.ink })
    record(`${gear} svg`, 'active footer icon', 3)
  }
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

    // #617 addendum 01c, in the default grouped navigation (see checkNavSelection).
    it(`${variant.id}: grouped nav items share the task row's selection, and badges follow their meaning (#617 01c)`, () => {
      checkNavSelection(variant, { base: baseUrl, projectId: project, nav: '[data-slot="project-group-body"] nav' })
    })

    if (variant.id === 'desktop-dark-comfortable') it(`${variant.id}: the group row's shared reference is a link with the status panel (#617)`, () => {
      variantId = variant.id
      browser.goto(`${baseUrl}/p/${project}/tasks/one`)
      const group = '[data-slot="group-row"][data-group-id="g-sel"]'
      const link = `${group} [data-slot="group-meta"] a[data-slot="issue-chip"]`
      browser.waitForFunction(`document.querySelector(${JSON.stringify(link)}) !== null`)
      applyContrastQaVariant(browser, variant)
      browser.waitForFunction(`document.querySelector(${JSON.stringify(link)})?.getBoundingClientRect().width > 0`)
      expect(browser.evaluate(`(() => { const a = document.querySelector(${JSON.stringify(link)}); return { href: a.getAttribute('href'), inToggle: a.closest('button') !== null, text: a.textContent } })()`))
        .toEqual({ href: 'https://github.com/o/r/issues/425', inToggle: false, text: '#425' })
      // Keyboard focus opens the same status panel a task row's reference has.
      focusWithKeyboard(browser, link)
      browser.waitForFunction(`document.querySelector('[data-slot="reference-status-card"]') !== null`)
      // …and focusing the link did not toggle the group.
      expect(browser.evaluate(`document.querySelector('${group} [data-slot="group-tile"]').getAttribute('aria-expanded')`)).toBe('false')
      browser.press('Escape')
      browser.waitForFunction(`document.querySelector('[data-slot="reference-status-card"]') === null`)
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
  // With a hover-capable pointer (this spec's primaryHoverType=2), the mobile shell still floors
  // every button at 44px (#166): the group toggle must span both lines there, not grow the row.
  it("keeps the group row a task row's height at 1440, 520 and 390px with a pointer (#617)", () => {
    expectGroupRowHeightMatchesTaskRow(browser, { url: `${baseUrl}/p/${project}/tasks/one`, groupId: 'g-sel', widths: [1440, 520, 390] })
  })

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
