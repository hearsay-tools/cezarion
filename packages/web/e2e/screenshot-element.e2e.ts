import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { AgentBrowser } from './agent-browser'

let browser: AgentBrowser
beforeAll(() => { browser = AgentBrowser.open(`e2e-element-${process.pid}`) })
afterAll(() => browser?.close())

// A provider fixture, not application DOM: a long inner scroller and an overlapping sticky
// header reproduce hearsay-tools/cezarion#1135 without relying on transcript length.
const fixture = `<!doctype html><html><body style="margin:0">
<main style="block-size:100dvh;overflow:auto">
<header style="position:sticky;inset-block-start:0;block-size:96px;background:oklch(1 0 none);z-index:1">Task header</header>
<div style="block-size:1200px"></div>
<article id="target" style="block-size:160px;background:oklch(0.85 0.08 220)">QA target</article>
<div style="block-size:1200px"></div></main></body></html>`
const rect = `(() => {
  const target = document.querySelector('#target'), r = target.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, height: innerHeight,
    uncovered: document.elementFromPoint(r.left + 1, r.top + 1) === target };
})()`

describe('element QA evidence (hearsay-tools/cezarion#1135)', () => {
  it.each([[1440, 900, 160], [390, 844, 160], [390, 844, 700]])('frames a %ix%i viewport target of height %i below the sticky header', (width, height, targetHeight) => {
    browser.setViewport(width, height)
    browser.goto(`data:text/html,${encodeURIComponent(fixture.replace('block-size:160px', `block-size:${targetHeight}px`))}`)
    browser.evaluate(`document.querySelector('main').scrollTop = 9999`)
    const offscreen = browser.waitForValue<{ bottom: number }>(rect)
    expect(offscreen.bottom).toBeLessThan(0)
    browser.evaluate(`document.querySelector('#target').scrollIntoView({ block: 'start', behavior: 'instant' })`)
    const covered = browser.waitForValue<{ uncovered: boolean }>(rect)
    expect(covered.uncovered).toBe(false)
    browser.screenshotElement('#target', resolve(import.meta.dirname, `../../../.ai/qa/artifacts/issue-1135-${width}-${targetHeight}.png`))
    const captured = browser.waitForValue<{ top: number; bottom: number; height: number; uncovered: boolean }>(rect)
    expect(captured.top).toBeGreaterThanOrEqual(96)
    expect(captured.bottom).toBeLessThanOrEqual(captured.height)
    expect(captured.uncovered).toBe(true)
  })
})
