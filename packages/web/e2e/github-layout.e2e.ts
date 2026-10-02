import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { settleVisual } from './visual-ready'
import { artifactsDir, createGitHubFixture, DESKTOP } from './github-fixture'
import type { GitHubFixture, GithubPayload } from './github-fixture'

const sessionId = `e2e-ghl-${process.pid}`
const REVIEW_PHONE = { width: 360, height: 640 }

let browser: GitHubFixture['browser']
let baseUrl: GitHubFixture['baseUrl']
let forgeAvailable: GitHubFixture['forgeAvailable']
let api: GitHubFixture['api']
let scoped: GitHubFixture['scoped']
let rememberGithubView: GitHubFixture['rememberGithubView']
let waitForGitHubSurface: GitHubFixture['waitForGitHubSurface']
let openGitHub: GitHubFixture['openGitHub']
let clickGitHubTab: GitHubFixture['clickGitHubTab']

beforeAll(async () => {
  ({ browser, baseUrl, forgeAvailable, api, scoped, rememberGithubView, waitForGitHubSurface, openGitHub, clickGitHubTab } = await createGitHubFixture(sessionId))
})

beforeEach(async () => {
  await rememberGithubView('issues')
  browser.setViewport(DESKTOP.width, DESKTOP.height)
  browser.goto('about:blank')
})

afterAll(() => {
  browser?.close()
})

it('keeps the detail readable at 900px (#754)', async () => {
  expect(forgeAvailable).toBe(true)
  const gh = await api<GithubPayload>('/api/v1/github')
  browser.setViewport(900, 800)
  await openGitHub(`/github/issues/${gh.issues[0]!.number}`)
  const facts = browser.waitForValue<{ list: number; detail: number; stacked: boolean; overflow: boolean }>(`(() => {
    const list = document.querySelector('[data-slot="gh-list"]');
    const detail = document.querySelector('[data-slot="gh-detail"]');
    if (!list || !detail || !document.querySelector('[data-slot="gh-hand"]')) return null;
    const l = list.getBoundingClientRect(), d = detail.getBoundingClientRect();
    const main = document.querySelector('[data-slot="main"]');
    return { list: l.width, detail: d.width, stacked: d.top >= l.bottom,
      overflow: main.scrollWidth > main.clientWidth || document.documentElement.scrollWidth > innerWidth };
  })()`)
  console.log('900px pane geometry', facts)
  browser.screenshot(`${artifactsDir}/github-900px.png`, { viewport: true })
  expect(facts.stacked || facts.detail >= 360).toBe(true)
  expect(facts.overflow).toBe(false)
})

// Catch fixed desktop columns, stale observations after resizing, and lost width preferences.
const PANE_GEOMETRY = `(() => {
  const workspace = document.querySelector('[data-slot="gh-workspace"]');
  const panes = document.querySelector('[data-slot="gh-panes"]');
  const list = document.querySelector('[data-slot="gh-list"]');
  const detail = document.querySelector('[data-slot="gh-detail"]');
  const main = document.querySelector('[data-slot="main"]');
  const handle = document.querySelector('[data-slot="gh-list-resize-handle"]');
  if (!workspace || !panes || !list || !detail || !handle || !document.querySelector('[data-slot="gh-hand"]')) return null;
  const l = list.getBoundingClientRect(), d = detail.getBoundingClientRect();
  return {
    viewport: innerWidth, available: workspace.clientWidth, list: l.width, detail: d.width,
    stacked: d.top >= l.bottom, handleVisible: handle.checkVisibility(),
    documentFlow: getComputedStyle(list).overflowY === 'visible' && getComputedStyle(detail).overflowY === 'visible',
    // Tabs deliberately bleed into the workspace padding; test the page and pane scrollports.
    overflow: [main, panes, list, detail].some(el => getComputedStyle(el).overflowX !== 'hidden' && el.scrollWidth > el.clientWidth + 1)
      || document.documentElement.scrollWidth > innerWidth,
    saved: localStorage.getItem('cez-github-list-width'),
  };
})()`
interface PaneGeometry {
  viewport: number; available: number; list: number; detail: number
  stacked: boolean; handleVisible: boolean; documentFlow: boolean; overflow: boolean; saved: string | null
}

it.each(['issues', 'prs'] as const)('keeps %s readable across pane boundaries and saved widths (#754)', async (view) => {
  expect(forgeAvailable).toBe(true)
  const gh = await api<GithubPayload>('/api/v1/github')
  browser.goto(baseUrl)
  try {
    for (const saved of [360, 520]) {
      browser.evaluate(`localStorage.setItem('cez-github-list-width', '${saved}')`)
      browser.setViewport(1440, 800)
      await openGitHub(`/github/${view}/${gh[view][0]!.number}`)
      const wide = browser.waitForValue<PaneGeometry>(PANE_GEOMETRY, f => Boolean(f && !f.stacked && f.list === saved))
      // Derive only the surrounding chrome's width from the browser, not the layout decision.
      const boundary = 1440 - wide.available + saved + 22 + 360
      for (const width of [768, 900, 1024, 1100, 1280, boundary - 1, boundary, boundary + 1, 1440]) {
        browser.setViewport(width, 800)
        const stacked = width < boundary
        const facts = browser.waitForStable<PaneGeometry>(PANE_GEOMETRY, {
          holdMs: 100,
          matcher: f => Boolean(f && f.viewport === width && f.stacked === stacked
            && f.handleVisible === !stacked && f.documentFlow === stacked
            && (stacked ? f.detail === f.available && f.list === f.available : f.detail >= 360 && f.list === saved)
            && !f.overflow),
        })
        expect(facts.saved).toBe(String(saved))
        expect(facts.stacked).toBe(stacked)
        expect(facts.overflow).toBe(false)
      }
    }
  } finally {
    browser.evaluate(`localStorage.removeItem('cez-github-list-width')`)
  }
}, 120_000)

