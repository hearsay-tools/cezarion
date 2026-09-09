import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'

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

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-github-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }
const IPHONE = { width: 390, height: 844 }
const REVIEW_PHONE = { width: 360, height: 640 }

let browser: AgentBrowser
let baseUrl: string

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`)
  if (!res.ok) throw new Error(`cezar e2e: GET ${path} answered ${res.status}`)
  return (await res.json()) as T
}

interface HealthPayload {
  forge: { kind: string; available: boolean } | null
}

interface GithubPayload {
  available: boolean
  repo?: string
  issues: Array<{ number: number; title: string; labels: string[] }>
  prs: Array<{ number: number; title: string; checks?: string | null }>
}

let forgeAvailable = false
let bootProject: string

/** A flat route target under this server's own project prefix (multi-project spec, step 3.2):
 *  every cockpit link is scoped, and every legacy flat URL redirects onto its scoped twin. */
const scoped = (path: string) => `/p/${bootProject}${path}`

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  forgeAvailable = (await api<HealthPayload>('/api/v1/health')).forge?.available === true
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
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

    browser.goto(`${baseUrl}${scoped('/github')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="gh-header"]') !== null`)
    // The bare `/github` restores the LAST-selected tab (#417), which a previous suite run may
    // have left on PRs — so ask for Issues explicitly rather than assuming the stored default.
    browser.click(`[data-slot="gh-tabs"] a[href="${scoped('/github')}"]`)
    browser.waitForFunction(
      `document.querySelectorAll('[data-slot="gh-row"]').length === ${gh.issues.length}`,
    )

    expect(browser.text('[data-slot="gh-tabs"]')).toContain(`Issues · ${gh.issues.length}`)
    expect(browser.text('[data-slot="gh-tabs"]')).toContain(`Pull requests · ${gh.prs.length}`)
    if (gh.repo) expect(browser.text('[data-slot="gh-repo"]')).toBe(gh.repo)

    // The PR tab is a URL of its own.
    browser.click(`[data-slot="gh-tabs"] a[href="${scoped('/github/prs')}"]`)
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

    browser.goto(`${baseUrl}${scoped('/github')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="gh-row"]') !== null`)
    // Bare `/github` restores the last-selected tab (#417) — pin it to Issues before picking one.
    browser.click(`[data-slot="gh-tabs"] a[href="${scoped('/github')}"]`)
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

    browser.goto(`${baseUrl}${scoped(`/github/prs/${pr.number}`)}`)
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

    browser.goto(`${baseUrl}${scoped(`/github/prs/${pr.number}`)}`)
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

    browser.goto(`${baseUrl}${scoped(`/github/prs/${pr.number}/changes`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="gh-pr-changes"]') !== null`)
    expect(browser.evaluate(`document.querySelector('[data-slot="gh-pr-changes"]').textContent`)).toContain('changed files')
    expect(browser.count('[aria-label="Select changed file"]')).toBe(1)
    expect(browser.count('[aria-label="Next file"]')).toBe(1)
    browser.click('[aria-label="Next file"]')
    browser.fill('[aria-label="Filter changed files"]', 'logo')
    browser.waitForFunction(`document.querySelector('[data-slot="gh-pr-changes"]').textContent.includes('Patch unavailable: binary')`)
    browser.screenshot(`${artifactsDir}/github-pr-changes.png`)
  })

  it('below md the list is the page, and a detail URL swaps to the detail with a way back', async () => {
    if (!forgeAvailable) return
    const gh = await api<GithubPayload>('/api/v1/github')
    const first = gh.issues[0]
    if (!first) return

    browser.setViewport(IPHONE.width, IPHONE.height)
    try {
      browser.goto(`${baseUrl}${scoped('/github')}`)
      browser.waitForFunction(`document.querySelector('[data-slot="gh-row"]') !== null`)
      // List visible, detail pane hidden below md.
      browser.waitForFunction(
        `(() => { const el = document.querySelector('[data-slot="gh-detail"]'); return el !== null && el.offsetParent === null })()`,
      )
      expect(browser.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true)

      browser.goto(`${baseUrl}${scoped(`/github/issues/${first.number}`)}`)
      browser.waitForFunction(`document.querySelector('[data-slot="gh-detail-inner"]') !== null`)
      // Now the detail is the page and the list yields; the back affordance is a link.
      browser.waitForFunction(
        `(() => { const el = document.querySelector('[data-slot="gh-list"]'); return el === null || el.offsetParent === null })()`,
      )
      expect(
        browser.evaluate(`document.querySelector('[data-slot="gh-back"]').getAttribute('href')`),
      ).toBe(scoped('/github'))

      browser.screenshot(`${artifactsDir}/github-iphone.png`)
    } finally {
      browser.setViewport(DESKTOP.width, DESKTOP.height)
    }
  })

  it('lays out long issue and pull-request titles at the review viewports in both themes and densities', async () => {
    if (!forgeAvailable) return

    const longTitle =
      'Keep the shared GitHub synchronization workflow readable when several records begin with exactly the same words but end differently'
    const longAuthor = 'a-contributor-with-a-deliberately-long-github-login'
    const observations: Array<Record<string, unknown>> = []

    for (const viewport of [REVIEW_PHONE, DESKTOP]) {
      for (const theme of ['light', 'dark'] as const) {
        for (const density of ['comfortable', 'ultra'] as const) {
          browser.setViewport(viewport.width, viewport.height)
          browser.goto(`${baseUrl}${scoped('/github')}`)
          browser.waitForFunction(`document.querySelector('[data-slot="gh-row"]') !== null`)
          browser.evaluate(`(() => {
            document.documentElement.classList.toggle('light', ${theme === 'light'})
            document.documentElement.dataset.density = ${JSON.stringify(density)}
          })()`)

          for (const view of ['issues', 'prs'] as const) {
            const path = view === 'issues' ? '/github' : '/github/prs'
            browser.click(`[data-slot="gh-tabs"] a[href="${scoped(path)}"]`)
            browser.waitForFunction(
              `document.querySelector('[data-slot="gh-row"]')?.getAttribute('href')?.includes(${JSON.stringify(view === 'issues' ? '/issues/' : '/prs/')}) === true`,
            )
            const facts = browser.evaluate(`(() => {
              const row = document.querySelector('[data-slot="gh-row"]')
              const titleLine = row.children[0]
              const icon = titleLine.children[0]
              const title = titleLine.children[1]
              const meta = row.children[1]
              const labels = row.children[2]
              title.textContent = ${JSON.stringify(longTitle)}
              meta.children[1].textContent = ${JSON.stringify(longAuthor)}
              const titleStyle = getComputedStyle(title)
              const titleRect = title.getBoundingClientRect()
              const iconRect = icon.getBoundingClientRect()
              const metaRect = meta.getBoundingClientRect()
              const labelsRect = labels?.getBoundingClientRect()
              const lineHeight = Number.parseFloat(titleStyle.lineHeight)
              const metaLines = new Set([...meta.children].map((child) => Math.round(child.getBoundingClientRect().top))).size
              return {
                titleLines: Math.round(titleRect.height / lineHeight),
                titleClamped: title.scrollHeight > title.clientHeight,
                titleOverflowing: title.scrollWidth > title.clientWidth,
                textOverflow: titleStyle.textOverflow,
                whiteSpace: titleStyle.whiteSpace,
                iconOffset: Math.abs(iconRect.top - titleRect.top),
                metaLines,
                metaBelowTitle: metaRect.top >= titleRect.bottom,
                labelsBelowMeta: !labelsRect || labelsRect.top >= metaRect.bottom,
                pageOverflow: document.documentElement.scrollWidth > innerWidth,
                listWidth: document.querySelector('[data-slot="gh-list"]').getBoundingClientRect().width,
                light: document.documentElement.classList.contains('light'),
                appliedDensity: document.documentElement.dataset.density,
              }
            })()`) as {
              titleLines: number
              titleClamped: boolean
              titleOverflowing: boolean
              textOverflow: string
              whiteSpace: string
              iconOffset: number
              metaLines: number
              metaBelowTitle: boolean
              labelsBelowMeta: boolean
              pageOverflow: boolean
              listWidth: number
              light: boolean
              appliedDensity: string
            }

            observations.push({ viewport, theme, density, view, ...facts })
            expect(facts.light).toBe(theme === 'light')
            expect(facts.appliedDensity).toBe(density)
            expect(facts.metaBelowTitle).toBe(true)
            expect(facts.labelsBelowMeta).toBe(true)
            expect(facts.pageOverflow).toBe(false)
            if (viewport.width === REVIEW_PHONE.width) {
              expect(facts.titleLines).toBe(2)
              expect(facts.titleClamped).toBe(true)
              expect(facts.iconOffset).toBeLessThanOrEqual(3)
              expect(facts.metaLines).toBeGreaterThan(1)
            } else {
              expect(facts.titleLines).toBe(1)
              expect(facts.titleOverflowing).toBe(true)
              expect(facts.textOverflow).toBe('ellipsis')
              expect(facts.whiteSpace).toBe('nowrap')
              expect(facts.metaLines).toBe(1)
              expect(facts.listWidth).toBeCloseTo(360, 0)
            }
          }

          browser.screenshot(
            `${artifactsDir}/github-titles-${viewport.width}-${theme}-${density}.png`,
            { viewport: true },
          )
        }
      }
    }

    expect(observations).toHaveLength(16)
    browser.setViewport(DESKTOP.width, DESKTOP.height)
  }, 60_000)
})
