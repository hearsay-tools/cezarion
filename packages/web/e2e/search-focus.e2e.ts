import { execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { AgentBrowser, squawkCli, fixtureServeEnv } from './agent-browser'
import { contrastSampleExpression, dismissWithEscape, type ContrastSample } from './contrast'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { settleVisual, waitForSettledSample } from './visual-ready'
// fixture-server starts: 1

let browser: AgentBrowser
let server: ChildProcess
let root: string
let baseUrl: string
const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e/search-focus')

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cez-search-focus-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Focus fixture')
  git('config', 'user.email', 'focus@cezar.test')
  mkdirSync(join(root, '.ai/skills'), { recursive: true })
  writeFileSync(join(root, '.ai/skills/focus-fixture.md'), '---\ndescription: Focus fixture\n---\nReview the change.\n')
  git('add', '.')
  git('commit', '-qm', 'Fixture')
  git('branch', 'feature/a-long-branch-name-that-widens-the-base-branch-search-menu')
  mkdirSync(artifacts, { recursive: true })
  server = spawnFixtureServer([squawkCli, 'serve', '--repo', root, '--port', '0', '--no-open'], {
    env: fixtureServeEnv(root), stdio: 'ignore',
  })
  baseUrl = await waitForFixtureServer(server)
  browser = AgentBrowser.open(`search-focus-${process.pid}`)
}, 180_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (root) rmSync(root, { recursive: true, force: true })
})

for (const picker of [
  { name: 'branch', trigger: '[data-slot="base-pill"]', input: 'input[placeholder="Search branches…"]', content: '[data-testid="base-pill-menu"]' },
  { name: 'skill', trigger: '[data-slot="source-pill"]', input: 'input[placeholder="search skills & workflows…"]', content: '[data-slot="popover-content"]' },
]) {
  for (const width of [1440, 360]) {
    for (const theme of ['light', 'dark', 'forced-colors']) {
      it(`${picker.name}: one complete search focus frame at ${width}px in ${theme}`, async () => {
        browser.setViewport(width, width === 360 ? 640 : 900)
        browser.goto(`${baseUrl}/new`)
        browser.waitForFunction(`document.querySelector('${picker.trigger}')?.checkVisibility() === true`)
        browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'})`)
        const url = browser.url()
        await browser.withCdp(async request => {
          const { targetInfos } = await request('Target.getTargets')
          const target = targetInfos.find((t: { type: string; url: string }) => t.type === 'page' && t.url === url)
          const { sessionId } = await request('Target.attachToTarget', { targetId: target.targetId, flatten: true })
          await request('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: theme === 'forced-colors' ? 'active' : 'none' }] }, sessionId)
          try {
            // The mobile execution settings extend below the fixed bottom navigation.
            browser.evaluate(`document.querySelector('${picker.trigger}').scrollIntoView({ block: 'center' })`)
            settleVisual(browser, picker.trigger)
            browser.click(picker.trigger)
            browser.waitForFunction(`document.activeElement === document.querySelector('${picker.input}')`)
            const row = picker.name === 'branch' ? '[data-slot="picker-search"]' : '[data-slot="command-input-wrapper"]'
            // Geometry and outline contrast come from one held observation of the open picker.
            const sample = () => waitForSettledSample<{
              focused: boolean; ink: string; background: string; line: number;
              innerLine: number; innerInk: string; iconInside: boolean;
              left: number; right: number; rowBottom: number; resultTop: number; contrast: ContrastSample;
            }>(browser, `(() => {
              const input = document.querySelector('${picker.input}');
              const row = input.parentElement, menu = document.querySelector('${picker.content}');
              const result = menu.querySelector('[role="menuitemradio"], [cmdk-item]');
              const r = row.getBoundingClientRect(), icon = row.querySelector('svg').getBoundingClientRect();
              const s = getComputedStyle(row), inner = getComputedStyle(input);
              return { focused: input.matches(':focus-visible'), ink: s.outlineColor, background: getComputedStyle(menu).backgroundColor,
                line: parseFloat(s.outlineWidth), innerLine: parseFloat(inner.outlineWidth), innerInk: inner.outlineColor,
                iconInside: icon.left >= r.left && icon.right <= r.right,
                left: r.left, right: r.right, rowBottom: r.bottom, resultTop: result.getBoundingClientRect().top,
                contrast: ${contrastSampleExpression(row, 'outline-color')} };
            })()`)
            const before = sample()
            expect(before.focused).toBe(true)
            expect(before.line).toBeGreaterThan(0)
            expect(before.ink).not.toBe(before.background)
            expect(before.innerLine === 0 || before.innerInk === 'rgba(0, 0, 0, 0)').toBe(true)
            expect(before.iconInside).toBe(true)
            expect(before.left).toBeGreaterThanOrEqual(0)
            expect(before.right).toBeLessThanOrEqual(width)
            expect(before.rowBottom).toBeLessThanOrEqual(before.resultTop)
            expect(before.contrast.ratio, JSON.stringify(before.contrast)).toBeGreaterThanOrEqual(3)
            browser.fill(picker.input, picker.name === 'branch' ? 'long-branch' : 'focus-fixture')
            browser.waitForFunction(`document.querySelector('${picker.content}')?.textContent.includes('${picker.name === 'branch' ? 'feature/a-long' : 'focus-fixture'}') === true`)
            const after = sample()
            expect(after.line).toBe(before.line)
            expect(after.rowBottom).toBe(before.rowBottom)
            expect(after.contrast.ratio, JSON.stringify(after.contrast)).toBeGreaterThanOrEqual(3)
            browser.screenshot(join(artifacts, `${picker.name}-${width}-${theme}.png`))
            dismissWithEscape(browser, { content: picker.content, focus: picker.trigger })
          } finally {
            await request('Emulation.setEmulatedMedia', { features: [] }, sessionId)
          }
        })
      })
    }
  }
}