it('reflows when the list is resized and restores its saved width after stacking (#754)', async () => {
  expect(forgeAvailable).toBe(true)
  const gh = await api<GithubPayload>('/api/v1/github')
  await openGitHub(`/github/issues/${gh.issues[0]!.number}`)
  try {
    const wide = browser.waitForValue<PaneGeometry>(PANE_GEOMETRY, f => Boolean(f && !f.stacked))
    // Leave exactly 16px to spare beyond the default list + gap + minimum detail.
    browser.setViewport(1440 - wide.available + 360 + 22 + 360 + 16, 800)
    browser.waitForValue<PaneGeometry>(PANE_GEOMETRY, f => Boolean(f && !f.stacked && f.detail === 376))
    browser.evaluate(`document.querySelector('[data-slot="gh-list-resize-handle"]').focus()`)
    browser.press('End')
    const stacked = browser.waitForValue<PaneGeometry>(PANE_GEOMETRY, f => Boolean(f && f.stacked && !f.handleVisible))
    expect(stacked.saved).toBe('520')
    browser.setViewport(1440, 800)
    const restored = browser.waitForValue<PaneGeometry>(PANE_GEOMETRY, f => Boolean(f && !f.stacked && f.list === 520))
    expect(restored.saved).toBe('520')
    const point = browser.waitForValue<{ x: number; y: number }>(`(() => {
      const handle = document.querySelector('[data-slot="gh-list-resize-handle"]');
      handle.scrollIntoView({ block: 'center' });
      const r = handle.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(Math.max(r.top, 0) + 40) };
    })()`)
    browser.dragTo(point, { x: point.x - 40, y: point.y })
    const dragged = browser.waitForValue<PaneGeometry>(PANE_GEOMETRY, f => Boolean(f && f.list === 480))
    expect(dragged.saved).toBe('480')
  } finally {
    browser.evaluate(`localStorage.removeItem('cez-github-list-width')`)
  }
})

it.each(['light', 'dark'])('scrolls stacked panes in document flow at 900px, %s (#754)', async (theme) => {
  expect(forgeAvailable).toBe(true)
  const gh = await api<GithubPayload>('/api/v1/github')
  const stub = { ...gh, issues: Array.from({ length: 12 }, (_, index) => ({
    ...gh.issues[0], number: 9000 + index, url: `https://github.com/mock/repo/issues/${9000 + index}`,
    title: `Stacked issue ${index}`, body: Array.from({ length: 40 }, () => 'Long issue body.').join('\n\n'),
  })) }
  browser.setViewport(900, 800)
  browser.goto(`${baseUrl}${scoped('/')}`)
  browser.waitForFunction(`document.querySelector('a[href="${scoped('/github')}"]') !== null`)
  browser.evaluate(`(() => {
    document.documentElement.classList.toggle('light', ${theme === 'light'});
    const nativeFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname.endsWith('/github')) return Promise.resolve(new Response(${JSON.stringify(JSON.stringify(stub))}, { status: 200, headers: { 'content-type': 'application/json' } }));
      return nativeFetch(input, init);
    };
    history.pushState(null, '', '${scoped('/github/issues/9000')}'); dispatchEvent(new PopStateEvent('popstate'));
  })()`)
  browser.waitForValue<PaneGeometry>(PANE_GEOMETRY, f => Boolean(f && f.stacked && f.documentFlow))
  const start = browser.waitForValue<{ x: number; y: number; scroll: number }>(`(() => {
    const main = document.querySelector('[data-slot="main"]');
    main.scrollTop = 0;
    const r = document.querySelector('[data-slot="gh-list"]').getBoundingClientRect();
    return { x: r.left + 50, y: r.top + 50, scroll: main.scrollTop };
  })()`)
  await browser.wheelAt(start.x, start.y, 200)
  const scroll = browser.waitForValue<number>(`document.querySelector('[data-slot="main"]').scrollTop`, n => n > start.scroll)
  expect(scroll).toBeGreaterThan(0)
  const end = browser.waitForValue<{ reachable: boolean; listScroll: number; detailScroll: number }>(`(() => {
    const main = document.querySelector('[data-slot="main"]');
    const detail = document.querySelector('[data-slot="gh-detail"]');
    const list = document.querySelector('[data-slot="gh-list"]');
    main.scrollTop = main.scrollHeight;
    list.scrollTop = 100; detail.scrollTop = 100;
    const d = detail.getBoundingClientRect(), m = main.getBoundingClientRect();
    return { reachable: d.bottom <= m.bottom && d.bottom > m.top, listScroll: list.scrollTop, detailScroll: detail.scrollTop };
  })()`, f => Boolean(f?.reachable))
  expect(end).toEqual({ reachable: true, listScroll: 0, detailScroll: 0 })
  browser.screenshot(`${artifactsDir}/github-stacked-900-${theme}.png`, { viewport: true })
})

