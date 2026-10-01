import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { artifactsDir, createGitHubFixture, DESKTOP } from './github-fixture'
import type { GitHubFixture, GithubPayload } from './github-fixture'

/**
 * The GitHub tab (R6 Step 1.1) end-to-end against the shared dry-run environment.
 *
 * Reachability: under `CEZ_DRY_RUN=1` the forge driver reports AVAILABLE and `/api/v1/github`
 * serves the bundled mock issues/PRs — so the lists, the detail pane and the cmdk dropdowns
 * are honestly reachable here and are covered below. The forge-OFF branch (nav item hidden,
 * unavailable explainer) is NOT reachable in this env; it is asserted structurally in the
 * unit suites (nav-items/app-shell/command-palette tests, github.test.tsx), and the gating
 * spec below asserts whichever branch the LIVE health payload actually reports rather than
 * assuming one. Strictly read-only: no run is started (`POST /api/v1/runs` is unit-pinned) —
 * the shared env's run list must not grow side effects.
 */

const sessionId = `e2e-ghc-${process.pid}`
const IPHONE = { width: 390, height: 844 }

let browser: GitHubFixture['browser']
let baseUrl: GitHubFixture['baseUrl']
let forgeAvailable: GitHubFixture['forgeAvailable']
let api: GitHubFixture['api']
let scoped: GitHubFixture['scoped']
let rememberGithubView: GitHubFixture['rememberGithubView']
let openGitHub: GitHubFixture['openGitHub']
let clickGitHubTab: GitHubFixture['clickGitHubTab']

beforeAll(async () => {
  ({ browser, baseUrl, forgeAvailable, api, scoped, rememberGithubView, openGitHub, clickGitHubTab } = await createGitHubFixture(sessionId))
})

beforeEach(async () => {
  await rememberGithubView('issues')
  browser.setViewport(DESKTOP.width, DESKTOP.height)
  browser.goto('about:blank')
})

afterAll(() => {
  browser?.close()
})

