// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  baselinePath,
  compareToBaseline,
  e2eDir,
  readBaseline,
  scanSource,
  scanSuite,
  shrinkBaseline,
  tally,
  type Site,
} from './e2e-wait-discipline'

/**
 * The cockpit specs' wait discipline, as a source scan (#409). A one-shot `expect(browser.…)`
 * right after an action is a sampling race waiting for load; `:hover` inside a wait never
 * settles under agent-browser's CDP pointer (#394); a predicate that scrolls moves the layout
 * the read after it depends on; a sleep stands in for a condition nobody named. Each rule is
 * pinned on a snippet here, and the suite's real sites are pinned in a baseline that can only
 * shrink — the same shape `versioned-surface.test.ts` and `bc-route-inventory.test.ts` use for
 * the API surface.
 */
const rules = (sites: Site[]) => sites.map((s) => s.rule)
const lines = (sites: Site[]) => sites.map((s) => s.line)

describe('one-shot read after an action', () => {
  it('flags an expect on a seam read within two lines of an action with no wait between', () => {
    const src = [
      `browser.click('[aria-label="Tools"]')`,
      `expect(browser.count('[role="menu"]')).toBe(1)`,
      ``,
      `browser.fill('#name', 'x')`,
      `const y = 1`,
      `expect(browser.isVisible('#saved')).toBe(true)`,
    ].join('\n')
    const sites = scanSource('x.e2e.ts', src)
    expect(rules(sites)).toEqual(['one-shot-read', 'one-shot-read'])
    expect(lines(sites)).toEqual([2, 6])
    expect(sites[0]?.site).toBe(`expect(browser.count('[role="menu"]')).toBe(1)`)
  })

  it('accepts a wait between the action and the read, and a read further than two lines away', () => {
    const src = [
      `browser.click('[aria-label="Tools"]')`,
      `browser.waitForFunction('document.querySelector("[role=menu]")')`,
      `expect(browser.count('[role="menu"]')).toBe(1)`,
      `browser.press('Escape')`,
      `const a = 1`,
      `const b = 2`,
      `expect(browser.count('[role="menu"]')).toBe(0)`,
      `browser.hover('[data-slot="row"]')`,
      `const pencil = browser.waitForValue('document.querySelector("[data-slot=pencil]")')`,
      `expect(browser.evaluate('1')).toBe(1)`,
    ].join('\n')
    expect(scanSource('x.e2e.ts', src)).toEqual([])
  })

  it('treats the contrast helpers and every seam interaction as actions', () => {
    const src = [
      `hoverVisiblePoint(browser, model)`,
      `expect(browser.evaluate('document.querySelector(".m").matches(":hover")')).toBe(true)`,
      `focusWithKeyboard(browser, model)`,
      `expect(browser.text(model)).toBe('x')`,
      `applyContrastQaVariant(browser, variant)`,
      `expect((browser.evaluate(contrastSampleExpression(model)) as ContrastSample).ratio).toBeGreaterThan(3)`,
      `stateBrowser.setViewport(360, 640)`,
      `expect(stateBrowser.url()).toContain('/tasks')`,
      `browser.moveTo(1, 2)`,
      `expect(browser.count('a')).toBe(1)`,
    ].join('\n')
    const sites = scanSource('x.e2e.ts', src)
    expect(lines(sites)).toEqual([2, 4, 6, 8, 10])
    expect(new Set(rules(sites))).toEqual(new Set(['one-shot-read']))
  })

  it('counts a read once even when two actions precede it', () => {
    const src = [`browser.click('a')`, `browser.click('b')`, `expect(browser.count('c')).toBe(1)`].join('\n')
    expect(scanSource('x.e2e.ts', src)).toHaveLength(1)
  })
})

describe(':hover inside a wait', () => {
  it('flags :hover in a waitForFunction predicate and in a waitForValue expression', () => {
    const src = [
      `browser.waitForFunction(\`document.querySelector('.m').matches(':hover')\`)`,
      `browser.waitForValue(\`(() => {`,
      `  return document.querySelector('.m').matches(':hover')`,
      `})()\`)`,
    ].join('\n')
    const sites = scanSource('x.e2e.ts', src)
    expect(rules(sites)).toEqual(['hover-in-wait', 'hover-in-wait'])
    expect(lines(sites)).toEqual([1, 2])
  })

  it('leaves a one-shot :hover assertion to the other rules', () => {
    const src = [
      `const a = 1`,
      `expect(browser.evaluate(\`document.querySelector('.m').matches(':hover')\`)).toBe(true)`,
    ].join('\n')
    expect(scanSource('x.e2e.ts', src)).toEqual([])
  })
})

describe('a predicate that scrolls', () => {
  it('flags scrollIntoView inside waitForFunction, not inside waitForValue or a plain evaluate', () => {
    const src = [
      `browser.waitForFunction(\`(() => {`,
      `  const t = document.querySelector('.m')`,
      `  t.scrollIntoView({ block: 'center' })`,
      `  return t.getClientRects().length > 0`,
      `})()\`)`,
      `browser.waitForValue(\`(() => { t.scrollIntoView(); return rect() })()\`)`,
      `browser.evaluate(\`document.querySelector('.m').scrollIntoView()\`)`,
    ].join('\n')
    const sites = scanSource('x.e2e.ts', src)
    expect(rules(sites)).toEqual(['mutating-predicate'])
    expect(lines(sites)).toEqual([1])
  })
})

