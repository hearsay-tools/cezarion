import { execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { AgentBrowser, cezarCli, fixtureServeEnv } from './agent-browser'
import { focusWithKeyboard, contrastSampleExpression, type ContrastSample } from './contrast'
import { waitForSettledSample } from './visual-ready'

// Real application controls and computed CSS, not copies of primitive class strings.
let browser: AgentBrowser
let baseUrl: string
let server: ChildProcess
let root: string
const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e/good-css')
beforeAll(async () => {
  mkdirSync(artifacts, { recursive: true })
  root = mkdtempSync(join(tmpdir(), 'cez-good-css-'))
  mkdirSync(join(root, '.codex'), { recursive: true })
  writeFileSync(join(root, '.codex/config.toml'), '# A readable syntax comment\nmodel = "example"\n')
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'CSS fixture')
  git('config', 'user.email', 'css@cezar.test')
  writeFileSync(join(root, 'comments.ts'), '// The original comment remains readable.\n')
  git('add', '.')
  git('commit', '-qm', 'Fixture')
  writeFileSync(join(root, 'comments.ts'), '// The updated comment remains readable.\n')
  for (let i = 0; i < 30; i++) mkdirSync(join(root, `folder-${i}`))
  server = spawnFixtureServer([cezarCli, 'serve', '--repo', root, '--port', '0', '--no-open'], {
    env: fixtureServeEnv(root, { CEZ_BROWSE_ROOT: root }), stdio: 'ignore',
  })
  baseUrl = await waitForFixtureServer(server)
  browser = AgentBrowser.open(`good-css-${process.pid}`)
})
afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (root) rmSync(root, { recursive: true, force: true })
})

function open(path: string, selector: string, width = 1440, height = 900) {
  browser.setViewport(width, height)
  browser.goto(`${baseUrl}${path}`)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(selector)})?.checkVisibility() === true`)
}
async function withMedia(features: { name: string; value: string }[], work: () => void) {
  const url = browser.url()
  await browser.withCdp(async request => {
    const { targetInfos } = await request('Target.getTargets')
    const target = targetInfos.find((t: { type: string; url: string }) => t.type === 'page' && t.url === url)
    const { sessionId } = await request('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    await request('Emulation.setEmulatedMedia', { features }, sessionId)
    try { work() } finally { await request('Emulation.setEmulatedMedia', { features: [] }, sessionId) }
  })
}

for (const theme of ['light', 'dark']) {
  it(`${theme}: keyboard focus survives forced colors at desktop widths`, async () => {
    const selector = '[data-slot="wb-new"]'
    open('/workflows', selector)
    browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'})`)
    await withMedia([{ name: 'forced-colors', value: 'active' }], () => {
      expect(browser.evaluate(`matchMedia('(forced-colors: active)').matches`)).toBe(true)
      focusWithKeyboard(browser, selector)
      const focus = waitForSettledSample<{ outline: string; width: number; focused: boolean }>(browser, `(() => {
        const el = document.querySelector('${selector}'), s = getComputedStyle(el);
        return { outline: s.outlineStyle, width: parseFloat(s.outlineWidth), focused: el.matches(':focus-visible') };
      })()`)
      expect(focus.focused).toBe(true)
      expect(focus.outline).toBe('solid')
      expect(focus.width).toBeGreaterThanOrEqual(2)
    })
  })
}

it('mobile workflow editable text stays at least 16px despite route styles', () => {
  const selector = '[data-slot="wb-description"]'
  open('/workflows', selector, 390, 844)
  const size = waitForSettledSample<number>(browser, `parseFloat(getComputedStyle(document.querySelector('${selector}')).fontSize)`)
  expect(size).toBeGreaterThanOrEqual(16)
})