describe('the GitHub tab against the live dry-run server', () => {
  it('the nav gates on the live forge payload — item present iff the driver is available', () => {
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="sidebar"] nav') !== null`)
    if (forgeAvailable) {
      // The item waits on the health answer — poll rather than sample.
      browser.waitForFunction(`document.querySelector('nav a[href="${scoped('/github')}"]') !== null`)
    } else {
      // Health has answered (other chips render from it) and still no GitHub item.
      browser.waitForFunction(`document.querySelector('[data-slot="version-chip"]') !== null`)
      expect(browser.count(`nav a[href="${scoped('/github')}"]`)).toBe(0)
    }
  })

  it('/github lists the real issues and PRs with honest counts', async () => {
    if (!forgeAvailable) return // covered by the gating spec + unit suites
    const gh = await api<GithubPayload>('/api/v1/github')
    expect(gh.available).toBe(true)

    await openGitHub('/github')
    clickGitHubTab('/github')
    browser.waitForFunction(
      `document.querySelectorAll('[data-slot="gh-row"]').length === ${gh.issues.length}`,
    )

    expect(browser.text('[data-slot="gh-tabs"]')).toContain(`Issues · ${gh.issues.length}`)
    expect(browser.text('[data-slot="gh-tabs"]')).toContain(`Pull requests · ${gh.prs.length}`)
    if (gh.repo) expect(browser.text('[data-slot="gh-repo"]')).toBe(gh.repo)

    clickGitHubTab('/github/prs')
    browser.waitForFunction(
      `document.querySelectorAll('[data-slot="gh-row"]').length === ${gh.prs.length}`,
    )
    expect(browser.url()).toBe(`${baseUrl}${scoped('/github/prs')}`)

    // Health answers after the github payload on this box — settle the forge-gated nav item
    // (an assertion of the gate on the tab's own page, and an honest screenshot).
    browser.waitForFunction(`document.querySelector('nav a[href="${scoped('/github')}"]') !== null`)
    browser.screenshot(`${artifactsDir}/github-desktop.png`)
  })

  it('opens an issue’s detail: meta, labels, markdown body, hand-to-agent dropdowns', async () => {
    if (!forgeAvailable) return
    const gh = await api<GithubPayload>('/api/v1/github')
    const first = gh.issues[0]
    expect(first).toBeDefined()
    if (!first) return

    await openGitHub('/github')
    clickGitHubTab('/github')
    browser.waitForFunction(
      `document.querySelector('[data-slot="gh-row"][data-number="${first.number}"]') !== null`,
    )
    browser.click(`[data-slot="gh-row"][data-number="${first.number}"]`)

    browser.waitForFunction(`document.querySelector('[data-slot="gh-detail-inner"]') !== null`)
    expect(browser.url()).toBe(`${baseUrl}${scoped(`/github/issues/${first.number}`)}`)
    expect(browser.text('[data-slot="gh-meta"]')).toContain(`#${first.number}`)
    expect(browser.text('[data-slot="gh-detail-inner"] h2')).toBe(first.title)
    // Scoped to the DETAIL pane: the list rows carry their own label chips, so a page-wide
    // count would be every issue's labels summed rather than this issue's.
    expect(browser.count('[data-slot="gh-detail-inner"] [data-slot="gh-label"]')).toBe(
      first.labels.length,
    )
    // The body rendered through the markdown pipeline — non-empty prose, not raw JSON.
    browser.waitForFunction(
      `(document.querySelector('[data-slot="gh-body"]')?.textContent ?? '').length > 0`,
    )

    // The #385 dropdowns: the workflow cmdk menu opens and filters (read-only — nothing run).
    const workflows = await api<{ workflows: Array<{ name: string }> }>('/api/v1/workflows')
    browser.click('[data-slot="gh-workflow-trigger"]')
    browser.waitForFunction(
      `document.querySelectorAll('[data-slot="gh-workflow-option"]').length === ${workflows.workflows.length}`,
    )
    browser.fill('[data-slot="command-input"]', 'quick')
    browser.waitForFunction(
      `document.querySelectorAll('[data-slot="gh-workflow-option"]').length === 1`,
    )

    // Same settle rule as above: the screenshot must show the whole truth, nav item included.
    browser.waitForFunction(`document.querySelector('nav a[href="${scoped('/github')}"]') !== null`)
    browser.screenshot(`${artifactsDir}/github-detail.png`)
    browser.press('Escape')
  })

  it('renders the activity thread: comments, a commit row with a CI glyph, and events', async () => {
    // The sibling spec (#499) called for thread e2e coverage and it never landed, so before #525
    // this file had NO thread assertions at all. Under CEZ_DRY_RUN=1 the mock thread serves both
    // comments and timeline events, so the whole interleave is honestly reachable here.
    if (!forgeAvailable) return
    const gh = await api<GithubPayload>('/api/v1/github')
    const pr = gh.prs[0]
    if (!pr) return

    await openGitHub(`/github/prs/${pr.number}`)
    browser.waitForFunction(`document.querySelector('[data-slot="gh-thread"]') !== null`)

    // The section is "Activity", not "Comments" — a twenty-row list headed `Comments · 2` would
    // be incoherent once events render.
    expect(
      browser.evaluate(`document.querySelector('[data-slot="gh-thread-header"]').textContent`),
    ).toContain('Activity')

    // Conversation comments still render, through the markdown pipeline.
    browser.waitForFunction(
      `document.querySelectorAll('[data-slot="gh-thread-entry"]').length > 0`,
    )

    // Consecutive same-author commits collapse; expanding reveals the individual rows.
    browser.waitForFunction(`document.querySelector('[data-slot="gh-commit-group"]') !== null`)
    expect(
      browser.evaluate(
        `document.querySelector('[data-slot="gh-commit-group"] button').getAttribute('aria-expanded')`,
      ),
    ).toBe('false')
    // At 1440x900 the group can sit on the viewport's bottom edge with its centre just below it
    // (local repro on PR #716: button top 893px, height 16.5px, click lands off-page and the group
    // stays closed). agent-browser does not scroll a partly visible target, so centre it first.
    browser.evaluate(`document.querySelector('[data-slot="gh-commit-group"] button').scrollIntoView({ block: 'center', behavior: 'instant' })`)
    browser.click('[data-slot="gh-commit-group"] button')

    // Expanded: commit rows, each keeping its own message and CI glyph.
    browser.waitForFunction(
      `document.querySelectorAll('[data-slot="gh-event-row"][data-kind="committed"]').length > 1`,
    )
    browser.waitForFunction(`document.querySelector('[data-slot="gh-commit-checks"]') !== null`)
    // Mixed states in the fixtures, so more than one distinct glyph tone is on screen.
    expect(
      browser.evaluate(
        `new Set([...document.querySelectorAll('[data-slot="gh-commit-checks"]')].map((el) => el.dataset.checks)).size > 1`,
      ),
    ).toBe(true)

    // Non-commit events render too.
    browser.waitForFunction(
      `document.querySelector('[data-slot="gh-event-row"][data-kind="labeled"]') !== null`,
    )

    browser.waitForFunction(`document.querySelector('nav a[href="${scoped('/github')}"]') !== null`)
    browser.screenshot(`${artifactsDir}/github-thread-timeline.png`)
  })

  it('shows the guarded merge box and confirms before merging', async () => {
    if (!forgeAvailable) return
    const gh = await api<GithubPayload>('/api/v1/github')
    const pr = gh.prs[0]
    if (!pr) return

    await openGitHub(`/github/prs/${pr.number}`)
    browser.waitForFunction(`document.querySelector('[data-slot="gh-merge-box"]') !== null`)
    expect(browser.text('[data-slot="gh-merge-box"]')).toContain('Ready to merge')
    expect(browser.text('[data-slot="gh-merge-box"]')).toContain('→ main')
    browser.screenshot(`${artifactsDir}/github-merge-ready.png`)

    browser.click('[data-slot="gh-merge-box"] select + button')
    browser.waitForFunction(`document.querySelector('[data-slot="gh-merge-confirm"]') !== null`)
    expect(browser.text('[data-slot="gh-merge-confirm"]')).toContain(`pull request #${pr.number}`)
    expect(browser.text('[data-slot="gh-merge-confirm"]')).toContain('into main')
    browser.screenshot(`${artifactsDir}/github-merge-confirm.png`)
    browser.press('Escape')
    browser.waitForFunction(`document.querySelector('[data-slot="gh-merge-confirm"]') === null`)
  })

  it('reviews a pull request file-by-file in the Changes view', async () => {
    if (!forgeAvailable) return
    const gh = await api<GithubPayload>('/api/v1/github')
    const pr = gh.prs[0]
    if (!pr) return

    await openGitHub(`/github/prs/${pr.number}/changes`)
    browser.waitForFunction(`document.querySelector('[data-slot="gh-pr-changes"]') !== null`)
    expect(browser.evaluate(`document.querySelector('[data-slot="gh-pr-changes"]').textContent`)).toContain('changed files')
    expect(browser.count('[aria-label="Select changed file"]')).toBe(1)
    expect(browser.count('[aria-label="Next file"]')).toBe(1)
    browser.click('[aria-label="Next file"]')
    browser.fill('[aria-label="Filter changed files"]', 'logo')
    browser.waitForFunction(`document.querySelector('[data-slot="gh-pr-changes"]').textContent.includes('Patch unavailable: binary')`)
    browser.screenshot(`${artifactsDir}/github-pr-changes.png`)
  })

  it('below md the list and selected detail stack in document flow with a way back', async () => {
    if (!forgeAvailable) return
    const gh = await api<GithubPayload>('/api/v1/github')
    const first = gh.issues[0]
    if (!first) return

    browser.setViewport(IPHONE.width, IPHONE.height)
    try {
      // Bare /github is the filter index on a phone (#622); ask for the list itself.
      await openGitHub('/github?filter=all')
      browser.waitForFunction(`document.querySelector('[data-slot="gh-row"]') !== null`)
      // List visible, detail pane hidden below md.
      browser.waitForFunction(
        `(() => { const el = document.querySelector('[data-slot="gh-detail"]'); return el !== null && el.offsetParent === null })()`,
      )
      expect(browser.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true)

      await openGitHub(`/github/issues/${first.number}`)
      browser.waitForFunction(`document.querySelector('[data-slot="gh-detail-inner"]') !== null`)
      // The revised mobile layout keeps the list above the detail; the back link remains.
      browser.waitForFunction(
        `(() => { const list = document.querySelector('[data-slot="gh-list"]'); const detail = document.querySelector('[data-slot="gh-detail"]'); return list.offsetParent !== null && detail.getBoundingClientRect().top >= list.getBoundingClientRect().bottom })()`,
      )
      // A phone's bare /github is the filter index, so the detail's way back names the list itself (#622).
      expect(
        browser.evaluate(`document.querySelector('[data-slot="gh-back"]').getAttribute('href')`),
      ).toBe(`${scoped('/github')}?filter=all`)

      if (gh.issues.length > 2) {
        const visibleRowsCountJs = (count: number) =>
          `[...document.querySelectorAll('[data-slot="gh-rows"] [data-slot="gh-row"]')].filter(row => row.offsetParent !== null).length === ${count}`
        const visibleRows = () => browser.evaluate(`[...document.querySelectorAll('[data-slot="gh-rows"] [data-slot="gh-row"]')].filter(row => row.offsetParent !== null).length`)
        const selectedIndex = Number(browser.evaluate(
          `[...document.querySelectorAll('[data-slot="gh-rows"] > li')].findIndex(li => li.querySelector("[aria-current='page']"))`,
        ))
        const compactedVisible = 2 + (selectedIndex >= 2 ? 1 : 0)
        // Wait on both observables the toggle drives, never on a clock (#341): the control's
        // own state and the row visibility the assertions count. One React commit flips them
        // together today, so waiting on the count costs one poll — and if that atomicity ever
        // breaks, this settles to the committed state instead of sampling mid-flight.
        const toggleList = (expanded: 'true' | 'false', expectedVisible: number) => {
          browser.evaluate(`document.querySelector('[data-slot="gh-expand-list"]').scrollIntoView({ block: 'center', behavior: 'instant' })`)
          browser.click('[data-slot="gh-expand-list"]')
          browser.waitForFunction(`document.querySelector('[data-slot="gh-expand-list"]').getAttribute('aria-expanded') === '${expanded}'`)
          browser.waitForFunction(visibleRowsCountJs(expectedVisible))
        }
        browser.waitForFunction(visibleRowsCountJs(compactedVisible))
        expect(visibleRows()).toBe(compactedVisible)
        toggleList('true', gh.issues.length)
        expect(visibleRows()).toBe(gh.issues.length)
        toggleList('false', compactedVisible)
        expect(visibleRows()).toBe(compactedVisible)
      }
      browser.screenshot(`${artifactsDir}/github-iphone.png`)
    } finally {
      browser.setViewport(DESKTOP.width, DESKTOP.height)
    }
  })

})