describe('a sleep', () => {
  it('flags a node-side sleep and an in-page sleep', () => {
    const src = [
      `await new Promise((r) => setTimeout(r, 250))`,
      `browser.evaluate('new Promise(resolve => setTimeout(resolve, 250))')`,
    ].join('\n')
    const sites = scanSource('x.e2e.ts', src)
    expect(rules(sites)).toEqual(['sleep', 'sleep'])
  })

  it('flags a sleep inside a looping waitFor helper too — the name-based exemption is gone (#416)', () => {
    const src = [
      `async function waitForHealth(url: string): Promise<void> {`,
      `  for (let attempt = 0; attempt < 60; attempt += 1) {`,
      `    try {`,
      `      if ((await fetch(url)).ok) return`,
      `    } catch {}`,
      `    await new Promise((r) => setTimeout(r, 250))`,
      `  }`,
      `  throw new Error('never')`,
      `}`,
      ``,
      `async function waitForNothing(): Promise<void> {`,
      `  await new Promise((r) => setTimeout(r, 250))`,
      `}`,
    ].join('\n')
    const sites = scanSource('x.e2e.ts', src)
    // A spec that must poll the server imports `e2e/poll.ts`; re-copying the loop under a
    // `waitFor…` name is exactly what this rule now refuses.
    expect(rules(sites)).toEqual(['sleep', 'sleep'])
    expect(lines(sites)).toEqual([6, 12])
  })

  it('does not scan the shared poll module, which is where those sleeps now live', () => {
    expect(scanSuite().some((s) => s.file === 'poll.ts')).toBe(false)
    expect(readFileSync(join(e2eDir, 'poll.ts'), 'utf8')).toContain('setTimeout')
  })
})

describe('the baseline', () => {
  it('tallies sites by file, rule and site text, sorted', () => {
    const sites: Site[] = [
      { file: 'b.e2e.ts', rule: 'sleep', site: 's', line: 9 },
      { file: 'a.e2e.ts', rule: 'one-shot-read', site: 'expect(browser.count("x")).toBe(1)', line: 5 },
      { file: 'a.e2e.ts', rule: 'one-shot-read', site: 'expect(browser.count("x")).toBe(1)', line: 12 },
    ]
    expect(tally(sites)).toEqual([
      { file: 'a.e2e.ts', rule: 'one-shot-read', site: 'expect(browser.count("x")).toBe(1)', count: 2 },
      { file: 'b.e2e.ts', rule: 'sleep', site: 's', count: 1 },
    ])
  })

  it('reports a new site as added and a fixed site as stale', () => {
    const baseline = [
      { file: 'a.e2e.ts', rule: 'sleep' as const, site: 'old', count: 2 },
      { file: 'a.e2e.ts', rule: 'sleep' as const, site: 'gone', count: 1 },
    ]
    const actual = [
      { file: 'a.e2e.ts', rule: 'sleep' as const, site: 'old', count: 1 },
      { file: 'a.e2e.ts', rule: 'sleep' as const, site: 'new', count: 1 },
    ]
    const { added, stale } = compareToBaseline(actual, baseline)
    expect(added).toEqual([{ file: 'a.e2e.ts', rule: 'sleep', site: 'new', count: 1 }])
    // Both a lowered count and a vanished site are stale: the baseline must shrink to match.
    expect(stale).toEqual([
      { file: 'a.e2e.ts', rule: 'sleep', site: 'old', count: 2 },
      { file: 'a.e2e.ts', rule: 'sleep', site: 'gone', count: 1 },
    ])
  })
})

describe('the cockpit suite', () => {
  it('scans every spec and the browser-driving helpers', () => {
    const files = new Set(scanSuite().map((s) => s.file))
    // Sanity: the scan covers the whole directory, not one file.
    expect(files.size).toBeGreaterThan(10)
    expect(readFileSync(join(e2eDir, 'contrast.ts'), 'utf8')).toContain('waitForValue')
  })

  it('has no wait-discipline site outside the baseline, and the baseline names no site that is gone', () => {
    const actual = tally(scanSuite())
    // Update mode shrinks the baseline to what the suite has now; it never adds to it.
    if (process.env.E2E_WAIT_DISCIPLINE_UPDATE === '1') shrinkBaseline(actual)
    const { added, stale } = compareToBaseline(actual, readBaseline())
    const describeSites = (entries: typeof added) =>
      entries.map((e) => `  ${e.file} [${e.rule}] ×${e.count}: ${e.site}`).join('\n')
    expect(
      added,
      `New wait-discipline sites (see packages/web/e2e/README.md). Give each a wait rather than adding it to ${baselinePath}:\n${describeSites(added)}`,
    ).toEqual([])
    expect(
      stale,
      `Baseline entries no longer found; shrink ${baselinePath} (E2E_WAIT_DISCIPLINE_UPDATE=1 npm test -- e2e-wait-discipline does it):\n${describeSites(stale)}`,
    ).toEqual([])
  })
})