it('reduced motion removes switch translation transitions', async () => {
  const selector = '[data-slot="switch-thumb"]'
  open('/settings/global/resources', selector)
  await withMedia([{ name: 'prefers-reduced-motion', value: 'reduce' }], () => {
    expect(browser.evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`)).toBe(true)
    const duration = waitForSettledSample<string>(browser, `getComputedStyle(document.querySelector('${selector}')).transitionDuration`)
    expect(duration.split(',').every(value => parseFloat(value) === 0)).toBe(true)
  })
})

for (const theme of ['light', 'dark']) {
  it(`${theme}: editor metrics, keyboard focus and syntax comments remain readable`, async () => {
    open('/settings/agent-config', '[data-slot="agent-config-agent"][data-agent="codex"]', 390, 844)
    browser.click('[data-slot="agent-config-agent"][data-agent="codex"]')
    browser.waitForFunction(`document.querySelector('[data-slot="agent-config-agent"][data-agent="codex"]').getAttribute('aria-selected') === 'true'`)
    browser.evaluate(`[...document.querySelectorAll('[data-slot="agent-config-file"]')].find(el => el.textContent.trim() === '.codex/config.toml').click()`)
    const input = '[data-slot="code-editor-input"]'
    const comment = '[data-slot="code-editor"] pre [style*="--syn-com"]'
    browser.waitForFunction(`document.querySelector('${comment}') !== null`)
    browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'})`)
    focusWithKeyboard(browser, input)
    const facts = waitForSettledSample<{ input: number; pre: number; outline: string }>(browser, `(() => {
      const editor = document.querySelector('[data-slot="code-editor"]');
      return { input: parseFloat(getComputedStyle(editor.querySelector('textarea')).fontSize),
        pre: parseFloat(getComputedStyle(editor.querySelector('pre')).fontSize), outline: getComputedStyle(editor).outlineStyle };
    })()`)
    expect(facts.input).toBeGreaterThanOrEqual(16)
    expect(facts.pre).toBe(facts.input)
    expect(facts.outline).toBe('solid')
    const contrast = waitForSettledSample<ContrastSample>(browser, contrastSampleExpression(comment))
    expect(contrast.ratio, JSON.stringify(contrast)).toBeGreaterThanOrEqual(4.5)
    browser.screenshot(`${artifacts}/editor-${theme}.png`, { viewport: true })
    await withMedia([{ name: 'forced-colors', value: 'active' }], () => {
      expect(browser.evaluate(`matchMedia('(forced-colors: active)').matches`)).toBe(true)
      const outline = waitForSettledSample<string>(browser, `getComputedStyle(document.querySelector('[data-slot="code-editor"]')).outlineStyle`)
      expect(outline).toBe('solid')
    })
  })
}

it('touch-capable tablets reserve real button boxes at every density', async () => {
  open('/workflows', '[data-slot="wb-new"]', 1024, 768)
  const url = browser.url()
  await browser.withCdp(async request => {
    const { targetInfos } = await request('Target.getTargets')
    const target = targetInfos.find((t: { type: string; url: string }) => t.type === 'page' && t.url === url)
    const { sessionId } = await request('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    await request('Emulation.setTouchEmulationEnabled', { enabled: true }, sessionId)
    try {
      expect(browser.evaluate(`matchMedia('(any-pointer: coarse)').matches`)).toBe(true)
      for (const density of ['comfortable', 'compact', 'ultra']) {
        browser.evaluate(`document.documentElement.dataset.density = '${density}'`)
        const targets = waitForSettledSample<{ width: number; height: number }[]>(browser, `
          [...document.querySelectorAll('[data-slot="wb-actions"] button')].filter(el => el.checkVisibility()).map(el => {
            const r = el.getBoundingClientRect(); return { width: r.width, height: r.height };
          })`)
        expect(targets.length).toBeGreaterThan(0)
        for (const target of targets) {
          expect(target.width).toBeGreaterThanOrEqual(44)
          expect(target.height).toBeGreaterThanOrEqual(44)
        }
      }
    } finally {
      await request('Emulation.setTouchEmulationEnabled', { enabled: false }, sessionId)
      browser.evaluate(`delete document.documentElement.dataset.density`)
    }
  })
})

it('composer rewraps on resize without losing its draft or focus', () => {
  const selector = '[data-slot="composer"] textarea'
  open('/new', selector, 1440, 900)
  const draft = 'A task description with enough words to grow on a narrow screen. '.repeat(5)
  browser.fill(selector, draft)
  const before = waitForSettledSample<number>(browser, `document.querySelector('${selector}').getBoundingClientRect().height`)
  browser.setViewport(800, 900)
  const result = waitForSettledSample<{ value: string; focused: boolean; height: number; scroll: number }>(browser, `(() => {
    const el = document.querySelector('${selector}'); return { value: el.value, focused: document.activeElement === el,
      height: el.getBoundingClientRect().height, scroll: el.scrollHeight };
  })()`)
  expect(result.value).toBe(draft)
  expect(result.focused).toBe(true)
  expect(result.height).toBeGreaterThan(before)
  expect(result.height).toBeLessThanOrEqual(220)
  expect(result.scroll).toBeGreaterThan(result.height)
  browser.fill(selector, 'Short draft')
  const shrunk = waitForSettledSample<number>(browser, `document.querySelector('${selector}').getBoundingClientRect().height`)
  expect(shrunk).toBeLessThan(result.height)
})

it('folder dialog keeps its actions inside a short viewport with enlarged text', () => {
  open('/settings/global/projects', '[data-slot="projects-section"]', 360, 640)
  browser.click('[data-slot="projects-section"] > button')
  browser.waitForFunction(`document.querySelector('[data-slot="add-project-dialog"]') !== null`)
  browser.evaluate(`document.documentElement.style.fontSize = '24px'`)
  try {
    const result = waitForSettledSample<{ top: number; bottom: number; body: string }>(browser, `(() => {
      const el = document.querySelector('[data-slot="add-project-confirm"]'), r = el.getBoundingClientRect();
      const dialog = document.querySelector('[data-slot="add-project-dialog"]');
      return { top: r.top, bottom: r.bottom, body: getComputedStyle(dialog.querySelector('[data-slot="dialog-body"]')).overflowY };
    })()`)
    expect(result.top).toBeGreaterThanOrEqual(0)
    expect(result.bottom).toBeLessThanOrEqual(640)
    expect(result.body).toBe('auto')
    browser.screenshot(`${artifacts}/dialog-enlarged-text.png`, { viewport: true })
  } finally { browser.evaluate(`document.documentElement.style.removeProperty('font-size')`) }
})

it('reduced-motion dialogs open and close without movement', async () => {
  open('/settings/global/projects', '[data-slot="projects-section"]', 360, 640)
  await withMedia([{ name: 'prefers-reduced-motion', value: 'reduce' }], () => {
    browser.click('[data-slot="projects-section"] > button')
    browser.waitForFunction(`document.querySelector('[data-slot="add-project-dialog"]') !== null`)
    const animation = waitForSettledSample<string>(browser, `getComputedStyle(document.querySelector('[data-slot="add-project-dialog"]')).animationName`)
    expect(animation).toBe('none')
    browser.press('Escape')
    browser.waitForFunction(`document.querySelector('[data-slot="add-project-dialog"]') === null`)
  })
})

it('older-browser composer fallback responds to width changes and keeps focus', () => {
  const selector = '[data-slot="composer"] textarea'
  open('/new', selector, 1440, 900)
  // Navigation restores the previous test's draft. Clear it through React-observed
  // keyboard input before fill: direct value clearing can retain controlled state.
  browser.click(selector)
  browser.press('Control+a')
  browser.press('Backspace')
  browser.waitForFunction(`document.querySelector('${selector}').value === ''`)
  // Simulate an engine lacking field-sizing without replacing the textarea or its React state.
  browser.evaluate(`window.__originalSupports = CSS.supports; CSS.supports = (...args) => args[0] === 'field-sizing' ? false : window.__originalSupports(...args)`)
  try {
    const draft = 'A task description with enough words to grow on a narrow screen. '.repeat(5)
    browser.fill(selector, draft)
    const before = waitForSettledSample<number>(browser, `document.querySelector('${selector}').getBoundingClientRect().height`)
    browser.setViewport(800, 900)
    const after = waitForSettledSample<{ height: number; explicit: string; focused: boolean; value: string }>(browser, `(() => {
      const el = document.querySelector('${selector}'); return { height: el.getBoundingClientRect().height,
        explicit: el.style.height, focused: document.activeElement === el, value: el.value };
    })()`)
    expect(after.explicit).not.toBe('')
    expect(after.height).toBeGreaterThan(before)
    expect(after.height).toBeLessThanOrEqual(220)
    expect(after.focused).toBe(true)
    expect(after.value).toBe(draft)
  } finally { browser.evaluate(`CSS.supports = window.__originalSupports; delete window.__originalSupports`) }
})

for (const theme of ['light', 'dark']) {
  it(`${theme}: syntax comments pass AA on actual diff word highlights`, () => {
    const add = '[data-word="add"][style*="--syn-com"]'
    const del = '[data-word="del"][style*="--syn-com"]'
    open('/git/changes', add)
    browser.waitForFunction(`document.querySelector('${del}') !== null`)
    browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'})`)
    for (const selector of [add, del]) {
      const sample = waitForSettledSample<ContrastSample>(browser, contrastSampleExpression(selector))
      expect(sample.ratio, JSON.stringify(sample)).toBeGreaterThanOrEqual(4.5)
    }
    browser.screenshot(`${artifacts}/diff-${theme}.png`, { viewport: true })
  })
}
