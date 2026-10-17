import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createGitHubFixture, DESKTOP } from './github-fixture'
import type { GitHubFixture } from './github-fixture'

/**
 * The GitHub list pages as the user scrolls (hearsay-tools/cezarion#1183, port of
 * open-mercato/cezar#1374): the virtualizer and the load-more sentinel both follow the element
 * that really scrolls. On desktop that is the list pane (`gh-list`); below `md` it is the shell's
 * `main`. jsdom has no layout, so only a real browser proves the binding.
 *
 * Both pages are served through Chrome's network layer, which also answers the live head read the
 * shared worker makes. The first page's pattern ends at `limit=50`, so it never matches the second
 * page's request, which carries a cursor after it.
 */

const sessionId = `e2e-ghp-${process.pid}`
const PHONE = { width: 360, height: 640 }
const REPO = 'example/paging-fixture'
const FIRST = 5001
const PAGE_ONE = 50
const TOTAL = 70
const LAST = FIRST + TOTAL - 1

const PAGE_ONE_ROUTE = '**/github?limit=50'
const PAGE_TWO_ROUTE = '**/github?limit=50&*'
const COUNTS_ROUTE = '**/github/comment-counts?*'

const issue = (number: number) => ({
  kind: 'issue', number, title: `Paged issue ${number}`, author: 'reporter', createdAt: '2026-10-01T00:00:00Z',
  labels: [], url: `https://github.com/${REPO}/issues/${number}`, comments: 0,
})
const issues = (from: number, count: number) => Array.from({ length: count }, (_, index) => issue(from + index))
const page = (rows: unknown[], issuesNextCursor: string | null) => ({
  available: true, repo: REPO, syncedAt: '2026-10-01T00:00:00Z', issues: rows, prs: [], labelColors: {},
  issuesTotal: TOTAL, prsTotal: 0, issuesNextCursor, prsNextCursor: null,
})

let browser: GitHubFixture['browser']
let openGitHub: GitHubFixture['openGitHub']

beforeAll(async () => {
  ({ browser, openGitHub } = await createGitHubFixture(sessionId))
  browser.routeJson(PAGE_ONE_ROUTE, page(issues(FIRST, PAGE_ONE), 'c1'))
  browser.routeJson(PAGE_TWO_ROUTE, page(issues(FIRST + PAGE_ONE, TOTAL - PAGE_ONE), null))
  browser.routeJson(COUNTS_ROUTE, { available: true, counts: {} })
})

beforeEach(() => {
  browser.goto('about:blank')
})

afterAll(() => {
  for (const pattern of [PAGE_ONE_ROUTE, PAGE_TWO_ROUTE, COUNTS_ROUTE]) {
    try {
      browser?.unroute(pattern)
    } catch {
      /* the session may already be gone */
    }
  }
  browser?.close()
})

interface PagingSample { label: string | null; owner: boolean; last: boolean; mounted: number }

/** Scroll `owner` to its end and read the list in the same sample (README rule 3): each poll
 *  moves the viewport to the bottom again, so the sentinel and the virtualizer see the page grow. */
const scrollToEndSample = (owner: string) => `(() => {
  const owner = document.querySelector(${JSON.stringify(owner)});
  const tab = document.querySelector('[data-slot="gh-tabs"] a');
  if (owner) owner.scrollTop = owner.scrollHeight;
  return {
    label: tab ? tab.textContent.trim() : null,
    owner: owner !== null,
    last: document.querySelector('[data-slot="gh-row"][data-number="${LAST}"]') !== null,
    mounted: document.querySelectorAll('[data-slot="gh-row"]').length,
  };
})()`

describe('GitHub list paging (#1183)', () => {
  it.each([
    { name: 'desktop', viewport: DESKTOP, path: '/github', owner: '[data-slot="gh-list"]' },
    { name: 'phone', viewport: PHONE, path: '/github?filter=all', owner: '[data-slot="main"]' },
  ])('loads the next page by scrolling $owner ($name)', async ({ viewport, path, owner }) => {
    browser.setViewport(viewport.width, viewport.height)
    await openGitHub(path)
    browser.waitForFunction(`document.querySelector('[data-slot="gh-row"][data-number="${FIRST}"]') !== null`)
    const sample = browser.waitForValue<PagingSample>(
      scrollToEndSample(owner),
      (value) => Boolean(value?.owner && value.last),
      { failure: `row #${LAST} never mounted while scrolling ${owner}` },
    )
    // The tab names the repository's exact total, not the loaded rows.
    expect(sample.label).toBe(`Issues · ${TOTAL}`)
    // The virtualizer keeps only a window of rows in the DOM.
    expect(sample.mounted).toBeLessThan(TOTAL)
  }, 60_000)
})
