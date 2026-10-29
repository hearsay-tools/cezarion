import { execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { contrastSampleExpression, focusWithKeyboard, type ContrastSample } from './contrast'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { waitForStatus } from './poll'
// fixture-server starts: 1

/**
 * The Changes views' Markdown preview (hearsay-tools/cezarion#1012) in a real browser: what jsdom
 * cannot show. Keyboard reach of both switches, the toggle surviving a 360px phone where the
 * other view toggles hide, a 44px per-file target there, the rendered document's text contrast
 * in both themes, and a relative image really loading through the raw-file route while an
 * escaping one stays text. The loading, refresh and failure states are pinned in
 * `components/diff/diff.test.tsx`.
 *
 * Fixture: a live dry run parked at review (the task-changes.e2e.ts doctrine), whose worktree
 * this spec extends from the outside with `docs/guide.md` and the PNG it embeds, plus an
 * uncommitted README edit in the main checkout for the repo view.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-markdown-preview-${process.pid}`

/** A 1×1 opaque PNG: enough for `naturalWidth` to prove the bytes arrived and decoded. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string
let runId: string

/** Horizontal overflow of the app scroller, and the deepest elements reaching past the viewport
 *  (named by data-slot or tag), so a failure says WHAT is too wide. */
const OVERFLOW = `(() => {
  const main = document.querySelector('[data-slot="main"]')
  const wide = [...main.querySelectorAll('*')]
    .filter((el) => el.getBoundingClientRect().right > innerWidth + 0.5 && ![...el.children].some((child) => child.getBoundingClientRect().right > innerWidth + 0.5))
    .slice(0, 6)
    .map((el) => (el.closest('[data-slot]')?.dataset.slot ?? '') + '>' + el.tagName.toLowerCase() + ':' + Math.round(el.getBoundingClientRect().right))
  return { overflow: main.scrollWidth - main.clientWidth, wide }
})()`
const scoped = (path: string) => `/p/${bootProject}${path}`
const guideCard = `[data-slot="diff-file"][data-path="docs/guide.md"]`

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-md-preview-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# Fixture\n\n## Setup\n\nInstall it.\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  server = spawnFixtureServer([cezarCli, 'serve', '--repo', dataRoot, '--port', '0', '--no-open'], {
    env: fixtureServeEnv(dataRoot, { CEZ_REVIEW_GATE: '1' }),
    stdio: 'ignore',
  })
  baseUrl = await waitForFixtureServer(server)
  bootProject = await bootProjectId(baseUrl)

  const created = (await (
    await fetch(`${baseUrl}/api/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'Write the guide.', workflow: 'quick-task' }),
    })
  ).json()) as { id: string }
  runId = created.id
  await waitForStatus(baseUrl, runId, ['waiting'])
  await fetch(`${baseUrl}/api/v1/runs/${runId}/finish`, { method: 'POST' })
  const parked = await waitForStatus(baseUrl, runId, ['review', 'done'])
  if (parked !== 'review') throw new Error('cezar e2e: the dry run settled as done — no diff to review?')
  const { worktreePath } = (await (await fetch(`${baseUrl}/api/v1/runs/${runId}`)).json()) as { worktreePath: string }

  mkdirSync(join(worktreePath, 'docs', 'img'), { recursive: true })
  writeFileSync(join(worktreePath, 'docs', 'img', 'shot.png'), PIXEL_PNG)
  writeFileSync(
    join(worktreePath, 'docs', 'guide.md'),
    '# Guide\n\nRead this first.\n\n![shot](img/shot.png)\n\n![escape](../../../../etc/passwd.png)\n',
    'utf8',
  )
  writeFileSync(join(dataRoot, 'README.md'), '# Fixture\n\n## Setup\n\nInstall it, then run it.\n', 'utf8')

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 180_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('the Markdown preview in the Changes views', () => {
  it.each(['light', 'dark'] as const)('task Changes, %s theme: keyboard toggle, full document, repository images', (theme) => {
    browser.setViewport(1440, 900)
    browser.goto(`${baseUrl}${scoped(`/tasks/${runId}/changes`)}`)
    browser.evaluate(`localStorage.setItem('cez-theme', ${JSON.stringify(theme)})`)
    browser.goto(`${baseUrl}${scoped(`/tasks/${runId}/changes`)}`)
    browser.waitForFunction(`document.querySelector(${JSON.stringify(guideCard)}) !== null`)

    focusWithKeyboard(browser, '[data-slot="markdown-preview-toggle"]')
    browser.press('Enter')
    const rendered = browser.waitForValue<{ heading: string; shot: number; escape: boolean; pressed: string | null }>(
      `(() => {
        const card = document.querySelector(${JSON.stringify(guideCard)})
        const heading = card?.querySelector('[data-slot="diff-markdown-preview"] h1')?.textContent
        const shot = card?.querySelector('[data-slot="diff-markdown-preview"] img')
        if (!heading || !shot?.complete || shot.naturalWidth === 0) return null
        return {
          heading,
          shot: shot.naturalWidth,
          escape: card.textContent.includes('[Image: escape]'),
          pressed: document.querySelector('[data-slot="markdown-preview-toggle"]').getAttribute('aria-pressed'),
        }
      })()`,
    )
    expect(rendered).toEqual({ heading: 'Guide', shot: 1, escape: true, pressed: 'true' })
    expect(browser.count(`${guideCard} img`)).toBe(1)

    const text = browser.evaluate(
      contrastSampleExpression(`${guideCard} [data-slot="diff-markdown-preview"] p`, 'color', 'parent'),
    ) as ContrastSample
    expect(text.ratio, `${text.foreground} on ${text.background}`).toBeGreaterThanOrEqual(4.5)

    // The per-file switch is reachable too, and sends just that file back to its diff.
    focusWithKeyboard(browser, `${guideCard} [data-slot="diff-file-preview-toggle"]`)
    browser.press(' ')
    browser.waitForFunction(
      `document.querySelector(${JSON.stringify(`${guideCard} [data-slot="diff-line"]`)}) !== null`,
    )
    browser.screenshot(`${artifactsDir}/markdown-preview-task-${theme}.png`, { viewport: true })
  })

  it('task Changes at 360px: the toggle stays, the per-file switch is a 44px target, nothing overflows', () => {
    browser.setViewport(360, 640)
    browser.goto(`${baseUrl}${scoped(`/tasks/${runId}/changes`)}`)
    browser.waitForFunction(`document.querySelector(${JSON.stringify(`${guideCard} [data-slot="diff-line"]`)}) !== null`)
    const before = browser.waitForValue<{ toggleHeight: number; overflow: number; wide: string[] }>(
      `(() => {
        const rect = document.querySelector('[data-slot="markdown-preview-toggle"]')?.getBoundingClientRect()
        return rect && rect.width > 0 ? { toggleHeight: Math.round(rect.height), ...${OVERFLOW} } : null
      })()`,
    )
    expect(before.toggleHeight).toBeGreaterThanOrEqual(44)

    // hearsay-tools/cezarion#1333 put the phone's Archive in a row under the top bar, which moves
    // this switch below the 640px fold, so scroll it into view first.
    browser.evaluate(`document.querySelector(${JSON.stringify(`${guideCard} [data-slot="diff-file-preview-toggle"]`)}).scrollIntoView({ block: 'center', behavior: 'instant' })`)
    browser.click(`${guideCard} [data-slot="diff-file-preview-toggle"]`)
    const after = browser.waitForValue<{ switchHeight: number; overflow: number; wide: string[] }>(
      `(() => {
        const card = document.querySelector(${JSON.stringify(guideCard)})
        if (!card?.querySelector('[data-slot="diff-markdown-preview"] h1')) return null
        const height = card.querySelector('[data-slot="diff-file-preview-toggle"]').getBoundingClientRect().height
        return { switchHeight: Math.round(height), ...${OVERFLOW} }
      })()`,
    )
    expect(after.switchHeight).toBeGreaterThanOrEqual(44)
    // The toolbar toggle once pushed the git overflow menu 25px off a 360px screen: the before
    // sample pins the toolbar, the after sample the rendered document.
    expect(before.overflow, `wider than the viewport: ${before.wide.join(', ')}`).toBeLessThanOrEqual(0)
    expect(after.overflow, `wider than the viewport: ${after.wide.join(', ')}`).toBeLessThanOrEqual(0)
    writeFileSync(`${artifactsDir}/markdown-preview-task-360.json`, JSON.stringify({ before, after }, null, 2))
    browser.screenshot(`${artifactsDir}/markdown-preview-task-360.png`, { viewport: true })
  })

  it('repo Changes: the patch new side, labelled as changed sections only', () => {
    browser.setViewport(1440, 900)
    browser.goto(`${baseUrl}${scoped('/git/changes')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="diff-file"][data-path="README.md"]') !== null`)
    browser.click('[data-slot="markdown-preview-toggle"]')
    const preview = browser.waitForValue<{ heading: string; note: boolean }>(
      `(() => {
        const preview = document.querySelector('[data-slot="diff-file"][data-path="README.md"] [data-slot="diff-markdown-preview"]')
        const heading = preview?.querySelector('h2')?.textContent
        return heading ? { heading, note: preview.textContent.includes('Showing the changed sections only.') } : null
      })()`,
    )
    expect(preview).toEqual({ heading: 'Setup', note: true })
    browser.screenshot(`${artifactsDir}/markdown-preview-repo.png`, { viewport: true })
  })
})