describe('the GitHub tab against the live dry-run server', () => {
  it.each([900, 540])('on desktop hides the GitHub title then scrolls list and detail independently (#523), height %i', async (height) => {
    if (!forgeAvailable) return
    const gh = await api<GithubPayload>('/api/v1/github')
    const template = gh.issues[0]
    expect(template).toBeDefined()
    if (!template) return

    const longBody = Array.from({ length: 80 }, (_, index) => `Fixture paragraph ${index}.`).join('\n\n')
    const issues = Array.from({ length: 40 }, (_, index) => ({
      ...template,
      number: 9000 + index,
      title: `Fixture overflow issue ${index}`,
      url: `https://github.com/mock/repo/issues/${9000 + index}`,
      body: index === 0 || index === 3 ? longBody : 'short',
    }))
    const stub = JSON.stringify({ ...gh, issues, prs: gh.prs ?? [] })

    await rememberGithubView('issues')
    browser.setViewport(DESKTOP.width, height)
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelector('a[href="${scoped('/github')}"]') !== null`)
    browser.evaluate(`(() => {
      const nativeFetch = window.fetch;
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        if (new URL(url, location.href).pathname.endsWith('/github')) {
          return Promise.resolve(new Response(${JSON.stringify(stub)}, { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        return nativeFetch(input, init);
      };
      document.querySelector('a[href="${scoped('/github')}"]').click();
    })()`)
    browser.waitForFunction(`document.querySelectorAll('[data-slot="gh-row"]').length === 40`)
    browser.waitForFunction(`document.querySelector('[data-slot="gh-detail"]') !== null`)

    const atTop = browser.waitForValue<{ titleVisible: boolean }>(`(() => {
      const main = document.querySelector('[data-slot="main"]');
      const masthead = document.querySelector('[data-slot="gh-masthead"]');
      if (!main || !masthead) return null;
      main.scrollTop = 0;
      return { titleVisible: masthead.getBoundingClientRect().bottom > main.getBoundingClientRect().top + 8 };
    })()`, (value) => Boolean(value?.titleVisible))
    expect(atTop).toMatchObject({ titleVisible: true })

    // Trusted wheel input must move the page first, even over either scrollable pane.
    for (const slot of ['gh-list', 'gh-detail']) {
      browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop = 0`)
      const point = browser.waitForValue<{ x: number; y: number }>(`(() => {
        const main = document.querySelector('[data-slot="main"]');
        const pane = document.querySelector('[data-slot="${slot}"]');
        if (!main || !pane || main.scrollTop !== 0) return null;
        const box = pane.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + 40 };
      })()`)
      await browser.wheelAt(point.x, point.y, 40)
      const scrolled = browser.waitForValue<{ page: number; list: number; detail: number }>(`(() => {
        return {
          page: document.querySelector('[data-slot="main"]').scrollTop,
          list: document.querySelector('[data-slot="gh-list"]').scrollTop,
          detail: document.querySelector('[data-slot="gh-detail"]').scrollTop,
        };
      })()`, value => Boolean(value && value.page > 0))
      expect(scrolled.list).toBe(0)
      expect(scrolled.detail).toBe(0)
    }

    const evidence = browser.waitForValue<{
      bottomGap: number
      panesUncovered: boolean
      titleGone: boolean
      tabsVisible: boolean
      filtersVisible: boolean
      listMoved: boolean
      detailStill: boolean
      detailMoved: boolean
      listStill: boolean
      listHasNoXScroll: boolean
    }>(`(() => {
      const main = document.querySelector('[data-slot="main"]');
      const masthead = document.querySelector('[data-slot="gh-masthead"]');
      const tabs = document.querySelector('[data-slot="gh-tabs"]');
      const toolbar = document.querySelector('[data-slot="gh-header"]');
      const list = document.querySelector('[data-slot="gh-list"]');
      const detail = document.querySelector('[data-slot="gh-detail"]');
      if (!main || !masthead || !tabs || !toolbar || !list || !detail) return null;
      main.scrollTop = main.scrollHeight;
      const mainTop = main.getBoundingClientRect().top;
      const titleGone = masthead.getBoundingClientRect().bottom <= mainTop + 2;
      const tabsBox = tabs.getBoundingClientRect();
      const tabsVisible = tabsBox.top >= mainTop - 2 && tabsBox.bottom > mainTop + 16;
      const filtersVisible = toolbar.getBoundingClientRect().bottom > mainTop + 8;
      const mainBottom = main.getBoundingClientRect().bottom;
      const bottomGap = Math.round(mainBottom - Math.max(
        list.getBoundingClientRect().bottom,
        detail.getBoundingClientRect().bottom,
      ));
      const panesUncovered = [list, detail].every(pane => {
        const box = pane.getBoundingClientRect();
        return box.top >= toolbar.getBoundingClientRect().bottom && box.bottom <= mainBottom - 15;
      });
      list.scrollTop = 0;
      detail.scrollTop = 0;
      const detailBefore = detail.scrollTop;
      list.scrollTop = 160;
      const listMoved = list.scrollTop >= 80;
      const detailStill = detail.scrollTop === detailBefore;
      const listBefore = list.scrollTop;
      detail.scrollTop = 160;
      const detailMoved = detail.scrollTop >= 80;
      const listStill = list.scrollTop === listBefore;
      const listHasNoXScroll = getComputedStyle(list).overflowX === 'hidden';
      return {
        bottomGap,
        panesUncovered,
        titleGone,
        tabsVisible,
        filtersVisible,
        listMoved,
        detailStill,
        detailMoved,
        listStill,
        listHasNoXScroll,
        mainScroll: [main.scrollTop, main.scrollHeight, main.clientHeight],
        listOverflow: getComputedStyle(list).overflowY,
        listSizes: [list.scrollHeight, list.clientHeight, list.scrollWidth, list.clientWidth],
      };
    })()`, (value) => Boolean(
      value &&
        value.bottomGap >= 15 && value.bottomGap <= 17 &&
        value.panesUncovered &&
        value.titleGone &&
        value.tabsVisible &&
        value.filtersVisible &&
        value.listMoved &&
        value.detailStill &&
        value.detailMoved &&
        value.listStill &&
        value.listHasNoXScroll,
    ))
    expect(evidence).toMatchObject({
      bottomGap: 16,
      panesUncovered: true,
      titleGone: true,
      tabsVisible: true,
      filtersVisible: true,
      listMoved: true,
      detailStill: true,
      detailMoved: true,
      listStill: true,
      listHasNoXScroll: true,
    })
    for (const slot of ['gh-list', 'gh-detail']) {
      const before = browser.waitForValue<{ x: number; y: number; scroll: number; page: number; other: number }>(`(() => {
        const pane = document.querySelector('[data-slot="${slot}"]');
        const other = document.querySelector('[data-slot="${slot === 'gh-list' ? 'gh-detail' : 'gh-list'}"]');
        const box = pane.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + 60, scroll: pane.scrollTop,
          page: document.querySelector('[data-slot="main"]').scrollTop, other: other.scrollTop };
      })()`)
      await browser.wheelAt(before.x, before.y, 100)
      const after = browser.waitForValue<{ scroll: number; page: number; other: number }>(`({
        scroll: document.querySelector('[data-slot="${slot}"]').scrollTop,
        page: document.querySelector('[data-slot="main"]').scrollTop,
        other: document.querySelector('[data-slot="${slot === 'gh-list' ? 'gh-detail' : 'gh-list'}"]').scrollTop
      })`, value => Boolean(value && value.scroll > before.scroll))
      expect(after.page).toBe(before.page)
      expect(after.other).toBe(before.other)
    }

    const beforePick = browser.waitForValue<{ page: number; list: number; detail: number }>(`(() => ({
      page: document.querySelector('[data-slot="main"]').scrollTop,
      list: document.querySelector('[data-slot="gh-list"]').scrollTop,
      detail: document.querySelector('[data-slot="gh-detail"]').scrollTop,
    }))()`, value => Boolean(value && value.page > 0 && value.list > 0 && value.detail > 0))
    browser.evaluate(`document.querySelector('[data-slot="gh-row"][data-number="9003"]').click()`)
    browser.waitForFunction(`location.pathname === ${JSON.stringify(scoped('/github/issues/9003'))}`)
    browser.waitForFunction(`document.querySelector('[data-slot="gh-row"][data-number="9003"]')?.getAttribute('aria-current') === 'page'`)
    const afterPick = browser.waitForValue<{ page: number; list: number; detail: number; titleGone: boolean; rowHeight: number }>(`(() => {
      const main = document.querySelector('[data-slot="main"]');
      const masthead = document.querySelector('[data-slot="gh-masthead"]');
      return {
        page: main.scrollTop,
        list: document.querySelector('[data-slot="gh-list"]').scrollTop,
        detail: document.querySelector('[data-slot="gh-detail"]').scrollTop,
        titleGone: masthead.getBoundingClientRect().bottom <= main.getBoundingClientRect().top + 2,
        rowHeight: document.querySelector('[data-slot="gh-row"][data-number="9003"]').getBoundingClientRect().height,
      };
    })()`, value => Boolean(value && value.rowHeight >= 44))
    expect(afterPick).toMatchObject({ ...beforePick, titleGone: true })
    browser.screenshot(`${artifactsDir}/github-independent-scroll.png`)
  })

  it('lays out long issue and pull-request titles at the review viewports in both themes and densities', async () => {
    if (!forgeAvailable) return

    const longTitle =
      'Keep the shared GitHub synchronization workflow readable when several records begin with exactly the same words but end differently'
    const longAuthor = 'a-contributor-with-a-deliberately-long-github-login'
    const observations: Array<Record<string, unknown>> = []
    // The long title and login arrive as DATA, through the route's own `/api/v1/github` query,
    // rather than being written into the rendered row (#416): the mock catalog's first issue and
    // first PR come back renamed, and the component lays them out itself. Writing the strings
    // into React-owned nodes meant a re-render could restore the short ones mid-measurement —
    // or, committing against a replaced text node, take the whole root down.
    const relabelled = await api<GithubPayload>('/api/v1/github')
    const stub = JSON.stringify({
      ...relabelled,
      issues: relabelled.issues.map((issue, index) =>
        index === 0 ? { ...issue, title: longTitle, author: longAuthor } : issue,
      ),
      prs: relabelled.prs.map((pr, index) => (index === 0 ? { ...pr, title: longTitle, author: longAuthor } : pr)),
    })

    for (const viewport of [REVIEW_PHONE, DESKTOP]) {
      for (const theme of ['light', 'dark'] as const) {
        for (const density of ['comfortable', 'ultra'] as const) {
          browser.setViewport(viewport.width, viewport.height)
          // Land somewhere else first, install the stub, then reach GitHub by a CLIENT
          // navigation — the same order the loading/empty/error cases below use, because a
          // `goto` would reload the page and take the stub with it.
          await rememberGithubView('issues')
          browser.goto(`${baseUrl}${scoped('/')}`)
          browser.waitForFunction(`document.querySelector('a[href="${scoped('/github')}"]') !== null`)
          browser.evaluate(`(() => {
            document.documentElement.classList.toggle('light', ${theme === 'light'})
            document.documentElement.dataset.density = ${JSON.stringify(density)}
            const nativeFetch = window.fetch;
            window.fetch = (input, init) => {
              const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
              if (new URL(url, location.href).pathname.endsWith('/github')) {
                return Promise.resolve(new Response(${JSON.stringify(stub)}, { status: 200, headers: { 'content-type': 'application/json' } }));
              }
              return nativeFetch(input, init);
            };
            document.querySelector('a[href="${scoped('/github')}"]').click();
          })()`)
          if (viewport === REVIEW_PHONE) {
            // A phone lands on the filter index (#622); All issues pushes the list under test.
            browser.waitForFunction(`document.querySelector('[data-slot="github-filter-screen"] [data-gh-filter="all"]') !== null`)
            browser.click('[data-slot="github-filter-screen"] [data-gh-filter="all"]')
          }
          waitForGitHubSurface(scoped('/github'))

          for (const view of ['issues', 'prs'] as const) {
            const path: '/github' | '/github/prs' = view === 'issues' ? '/github' : '/github/prs'
            clickGitHubTab(path)
            browser.waitForFunction(
              `document.querySelector('[data-slot="gh-row"]')?.getAttribute('href')?.includes(${JSON.stringify(view === 'issues' ? '/issues/' : '/prs/')}) === true
                 && document.querySelector('[data-slot="gh-row"]').textContent.includes(${JSON.stringify(longAuthor)})`,
            )
            const facts = browser.evaluate(`(() => {
              const row = document.querySelector('[data-slot="gh-row"]')
              const titleLine = row.children[0]
              const icon = titleLine.children[0]
              const title = titleLine.children[1]
              const meta = row.children[1]
              const labels = row.children[2]
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
                iconOffset: icon.checkVisibility() ? Math.abs(iconRect.top - titleRect.top) : 0,
                metaLines,
                metaBelowTitle: metaRect.top >= titleRect.bottom,
                labelsBeforeMeta: !labelsRect || (labelsRect.top >= titleRect.bottom && labelsRect.bottom <= metaRect.top),
                pageOverflow: document.documentElement.scrollWidth > innerWidth,
                listWidth: document.querySelector('[data-slot="gh-list"]').getBoundingClientRect().width,
                light: document.documentElement.classList.contains('light'),
                appliedDensity: document.documentElement.dataset.density,
                titleText: title.textContent,
                authorText: meta.children[1].textContent,
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
              labelsBeforeMeta: boolean
              pageOverflow: boolean
              listWidth: number
              light: boolean
              appliedDensity: string
              titleText: string
              authorText: string
            }

            observations.push({ viewport, theme, density, view, ...facts })
            // The row really is laying out the long strings, and they came from the payload.
            expect(facts.titleText).toBe(longTitle)
            expect(facts.authorText).toBe(longAuthor)
            expect(facts.light).toBe(theme === 'light')
            expect(facts.appliedDensity).toBe(density)
            expect(facts.metaBelowTitle).toBe(true)
            expect(facts.labelsBeforeMeta).toBe(true)
            expect(facts.pageOverflow).toBe(false)
            if (viewport.width === REVIEW_PHONE.width) {
              expect(facts.titleLines).toBe(2)
              expect(facts.titleClamped).toBe(true)
              expect(facts.iconOffset).toBeLessThanOrEqual(3)
              expect(facts.metaLines).toBeGreaterThan(1)
            } else {
              // Desktop cards now wrap full titles; metadata must remain below them.
              expect(facts.titleLines).toBeGreaterThanOrEqual(1)
              expect(facts.titleOverflowing).toBe(false)
              expect(facts.whiteSpace).toBe('normal')
              expect(facts.metaLines).toBeGreaterThanOrEqual(1)
              expect(facts.listWidth).toBeGreaterThan(0)
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

// #724: GitHub hand-off pills follow the Runner · Model · Effort layout New Task and Continue share.
const ENGINE_ROW_FACTS = `(() => {
  const box = document.querySelector('[data-slot="engine-row-box"]');
  const hand = document.querySelector('[data-slot="gh-hand"]');
  const slots = ['runner-pill', 'model-pill', 'effort-pill'];
  const rects = Object.fromEntries(slots.map(slot => [slot, document.querySelector('[data-slot="' + slot + '"]')?.getBoundingClientRect()]));
  if (!box || !hand || slots.some(slot => !rects[slot])) return null;
  const { 'runner-pill': runner, 'model-pill': model, 'effort-pill': effort } = rects;
  const near = (a, b) => Math.abs(a - b) <= 2;
  return {
    innerWidth,
    boxWidth: Math.round(box.getBoundingClientRect().width),
    domOrder: [...box.querySelectorAll('[data-slot$="pill"]')].map(el => el.getAttribute('data-slot')),
    oneRow: near(runner.top, model.top) && near(model.top, effort.top),
    leftToRight: runner.right <= model.left + 2 && model.right <= effort.left + 2,
    modelWidest: model.width > runner.width && model.width > effort.width,
    topPairShareRow: near(runner.top, effort.top),
    modelBelow: model.top >= Math.max(runner.bottom, effort.bottom) - 2,
    modelSpansRow: near(model.left, runner.left) && near(model.right, effort.right),
    minHeight: Math.min(runner.height, model.height, effort.height),
    panelOverflow: hand.scrollWidth > hand.clientWidth,
    pageOverflow: document.documentElement.scrollWidth > innerWidth,
  };
})()`

interface EngineRowFacts {
  innerWidth: number
  boxWidth: number
  domOrder: string[]
  oneRow: boolean
  leftToRight: boolean
  modelWidest: boolean
  topPairShareRow: boolean
  modelBelow: boolean
  modelSpansRow: boolean
  minHeight: number
  panelOverflow: boolean
  pageOverflow: boolean
}

const WIDE_ORDER = ['runner-pill', 'model-pill', 'effort-pill']
const COMPACT_ORDER = ['runner-pill', 'effort-pill', 'model-pill']

const isWideRow = (f: EngineRowFacts | null): f is EngineRowFacts =>
  f !== null && f.boxWidth >= 550 && f.domOrder.join() === WIDE_ORDER.join() && f.oneRow && f.leftToRight && f.modelWidest
  && !f.panelOverflow && !f.pageOverflow && f.minHeight >= 44
const isCompactRow = (f: EngineRowFacts | null): f is EngineRowFacts =>
  f !== null && f.boxWidth < 550 && f.domOrder.join() === COMPACT_ORDER.join() && f.topPairShareRow && f.modelBelow && f.modelSpansRow
  && !f.panelOverflow && !f.pageOverflow && f.minHeight >= 44

async function openHandoffAt(viewport: { width: number; height: number }, theme: 'light' | 'dark') {
  const gh = await api<GithubPayload>('/api/v1/github')
  const first = gh.issues[0]!
  browser.setViewport(viewport.width, viewport.height)
  await openGitHub(`/github/issues/${first.number}`)
  browser.waitForFunction(`document.querySelector('[data-slot="gh-hand"]') !== null`)
  browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'}); document.querySelector('[data-slot="gh-hand"]').scrollIntoView({block:'start'})`)
}

// The matcher encodes the expected geometry and must hold for 200ms, so a layout that is still
// settling (or that flips back) cannot pass on its first sample.
const settledEngineRow = (matcher: (f: EngineRowFacts | null) => f is EngineRowFacts) =>
  browser.waitForStable<EngineRowFacts | null, EngineRowFacts>(ENGINE_ROW_FACTS, { holdMs: 200, matcher })

it.each(['light', 'dark'] as const)('puts Runner, Model and Effort on one row on a wide handoff panel, %s (#724)', async (theme) => {
  await openHandoffAt(DESKTOP, theme)
  const facts = settledEngineRow(isWideRow)
  expect(facts.domOrder).toEqual(WIDE_ORDER)
  browser.screenshot(`${artifactsDir}/github-engine-row-wide-${theme}.png`, { viewport: true })
}, 60_000)

it.each(['light', 'dark'] as const)('puts Runner and Effort over a full-width Model on a phone handoff panel, %s (#724)', async (theme) => {
  await openHandoffAt(REVIEW_PHONE, theme)
  // DOM order follows the visual order, so Tab goes Runner, Effort, Model (#492).
  const facts = settledEngineRow(isCompactRow)
  expect(facts.domOrder).toEqual(COMPACT_ORDER)
  browser.screenshot(`${artifactsDir}/github-engine-row-phone-${theme}.png`, { viewport: true })
}, 60_000)

// The phone case cannot tell the container query from the phone media query: both give the same
// geometry. A desktop viewport whose detail column is under 550px can: only the container query
// (and the JS measure behind the DOM order) applies there. With the sidebar and the issue list
// beside it the column is about viewport - 855px, so 1340px lands near 485px (narrower viewports
// squeeze the column to a sliver, which is a different layout concern).
it.each(['light', 'dark'] as const)('compacts the row when the handoff box is under 550px on a desktop-sized viewport, %s (#724)', async (theme) => {
  await openHandoffAt({ width: 1340, height: 900 }, theme)
  const facts = settledEngineRow((f): f is EngineRowFacts => isCompactRow(f) && f.innerWidth > 767)
  expect(facts.boxWidth).toBeLessThan(550)
  expect(facts.innerWidth).toBeGreaterThan(767)
  browser.screenshot(`${artifactsDir}/github-engine-row-narrow-box-${theme}.png`, { viewport: true })
}, 60_000)

it.each([1440, 402, 360].flatMap(width => ['light', 'dark'].map(theme => ({ width, theme }))))('keeps handoff fields usable at $width / $theme', async ({ width, theme }) => {
  const gh = await api<GithubPayload>('/api/v1/github')
  const first = gh.issues[0]!
  browser.setViewport(width, 1000)
  await openGitHub(`/github/issues/${first.number}`)
  browser.waitForFunction(`document.querySelector('[data-slot="gh-hand"]') !== null`)
  browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'}); document.documentElement.dataset.width = 'wide'; delete document.documentElement.dataset.density; document.querySelector('[data-slot="gh-hand"]').scrollIntoView({block:'start'})`)
  // #724: the engine pills share New Task's row, so the geometry depends on the row's own width
  // (>= 550px: one row; narrower, or a phone viewport: Runner + Effort over a full-width Model).
  const facts = browser.waitForStable<Record<string, boolean> | null>(`(() => {
    const rect = selector => document.querySelector(selector)?.getBoundingClientRect();
    const prompt = rect('[data-slot="gh-custom-prompt"]'), workflow = rect('[data-slot="gh-workflow-trigger"]'), model = rect('[data-slot="model-pill"]'), effort = rect('[data-slot="effort-pill"]'), account = rect('[aria-label="Account"]');
    if (!prompt || !workflow || !model || !effort || !account) return null;
    const compact = innerWidth <= 767 || rect('[data-slot="engine-row-box"]').width < 550;
    // Judged from geometry: Model sits below Effort exactly when the rule says the row is compact.
    return {
      promptFirst: prompt.bottom < workflow.top,
      rowBeforeAccount: Math.max(model.bottom, effort.bottom) < account.top,
      modelFillsRow: compact ? model.width > effort.width : model.width > effort.width * 1.5,
      layoutMatchesWidth: compact === (model.top >= effort.bottom - 2),
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  })()`, {
    holdMs: 200,
    matcher: (f) => f !== null && f.promptFirst === true && f.rowBeforeAccount === true && f.modelFillsRow === true && f.layoutMatchesWidth === true && f.overflow === false,
  })
  expect(facts).toEqual({ promptFirst: true, rowBeforeAccount: true, modelFillsRow: true, layoutMatchesWidth: true, overflow: false })
  expect(browser.evaluate(`(() => {
    const page = document.querySelector('[data-route="github"]');
    document.documentElement.dataset.width = 'narrow';
    const narrow = page.getBoundingClientRect().width;
    document.documentElement.dataset.width = 'wide';
    return Math.abs(page.getBoundingClientRect().width - narrow);
  })()`)).toBeLessThan(1)

  browser.fill('[data-slot="gh-custom-prompt"]', 'Review this issue and keep this draft')
  browser.waitForFunction(`document.querySelector('[data-slot="gh-custom-prompt"]').value === 'Review this issue and keep this draft'`)
  settleVisual(browser, '[data-route="github"]', { theme, width: 'wide', idle: true })
  browser.screenshot(`${artifactsDir}/revised-github-handoff-${width}-${theme}.png`, { viewport: true })
  browser.click('[data-slot="gh-workflow-trigger"]')
  browser.press('Escape')
  expect(browser.evaluate(`document.querySelector('[data-slot="gh-custom-prompt"]').value`)).toBe('Review this issue and keep this draft')
}, 90_000)

// #721: a metadata refresh used to insert a full-width status paragraph into the wrapping filter
// controls, pushing the board picker and the list down and then back up. A DOM assertion cannot see
// that, so a frame-by-frame sampler records the geometry across the whole delayed refresh.
it.each([{ width: 1440, height: 900 }, { width: 360, height: 640 }].flatMap(viewport => ['light', 'dark'].flatMap(theme => ['ready', 'unavailable'].map(outcome => ({ ...viewport, theme, outcome })))))('keeps filter geometry still while project boards refresh then settle as $outcome at $width / $theme (#721)', async ({ width, height, theme, outcome }) => {
  if (!forgeAvailable) return
  const gh = await api<GithubPayload>('/api/v1/github')
  const generation = '00000000-0000-4000-8000-000000000721'
  const projects = [{ id: 'P1', title: 'Delivery', url: 'https://github.com/orgs/mock/projects/1' }]
  const base = { ...gh, projectsState: 'ready', projects, issues: gh.issues.map(issue => ({ ...issue, projectIds: ['P1'] })) }
  const refreshing = { ...base, projectsState: 'refreshing', projectsGeneration: generation }
  const settled = outcome === 'ready'
    ? { generation, state: 'ready', projects, membership: {} }
    : { generation, state: 'unavailable', reason: 'Project lookup failed because GitHub rate limited the metadata request.' }
  browser.setViewport(width, height)
  browser.goto(`${baseUrl}${scoped('/')}`)
  browser.waitForFunction(`document.querySelector('a[href="${scoped('/github')}"]') !== null`)
  browser.evaluate(`(() => {
    const nativeFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof Request ? input.url : String(input), location.href);
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.pathname.endsWith('/github/projects')) return new Promise(resolve => { window.__finishProjects = () => resolve(json(${JSON.stringify(settled)})); });
      if (url.pathname.endsWith('/github')) return Promise.resolve(json(url.searchParams.get('refresh') === '1' ? ${JSON.stringify(refreshing)} : ${JSON.stringify(base)}));
      return nativeFetch(input, init);
    };
    history.pushState(null, '', '${scoped('/github?filter=all')}'); dispatchEvent(new PopStateEvent('popstate'));
  })()`)
  browser.waitForFunction(`document.querySelector('select[aria-label="Project board"]') !== null`)
  browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'}); document.documentElement.dataset.width = 'wide'`)
  // One sample per animation frame of everything the refresh must not move.
  browser.evaluate(`(() => {
    const seen = new Set();
    window.__geometry = seen;
    window.__geometrySamples = 0;
    const box = el => { const r = el.getBoundingClientRect(); return [r.top, r.left, r.width, r.height].map(n => Math.round(n * 10) / 10).join(','); };
    const tick = () => {
      const toolbar = document.querySelector('[data-slot="gh-filter-toolbar"]');
      const picker = document.querySelector('select[aria-label="Project board"]');
      const list = document.querySelector('[data-slot="gh-list"]');
      const search = document.querySelector('[data-slot="gh-search"]');
      if (toolbar && picker && list && search) seen.add(JSON.stringify({ toolbar: box(toolbar), picker: box(picker), list: box(list), search: box(search) }));
      window.__geometrySamples++;
      window.__geometryFrame = requestAnimationFrame(tick);
    };
    tick();
  })()`)
  const status = `document.querySelector('[data-slot="gh-filter-toolbar"] [role="status"]')?.textContent ?? ''`
  browser.click('[data-slot="gh-refresh"]')
  browser.waitForFunction(`(${status}).includes('Refreshing project boards')`)
  // The full text is one tap away and wraps instead of truncating; opening it must not move anything either.
  browser.click('[aria-label="Project board status"]')
  const readPopover = `(() => {
    const el = document.querySelector('[data-slot="gh-issue-status"]');
    if (!el) return null;
    const r = el.getBoundingClientRect(), style = getComputedStyle(el);
    return { text: el.textContent, lines: Math.round(el.clientHeight / parseFloat(style.lineHeight)), clipped: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1, inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight };
  })()`
  const refreshingPopover = browser.waitForValue<{ text: string; lines: number; clipped: boolean; inside: boolean }>(readPopover, value => Boolean(value?.text.includes('Refreshing project boards')))
  browser.waitForFunction('window.__geometrySamples >= 3')
  settleVisual(browser, '[data-slot="gh-filter-toolbar"]', { theme, width: 'wide' })
  // The delayed /github/projects request must have reached the interceptor before it can be released.
  // Provenance: with registration of window.__finishProjects delayed 1500ms (setTimeout in the interceptor) and this guard removed,
  // `-t "while project boards refresh then settle as .ready. at 1440 / .light."` fails with `TypeError: window.__finishProjects is not a function`
  // (bundle .ai/qa/failures/github-layout/, CEZ_AUTOMATIONS=0); with the guard and the same delay it passes.
  browser.waitForFunction("typeof window.__finishProjects === 'function'")
  browser.evaluate('window.__finishProjects()')
  browser.waitForFunction(outcome === 'ready'
    ? `!(${status}).includes('Refreshing project boards')`
    : `(${status}).includes('rate limited')`)
  if (outcome === 'ready') browser.waitForFunction(`document.activeElement?.matches('select[aria-label="Project board"]')`)
  settleVisual(browser, '[data-route="github"]', { theme, width: 'wide' })
  const facts = browser.evaluate(`(() => {
    cancelAnimationFrame(window.__geometryFrame);
    const samples = [...window.__geometry].map(sample => JSON.parse(sample));
    return {
      distinct: samples.length,
      toolbar: new Set(samples.map(s => s.toolbar)).size,
      picker: new Set(samples.map(s => s.picker)).size,
      list: new Set(samples.map(s => s.list)).size,
      search: new Set(samples.map(s => s.search)).size,
      pageOverflow: document.documentElement.scrollWidth > innerWidth,
      pickerValue: document.querySelector('select[aria-label="Project board"]').value,
      rows: document.querySelectorAll('[data-slot="gh-row"]').length,
      focusOnPicker: document.activeElement?.matches('select[aria-label="Project board"]') === true,
    };
  })()`) as { distinct: number; toolbar: number; picker: number; list: number; search: number; pageOverflow: boolean; pickerValue: string; rows: number; focusOnPicker: boolean }
  browser.screenshot(`${artifactsDir}/github-refresh-geometry-${width}-${theme}-${outcome}.png`, { viewport: true })
  expect(facts).toMatchObject({ distinct: 1, toolbar: 1, picker: 1, list: 1, search: 1, pageOverflow: false })
  expect(facts.rows).toBeGreaterThan(0)
  // Success dismisses the open status popover; focus must land on a visible control, not <body>.
  if (outcome === 'ready') expect(facts.focusOnPicker).toBe(true)
  expect(refreshingPopover).toMatchObject({ clipped: false, inside: true })
  expect(refreshingPopover.text).toContain('issues with unknown membership remain visible')
  if (width === 360) expect(refreshingPopover.lines).toBeGreaterThan(2)
  if (outcome === 'unavailable') {
    const unavailablePopover = browser.waitForValue<{ text: string; lines: number; clipped: boolean; inside: boolean }>(readPopover, value => Boolean(value?.text.includes('rate limited')))
    expect(unavailablePopover).toMatchObject({ clipped: false, inside: true })
    if (width === 360) expect(unavailablePopover.lines).toBeGreaterThan(2)
  }
  browser.setViewport(DESKTOP.width, DESKTOP.height)
}, 90_000)

// Review of #721: with NO cached boards the picker used to be sized by its option text, so
// "Loading boards…" -> "Boards unavailable" (or long board names) moved the picker and search.
it.each([{ width: 1440, height: 900 }, { width: 360, height: 640 }].flatMap(viewport => ['light', 'dark'].flatMap(theme => ['unavailable', 'long names'].map(outcome => ({ ...viewport, theme, outcome })))))('keeps filter geometry still without cached boards, settling as $outcome at $width / $theme (#721)', async ({ width, height, theme, outcome }) => {
  if (!forgeAvailable) return
  const gh = await api<GithubPayload>('/api/v1/github')
  const generation = '00000000-0000-4000-8000-000000000722'
  const projects = [
    { id: 'P1', title: 'Delivery roadmap for the entire platform engineering organisation', url: 'https://github.com/orgs/mock/projects/1' },
    { id: 'P2', title: 'Q4', url: 'https://github.com/orgs/mock/projects/2' },
  ]
  const loading = { ...gh, projects: undefined, projectsState: 'refreshing', projectsGeneration: generation }
  const settled = outcome === 'long names'
    ? { generation, state: 'ready', projects, membership: {} }
    : { generation, state: 'unavailable', reason: 'Project lookup failed.' }
  browser.setViewport(width, height)
  browser.goto(`${baseUrl}${scoped('/')}`)
  browser.waitForFunction(`document.querySelector('a[href="${scoped('/github')}"]') !== null`)
  browser.evaluate(`(() => {
    const nativeFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof Request ? input.url : String(input), location.href);
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.pathname.endsWith('/github/projects')) return new Promise(resolve => { window.__finishProjects = () => resolve(json(${JSON.stringify(settled)})); });
      if (url.pathname.endsWith('/github')) return Promise.resolve(json(${JSON.stringify(loading)}));
      return nativeFetch(input, init);
    };
    history.pushState(null, '', '${scoped('/github?filter=all')}'); dispatchEvent(new PopStateEvent('popstate'));
  })()`)
  browser.waitForFunction(`document.querySelector('select[aria-label="Project board"]') !== null`)
  browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'}); document.documentElement.dataset.width = 'wide'`)
  browser.evaluate(`(() => {
    const seen = new Set();
    window.__geometry = seen;
    window.__geometrySamples = 0;
    const box = el => { const r = el.getBoundingClientRect(); return [r.top, r.left, r.width, r.height].map(n => Math.round(n * 10) / 10).join(','); };
    const tick = () => {
      const toolbar = document.querySelector('[data-slot="gh-filter-toolbar"]');
      const picker = document.querySelector('select[aria-label="Project board"]');
      const list = document.querySelector('[data-slot="gh-list"]');
      const search = document.querySelector('[data-slot="gh-search"]');
      if (toolbar && picker && list && search) seen.add(JSON.stringify({ toolbar: box(toolbar), picker: box(picker), list: box(list), search: box(search) }));
      window.__geometrySamples++;
      window.__geometryFrame = requestAnimationFrame(tick);
    };
    tick();
  })()`)
  browser.waitForFunction(`document.querySelector('select[aria-label="Project board"]')?.textContent.includes('Loading boards') && window.__geometrySamples >= 3`)
  settleVisual(browser, '[data-slot="gh-filter-toolbar"]', { theme, width: 'wide' })
  // The delayed /github/projects request must have reached the interceptor before it can be released.
  browser.waitForFunction("typeof window.__finishProjects === 'function'")
  browser.evaluate('window.__finishProjects()')
  browser.waitForFunction(outcome === 'long names'
    ? `[...document.querySelector('select[aria-label="Project board"]').options].some(option => option.textContent.includes('Delivery roadmap'))`
    : `document.querySelector('select[aria-label="Project board"]').options[0].textContent === 'Boards unavailable'`)
  settleVisual(browser, '[data-route="github"]', { theme, width: 'wide' })
  const facts = browser.evaluate(`(() => {
    cancelAnimationFrame(window.__geometryFrame);
    const samples = [...window.__geometry].map(sample => JSON.parse(sample));
    return {
      distinct: samples.length,
      pageOverflow: document.documentElement.scrollWidth > innerWidth,
    };
  })()`) as { distinct: number; pageOverflow: boolean }
  browser.screenshot(`${artifactsDir}/github-no-boards-geometry-${width}-${theme}-${outcome.replace(' ', '-')}.png`, { viewport: true })
  expect(facts).toEqual({ distinct: 1, pageOverflow: false })
  browser.setViewport(DESKTOP.width, DESKTOP.height)
}, 90_000)

// Review of #721: a CLOSED status button holding keyboard focus is hidden by success; focus must be
// handed to a visible control before that, and focus that was elsewhere must stay where it was.
it.each([1440, 360].flatMap(width => ['status button', 'search'].map(focus => ({ width, focus }))))('hands focus on from the closed status button but leaves other focus alone at $width ($focus) (#721)', async ({ width, focus }) => {
  if (!forgeAvailable) return
  const gh = await api<GithubPayload>('/api/v1/github')
  const generation = '00000000-0000-4000-8000-000000000723'
  const projects = [{ id: 'P1', title: 'Delivery', url: 'https://github.com/orgs/mock/projects/1' }]
  const base = { ...gh, projectsState: 'ready', projects, issues: gh.issues.map(issue => ({ ...issue, projectIds: ['P1'] })) }
  const refreshing = { ...base, projectsState: 'refreshing', projectsGeneration: generation }
  browser.setViewport(width, width === 360 ? 640 : 900)
  browser.goto(`${baseUrl}${scoped('/')}`)
  browser.waitForFunction(`document.querySelector('a[href="${scoped('/github')}"]') !== null`)
  browser.evaluate(`(() => {
    const nativeFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof Request ? input.url : String(input), location.href);
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.pathname.endsWith('/github/projects')) return new Promise(resolve => { window.__finishProjects = () => resolve(json(${JSON.stringify({ generation, state: 'ready', projects, membership: {} })})); });
      if (url.pathname.endsWith('/github')) return Promise.resolve(json(url.searchParams.get('refresh') === '1' ? ${JSON.stringify(refreshing)} : ${JSON.stringify(base)}));
      return nativeFetch(input, init);
    };
    history.pushState(null, '', '${scoped('/github?filter=all')}'); dispatchEvent(new PopStateEvent('popstate'));
  })()`)
  browser.waitForFunction(`document.querySelector('select[aria-label="Project board"]') !== null`)
  browser.click('[data-slot="gh-refresh"]')
  browser.waitForFunction(`document.querySelector('[data-slot="gh-filter-toolbar"] [role="status"]')?.textContent.includes('Refreshing project boards')`)
  const target = focus === 'search' ? '[data-slot="gh-search"]' : '[aria-label="Project board status"]'
  browser.evaluate(`document.querySelector('${target}').focus()`)
  browser.waitForFunction(`document.activeElement?.matches('${target}')`)
  // The delayed /github/projects request must have reached the interceptor before it can be released.
  browser.waitForFunction("typeof window.__finishProjects === 'function'")
  browser.evaluate('window.__finishProjects()')
  browser.waitForFunction(`document.querySelector('select[aria-label="Project board"]') && !document.querySelector('[data-slot="gh-filter-toolbar"] [role="status"]').textContent.includes('Refreshing')`)
  const active = browser.waitForValue(`(() => { const a = document.activeElement; return { body: a === document.body, picker: a?.matches('select[aria-label="Project board"]') === true, search: a?.matches('[data-slot="gh-search"]') === true }; })()`, (value: { body: boolean; picker: boolean; search: boolean }) => !value.body && (focus === 'search' ? value.search : value.picker))
  expect(active).toEqual(focus === 'search' ? { body: false, picker: false, search: true } : { body: false, picker: true, search: false })
  browser.setViewport(DESKTOP.width, DESKTOP.height)
}, 90_000)
