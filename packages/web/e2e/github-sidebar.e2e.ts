import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { artifactsDir } from './github-fixture'
import { stopFixtureServer } from './fixture-server'
import { waitForHealth } from './poll'

/**
 * #622 (GitHub slice): the GitHub view's own sidebar (desktop) and filter index (phone), in a real
 * browser against its own fixture server.
 *
 * The fixture server is a dry-run cezar whose project has a `github.com/example/sidebar-fixture`
 * remote and a hand-written `runs.json`; the GitHub payloads are served through Chrome's network
 * layer (`routeJson`), because dry-run search only understands text and the qualifier searches
 * (`review-requested:@me`, `status:failure`) need deterministic hits. No server or contract change.
 *
 * The counts are the point, so the fixture is built around one negative for every rule:
 *   - Issue #101 is joined by a same-project run's numeric `issueNumber`, #103 by its issue URL.
 *   - #105 is named only by a run of ANOTHER repository (`other/repo`), #106 only by an ARCHIVED
 *     run, and #201's PR run is not an issue reference at all: none of them may count as tasked.
 *   - Review hits include #210, which the open list does not carry, and failing hits fill the
 *     forge search cap, so that count must say "50+", never "50".
 */

const PHONE = { width: 360, height: 640 }
const DESKTOP = { width: 1440, height: 900 }

const SIDEBAR = '[data-slot="github-sidebar"]'
const SCREEN = '[data-slot="github-filter-screen"]'
const TAB_BAR = '[data-slot="mobile-tab-bar"]'
const BACK = '[data-slot="mobile-top-bar"] [data-slot="mobile-back"]'
const COUNT = '[data-slot="gh-filter-count"]'
const ROWS = '[data-slot="gh-rows"] [data-slot="gh-row"]'

const ALL_FILTERS = ['assigned', 'no-task', 'has-task', 'all', 'review', 'mine', 'failing', 'all-prs']
const REPO = 'example/sidebar-fixture'
const VIEWER = 'octocat'

const SEARCH_MAX = 50
const REVIEW_QUERY = '**/github/search?*review-requested*'
const FAILING_QUERY = '**/github/search?*status*'
// The list request is the only one carrying `limit=`; a bare `**/github?*` would also match the
// page's own document URL (`/p/x/github?filter=all`), and the boot project is served unscoped.
const LIST_ROUTE = '**/github?limit=*'

let root: string
let base: string
let project: string
let server: ChildProcess
let browser: AgentBrowser
const extraBrowsers: AgentBrowser[] = []

const scoped = (path: string) => `/p/${project}${path}`
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

const issue = (number: number, extra: Record<string, unknown> = {}) => ({
  kind: 'issue', number, title: `Fixture issue ${number}`, author: 'reporter', createdAt: ago(3_600_000),
  labels: [], body: `Body of issue ${number}`, url: `https://github.com/${REPO}/issues/${number}`, comments: 0, ...extra,
})
const pr = (number: number, extra: Record<string, unknown> = {}) => ({
  kind: 'pr', number, title: `Fixture pull request ${number}`, author: 'alice', createdAt: ago(3_600_000),
  labels: [], body: `Body of pull request ${number}`, url: `https://github.com/${REPO}/pull/${number}`, comments: 0,
  isDraft: false, additions: 3, deletions: 1, checks: null, ...extra,
})

const ISSUES = [
  issue(101, { assignees: [VIEWER] }),
  issue(102, { assignees: ['Octocat'] }), // logins compare case-insensitively
  issue(103),
  issue(104, { assignees: ['someone-else'] }),
  issue(105),
  issue(106),
]
const PRS = [
  pr(201, { author: VIEWER }),
  pr(202, { author: VIEWER }),
  pr(203, { author: 'alice' }),
  pr(204, { author: 'bob', checks: 'failing' }),
  pr(205, { author: 'carol' }),
]
const REVIEW_HITS = [PRS[2]!, pr(210, { author: 'dave' })] // #210 is beyond the open list
const FAILING_HITS = Array.from({ length: SEARCH_MAX }, (_, index) => pr(300 + index, { checks: 'failing' }))

const listPayload = (over: Record<string, unknown> = {}) => ({
  available: true, repo: REPO, syncedAt: ago(1_000), issues: ISSUES, prs: PRS, labelColors: {}, viewerLogin: VIEWER, ...over,
})
const searchPayload = (items: unknown[], over: Record<string, unknown> = {}) => ({ available: true, items, ...over })

const run = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: id, workflow: 'default', task: id, status: 'done', createdAt: ago(7_200_000), finishedAt: ago(3_600_000),
  tokensUsed: 0, archived: false, steps: [], ...extra,
})

/** Install the deterministic GitHub answers on one browser session. */
function route(target: AgentBrowser, over: { list?: unknown; review?: unknown; failing?: unknown } = {}): void {
  target.routeJson(LIST_ROUTE, over.list ?? listPayload())
  target.routeJson(REVIEW_QUERY, over.review ?? searchPayload(REVIEW_HITS))
  target.routeJson(FAILING_QUERY, over.failing ?? searchPayload(FAILING_HITS, { truncated: true }))
}

function session(name: string, viewport = DESKTOP): AgentBrowser {
  const target = AgentBrowser.open(`gh-sidebar-${name}-${process.pid}`)
  extraBrowsers.push(target)
  target.setViewport(viewport.width, viewport.height)
  return target
}

const sameJson = (expected: unknown) => (value: unknown) => JSON.stringify(value) === JSON.stringify(expected)

/** Every filter row's count text inside `container`, keyed by filter (null = no count rendered). */
const countsJs = (container: string) => `(() => {
  const box = document.querySelector(${JSON.stringify(container)});
  if (!box) return null;
  const out = {};
  for (const row of box.querySelectorAll('[data-gh-filter]')) {
    out[row.getAttribute('data-gh-filter')] = row.querySelector(${JSON.stringify(COUNT)})?.textContent.trim() ?? null;
  }
  return out;
})()`

/** The numbers of the rows in the main list, sorted (the order is the list's own, not the subject). */
const rowNumbersJs = `[...document.querySelectorAll(${JSON.stringify(ROWS)})].map((row) => Number(row.dataset.number)).sort((a, b) => a - b)`
const locationJs = `location.pathname + location.search`
const currentJs = (container: string) => `(() => {
  const box = document.querySelector(${JSON.stringify(container)});
  if (!box) return null;
  return [...box.querySelectorAll('[data-gh-filter][aria-current="page"]')].map((row) => row.getAttribute('data-gh-filter'));
})()`

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index)

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cez-gh-sidebar-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit', '--allow-empty', '-m', 'fixture')
  git('remote', 'add', 'origin', `https://github.com/${REPO}.git`)
  mkdirSync(join(root, '.ai/cezar'), { recursive: true })
  writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify([
    run('task-numeric', { issueNumber: 101 }),
    run('task-url', { referencedIssueUrl: `https://github.com/${REPO}/issues/103` }),
    run('task-foreign', { referencedIssueUrl: 'https://github.com/other/repo/issues/105', task: 'Look at https://github.com/other/repo/issues/105' }),
    run('task-archived', { issueNumber: 106, archived: true, archivedAt: ago(1_000) }),
    run('task-pr-only', { pullRequestUrl: `https://github.com/${REPO}/pull/201` }),
  ]))
  const probe = createServer()
  const port = await new Promise<number>((done) => probe.listen(0, '127.0.0.1', () => {
    const address = (probe.address() as { port: number }).port
    probe.close(() => done(address))
  }))
  base = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(root), stdio: 'ignore',
  })
  await waitForHealth(base)
  project = await bootProjectId(base)
  const health = (await fetch(`${base}/api/v1/health`).then((response) => response.json())) as { forge: { available: boolean } | null }
  if (health.forge?.available !== true) throw new Error('cezar e2e: the dry-run fixture server must report an available forge')
  mkdirSync(artifactsDir, { recursive: true })
  browser = AgentBrowser.open(`gh-sidebar-${process.pid}`)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
  route(browser)
}, 60_000)

afterAll(async () => {
  browser?.close()
  for (const extra of extraBrowsers) extra.close()
  await stopFixtureServer(server)
  if (root) rmSync(root, { recursive: true, force: true })
})

async function remember(githubView: 'issues' | 'prs'): Promise<void> {
  const response = await fetch(`${base}/api/v1/ui-state`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ githubView }),
  })
  if (!response.ok) throw new Error(`cezar e2e: PUT /api/v1/ui-state answered ${response.status}`)
}

const EXPECTED_COUNTS = {
  assigned: '2', 'no-task': '4', 'has-task': '2', all: '6', review: '2', mine: '2', failing: `${SEARCH_MAX}+`, 'all-prs': '5',
}

describe('GitHub desktop sidebar (#622)', () => {
  it('lists all seven filters with honest counts, joined to same-project, non-archived, same-repo tasks', async () => {
    await remember('issues')
    browser.setViewport(DESKTOP.width, DESKTOP.height)
    browser.goto(`${base}${scoped('/github?filter=all')}`)
    browser.waitForFunction(`document.querySelector(${JSON.stringify(SIDEBAR)}) !== null`)
    expect(browser.waitForValue(`[...document.querySelectorAll('${SIDEBAR} [data-gh-filter]')].map((row) => row.getAttribute('data-gh-filter'))`, sameJson(ALL_FILTERS)))
      .toEqual(ALL_FILTERS)
    // Each rule and its negative in one read: #105 (other repo), #106 (archived run) and the PR-only
    // run stay untasked; search-backed counts come from the hits, capped honestly ("50+").
    expect(browser.waitForValue(countsJs(SIDEBAR), sameJson(EXPECTED_COUNTS))).toEqual(EXPECTED_COUNTS)
    expect(browser.waitForValue(currentJs(SIDEBAR), sameJson(['all']))).toEqual(['all'])
    browser.screenshot(`${artifactsDir}/github-sidebar-counts.png`, { viewport: true })
  }, 90_000)

  it('each issue filter narrows the main list and keeps the choice in the URL', async () => {
    await remember('issues')
    browser.setViewport(DESKTOP.width, DESKTOP.height)
    browser.goto(`${base}${scoped('/github?filter=all')}`)
    browser.waitForFunction(`document.querySelectorAll(${JSON.stringify(ROWS)}).length === 6`)
    const expected = {
      assigned: [101, 102],
      'no-task': [102, 104, 105, 106].sort((a, b) => a - b),
      'has-task': [101, 103],
      all: [101, 102, 103, 104, 105, 106],
    }
    for (const [filter, numbers] of Object.entries(expected)) {
      browser.click(`${SIDEBAR} [data-gh-filter="${filter}"]`)
      expect(browser.waitForValue(rowNumbersJs, sameJson(numbers))).toEqual(numbers)
      expect(browser.waitForValue(locationJs, (value) => value === `${scoped('/github')}?filter=${filter}`)).toBe(`${scoped('/github')}?filter=${filter}`)
      expect(browser.waitForValue(currentJs(SIDEBAR), sameJson([filter]))).toEqual([filter])
    }
  }, 90_000)

  it('each PR filter renders its rows from the search hits, not from the open list', async () => {
    await remember('issues')
    browser.setViewport(DESKTOP.width, DESKTOP.height)
    browser.goto(`${base}${scoped('/github/prs?filter=all')}`)
    browser.waitForFunction(`document.querySelectorAll(${JSON.stringify(ROWS)}).length === ${PRS.length}`)
    const expected = {
      review: [203, 210], // #210 is not in the open list: the row must come from the hit
      mine: [201, 202],
      failing: range(300, 300 + SEARCH_MAX - 1),
      all: [201, 202, 203, 204, 205],
    }
    for (const [filter, numbers] of Object.entries(expected)) {
      browser.click(`${SIDEBAR} [data-gh-filter="${filter}"]`)
      expect(browser.waitForValue(rowNumbersJs, sameJson(numbers))).toEqual(numbers)
      expect(browser.waitForValue(locationJs, (value) => value === `${scoped('/github/prs')}?filter=${filter}`)).toBe(`${scoped('/github/prs')}?filter=${filter}`)
      expect(browser.waitForValue(currentJs(SIDEBAR), sameJson([filter]))).toEqual([filter])
    }
    // The extra escape hatch: every PR, whatever the filter.
    browser.click(`${SIDEBAR} [data-gh-filter="all-prs"]`)
    expect(browser.waitForValue(locationJs, (value) => String(value).startsWith(`${scoped('/github/prs')}`))).toContain('/github/prs')
    expect(browser.waitForValue(rowNumbersJs, sameJson([201, 202, 203, 204, 205]))).toEqual([201, 202, 203, 204, 205])
  }, 90_000)

  it('reloading reapplies the filter, an explicit filter bypasses the remembered view, bare PR links still work', async () => {
    await remember('prs')
    browser.setViewport(DESKTOP.width, DESKTOP.height)
    browser.goto(`${base}${scoped('/github?filter=no-task')}`)
    expect(browser.waitForValue(rowNumbersJs, sameJson([102, 104, 105, 106]))).toEqual([102, 104, 105, 106])
    expect(browser.waitForValue(locationJs)).toBe(`${scoped('/github')}?filter=no-task`)
    browser.goto(`${base}${scoped('/github?filter=no-task')}`)
    expect(browser.waitForValue(rowNumbersJs, sameJson([102, 104, 105, 106]))).toEqual([102, 104, 105, 106])
    expect(browser.waitForValue(currentJs(SIDEBAR), sameJson(['no-task']))).toEqual(['no-task'])

    browser.goto(`${base}${scoped('/github/prs')}`)
    expect(browser.waitForValue(rowNumbersJs, sameJson([201, 202, 203, 204, 205]))).toEqual([201, 202, 203, 204, 205])
    expect(browser.waitForValue(locationJs)).toBe(scoped('/github/prs'))
    await remember('issues')
  }, 90_000)

  it('keeps the filter through an issue detail, its Back link and a reload', async () => {
    await remember('issues')
    browser.setViewport(DESKTOP.width, DESKTOP.height)
    browser.goto(`${base}${scoped('/github?filter=no-task')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="gh-row"][data-number="104"]') !== null`)
    browser.click('[data-slot="gh-row"][data-number="104"]')
    const detailUrl = `${scoped('/github/issues/104')}?filter=no-task`
    expect(browser.waitForValue(locationJs, (value) => value === detailUrl)).toBe(detailUrl)
    browser.waitForFunction(`document.querySelector('[data-slot="gh-detail-inner"]') !== null`)
    expect(browser.waitForValue(currentJs(SIDEBAR), sameJson(['no-task']))).toEqual(['no-task'])
    expect(browser.waitForValue(rowNumbersJs, sameJson([102, 104, 105, 106]))).toEqual([102, 104, 105, 106])

    browser.goto(`${base}${scoped('/github/issues/104?filter=no-task')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="gh-detail-inner"]') !== null`)
    expect(browser.waitForValue(rowNumbersJs, sameJson([102, 104, 105, 106]))).toEqual([102, 104, 105, 106])
    expect(browser.waitForValue(currentJs(SIDEBAR), sameJson(['no-task']))).toEqual(['no-task'])

    expect(browser.waitForValue(`document.querySelector('[data-slot="gh-back"]')?.getAttribute('href')`))
      .toBe(`${scoped('/github')}?filter=no-task`)
    browser.click(`[data-slot="gh-back"]`)
    expect(browser.waitForValue(locationJs, (value) => value === `${scoped('/github')}?filter=no-task`)).toBe(`${scoped('/github')}?filter=no-task`)
  }, 90_000)

  it('keeps a search hit that is not in the open list selected across a reload', async () => {
    await remember('issues')
    browser.setViewport(DESKTOP.width, DESKTOP.height)
    browser.goto(`${base}${scoped('/github/prs/210?filter=review')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="gh-detail-inner"]') !== null`)
    expect(browser.waitForValue(rowNumbersJs, sameJson([203, 210]))).toEqual([203, 210])
    expect(browser.waitForValue(`document.querySelector('[data-slot="gh-row"][data-number="210"]')?.getAttribute('aria-current')`)).toBe('page')
    expect(browser.waitForValue(currentJs(SIDEBAR), sameJson(['review']))).toEqual(['review'])
  }, 90_000)

  it('paints 32px rows, 13px labels, 11.5px counts and 15px icons in light and dark', async () => {
    await remember('issues')
    for (const theme of ['light', 'dark'] as const) {
      browser.setViewport(DESKTOP.width, DESKTOP.height)
      browser.goto(`${base}${scoped('/github?filter=all')}`)
      browser.waitForFunction(`document.querySelector(${JSON.stringify(SIDEBAR)}) !== null`)
      browser.evaluate(`document.documentElement.classList.remove('light', 'dark'); document.documentElement.classList.add('${theme}')`)
      const facts = browser.waitForValue<Record<string, unknown>>(`(() => {
        const sidebar = document.querySelector(${JSON.stringify(SIDEBAR)});
        const row = sidebar?.querySelector('[data-gh-filter="assigned"]');
        const active = sidebar?.querySelector('[data-gh-filter="all"]');
        const count = row?.querySelector(${JSON.stringify(COUNT)});
        if (!row || !active || !count || count.textContent.trim() === '') return null;
        const label = [...row.querySelectorAll('*')].find((el) => el !== count && !count.contains(el) && el.children.length === 0 && el.textContent.trim() !== '');
        const icon = row.querySelector('svg');
        const style = getComputedStyle(row);
        const alpha = (color) => color === 'transparent' ? 0 : Number((color.match(/[\\d.]+/g) ?? [])[3] ?? 1);
        return {
          light: document.documentElement.classList.contains('light'),
          height: row.getBoundingClientRect().height,
          paddingX: [style.paddingLeft, style.paddingRight],
          radius: style.borderTopLeftRadius,
          gap: style.columnGap,
          labelSize: getComputedStyle(label).fontSize,
          countSize: getComputedStyle(count).fontSize,
          icon: [icon.getBoundingClientRect().width, icon.getBoundingClientRect().height],
          activeDiffers: getComputedStyle(active).backgroundColor !== style.backgroundColor && alpha(getComputedStyle(active).backgroundColor) > 0,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      })()`)
      expect(facts).toEqual({
        light: theme === 'light', height: 32, paddingX: ['10px', '10px'], radius: '6px', gap: '10px',
        labelSize: '13px', countSize: '11.5px', icon: [15, 15], activeDiffers: true, overflow: false,
      })
      browser.screenshot(`${artifactsDir}/github-sidebar-desktop-${theme}.png`, { viewport: true })
    }
  }, 90_000)

  it('shows the task sidebar on other views and the settings sidebar in Settings, never the GitHub one', async () => {
    browser.setViewport(DESKTOP.width, DESKTOP.height)
    browser.goto(`${base}${scoped('/git')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="task-quick-list"]') !== null`)
    expect(browser.count(SIDEBAR)).toBe(0)

    browser.goto(`${base}${scoped('/github?filter=all')}`)
    browser.waitForFunction(`document.querySelector(${JSON.stringify(SIDEBAR)}) !== null`)
    expect(browser.waitForValue(`document.querySelector('[data-slot="task-quick-list"]') === null`)).toBe(true)

    browser.click('[data-slot="view-tabs"] a[aria-label="Tasks"]')
    browser.waitForFunction(`document.querySelector('[data-slot="task-quick-list"]') !== null && document.querySelector(${JSON.stringify(SIDEBAR)}) === null`)

    browser.goto(`${base}/settings/agents`)
    browser.waitForFunction(`document.querySelector('[data-slot="settings-sidebar"] [data-section="agents"][aria-current="page"]') !== null`)
    expect(browser.count(SIDEBAR)).toBe(0)
  }, 90_000)
})

describe('GitHub counts that cannot be known (#622)', () => {
  it('says N+ for a capped open list and never invents a total', () => {
    const capped = session('capped')
    // The list is NOT routed here: a 1000-item page is served in-page (routeJson bodies ride a
    // 128 KiB argv), through a CLIENT navigation so the stub is in place before the first fetch.
    capped.routeJson(REVIEW_QUERY, searchPayload([]))
    capped.routeJson(FAILING_QUERY, searchPayload([]))
    capped.goto(`${base}${scoped('/')}`)
    capped.waitForFunction(`document.querySelector('a[href="${scoped('/github')}"]') !== null`)
    capped.evaluate(`(() => {
      const items = Array.from({ length: 1000 }, (_, index) => ({
        kind: 'issue', number: 1001 + index, title: 'Capped ' + index, author: 'reporter', createdAt: '2026-01-01T00:00:00Z',
        labels: [], body: '', url: 'https://github.com/${REPO}/issues/' + (1001 + index), comments: 0,
        assignees: index % 4 === 0 ? ['${VIEWER}'] : [],
      }));
      const body = JSON.stringify({ available: true, repo: '${REPO}', issues: items, prs: [], viewerLogin: '${VIEWER}' });
      const nativeFetch = window.fetch;
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        if (new URL(url, location.href).pathname.endsWith('/github')) {
          return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        return nativeFetch(input, init);
      };
      document.querySelector('a[href="${scoped('/github')}"]').click();
    })()`)
    capped.waitForFunction(`document.querySelector(${JSON.stringify(SIDEBAR)} + ' [data-gh-filter="all"]') !== null`)
    const counts = capped.waitForValue<Record<string, string | null>>(countsJs(SIDEBAR), (value) => Boolean(value && value.all && /\d/.test(value.all)))
    // 1000 is the fetch cap, not the repository's total: the cap must show.
    expect(counts.all).toBe('1000+')
    expect(counts.assigned).toBe('250+')
    // Search-backed counts with zero hits are a real, complete zero; the open PR list is empty.
    expect(counts['all-prs']).toBe('0')
    capped.screenshot(`${artifactsDir}/github-sidebar-capped.png`, { viewport: true })
  }, 90_000)

  it('shows no number for an unavailable search or an unknown viewer, and explains why', () => {
    const unknown = session('unknown')
    route(unknown, {
      list: listPayload({ viewerLogin: undefined }),
      review: { available: false, reason: 'GitHub search is rate limited', items: [] },
    })
    unknown.goto(`${base}${scoped('/github/prs?filter=review')}`)
    unknown.waitForFunction(`document.querySelector(${JSON.stringify(SIDEBAR)} + ' [data-gh-filter="failing"] ${COUNT}') !== null`)
    const counts = unknown.waitForValue<Record<string, string | null>>(countsJs(SIDEBAR), (value) => Boolean(value && value.failing))
    // Not 0, not blank-as-zero: unknown counts render nothing numeric at all.
    for (const filter of ['review', 'assigned', 'mine']) expect(counts[filter] ?? '', `${filter} must not show a number`).not.toMatch(/\d/)
    // The neighbours that ARE known keep their numbers.
    expect(counts.all).toBe('6')
    expect(counts.failing).toBe(`${SEARCH_MAX}+`)
    // The unavailable search says why, where the rows would be.
    expect(unknown.waitForValue(`document.querySelector('[data-route="github"]')?.textContent.includes('rate limited') ? true : null`)).toBe(true)
    unknown.screenshot(`${artifactsDir}/github-sidebar-unknown.png`, { viewport: true })
  }, 90_000)

  it('keeps the sidebar with no number when GitHub itself is unavailable, and shows real zeros when it is simply empty', () => {
    const offline = session('offline')
    route(offline, {
      list: { available: false, reason: 'gh is not installed', issues: [], prs: [] },
      review: { available: false, reason: 'gh is not installed', items: [] },
      failing: { available: false, reason: 'gh is not installed', items: [] },
    })
    offline.goto(`${base}${scoped('/github?filter=all')}`)
    offline.waitForFunction(`document.querySelector(${JSON.stringify(SIDEBAR)} + ' [data-gh-filter]') !== null`)
    const unavailable = offline.waitForValue<Record<string, string | null>>(countsJs(SIDEBAR), (value) => Boolean(value && Object.keys(value).length === ALL_FILTERS.length))
    for (const filter of ALL_FILTERS) expect(unavailable[filter] ?? '', `${filter} must not show a number`).not.toMatch(/\d/)

    const empty = session('empty')
    route(empty, { list: listPayload({ issues: [], prs: [] }), review: searchPayload([]), failing: searchPayload([]) })
    empty.goto(`${base}${scoped('/github?filter=all')}`)
    const zeros = empty.waitForValue<Record<string, string | null>>(countsJs(SIDEBAR), (value) => Boolean(value && value.all === '0'))
    expect(zeros).toEqual({ assigned: '0', 'no-task': '0', 'has-task': '0', all: '0', review: '0', mine: '0', failing: '0', 'all-prs': '0' })
  }, 90_000)
})

describe('GitHub phone filter index at 360x640 (#622)', () => {
  const openIndex = () => {
    browser.setViewport(PHONE.width, PHONE.height)
    browser.goto(`${base}${scoped('/github')}`)
    browser.waitForFunction(`document.querySelector(${JSON.stringify(SCREEN)}) !== null`)
  }

  it('opens the filter index from the GitHub tab, even when another view is remembered', async () => {
    await remember('prs')
    browser.setViewport(PHONE.width, PHONE.height)
    browser.goto(`${base}${scoped('/')}`)
    browser.waitForFunction(`document.querySelector('${TAB_BAR} a[data-tab="/github"]') !== null`)
    browser.click(`${TAB_BAR} a[data-tab="/github"]`)
    browser.waitForFunction(`location.pathname === ${JSON.stringify(scoped('/github'))} && document.querySelector(${JSON.stringify(SCREEN)}) !== null`)
    expect(browser.waitForValue(`location.search`, (value) => value === '')).toBe('')
    expect(browser.count(SIDEBAR)).toBe(0)
    expect(browser.count('[data-slot="gh-row"]')).toBe(0)
    await remember('issues')
  }, 90_000)

  it('lists all seven filters at 48px with 18px icons and chevrons, and the same honest counts', () => {
    for (const theme of ['light', 'dark'] as const) {
      openIndex()
      browser.evaluate(`document.documentElement.classList.remove('light', 'dark'); document.documentElement.classList.add('${theme}')`)
      expect(browser.waitForValue(`[...document.querySelectorAll('${SCREEN} [data-gh-filter]')].map((row) => row.getAttribute('data-gh-filter'))`, sameJson(ALL_FILTERS)))
        .toEqual(ALL_FILTERS)
      expect(browser.waitForValue(countsJs(SCREEN), sameJson(EXPECTED_COUNTS))).toEqual(EXPECTED_COUNTS)
      const facts = browser.waitForValue<Record<string, unknown>>(`(() => {
        const rows = [...document.querySelectorAll('${SCREEN} [data-gh-filter]')];
        if (rows.length === 0) return null;
        const icons = rows.flatMap((row) => [...row.querySelectorAll('svg')].map((svg) => svg.getBoundingClientRect()));
        return {
          light: document.documentElement.classList.contains('light'),
          heights: [...new Set(rows.map((row) => row.getBoundingClientRect().height))],
          svgSizes: [...new Set(icons.map((rect) => rect.width + 'x' + rect.height))],
          hasChevron: rows.every((row) => row.querySelectorAll('svg').length >= 2),
          overflow: document.documentElement.scrollWidth > innerWidth,
          sidebarHidden: document.querySelector('${SIDEBAR}') === null || getComputedStyle(document.querySelector('${SIDEBAR}')).display === 'none',
        };
      })()`)
      expect(facts).toEqual({ light: theme === 'light', heights: [48], svgSizes: ['18x18'], hasChevron: true, overflow: false, sidebarHidden: true })
      browser.screenshot(`${artifactsDir}/github-filter-screen-${theme}.png`, { viewport: true })
    }
  }, 90_000)

  it('pushes the filtered list and Back returns to the index; the choice survives a resize', () => {
    openIndex()
    browser.click(`${SCREEN} [data-gh-filter="no-task"]`)
    const listUrl = `${scoped('/github')}?filter=no-task`
    expect(browser.waitForValue(locationJs, (value) => value === listUrl)).toBe(listUrl)
    expect(browser.waitForValue(rowNumbersJs, sameJson([102, 104, 105, 106]))).toEqual([102, 104, 105, 106])
    expect(browser.count(SCREEN)).toBe(0)
    // The pushed screen swaps the tab bar for a Back that says where it goes.
    const back = browser.waitForValue<string>(`(() => {
      const el = document.querySelector('${BACK}');
      return el ? (el.getAttribute('aria-label') ?? '') + ' ' + el.textContent : null;
    })()`)
    expect(back).toMatch(/filters/i)

    // A resize to desktop and back must not throw the phone back to the index (nor reset the filter).
    browser.setViewport(DESKTOP.width, DESKTOP.height)
    browser.waitForFunction(`document.querySelector(${JSON.stringify(SIDEBAR)}) !== null`)
    expect(browser.waitForValue(currentJs(SIDEBAR), sameJson(['no-task']))).toEqual(['no-task'])
    browser.setViewport(PHONE.width, PHONE.height)
    expect(browser.waitForValue(rowNumbersJs, sameJson([102, 104, 105, 106]))).toEqual([102, 104, 105, 106])
    expect(browser.waitForValue(locationJs, (value) => value === listUrl)).toBe(listUrl)
    expect(browser.count(SCREEN)).toBe(0)

    browser.click(BACK)
    browser.waitForFunction(`document.querySelector(${JSON.stringify(SCREEN)}) !== null`)
    expect(browser.waitForValue(locationJs, (value) => value === scoped('/github'))).toBe(scoped('/github'))
    expect(browser.count('[data-slot="gh-row"]')).toBe(0)
  }, 90_000)

  it('pushes PR filters under /github/prs and keeps the filter through detail and Back', () => {
    openIndex()
    browser.click(`${SCREEN} [data-gh-filter="review"]`)
    const listUrl = `${scoped('/github/prs')}?filter=review`
    expect(browser.waitForValue(locationJs, (value) => value === listUrl)).toBe(listUrl)
    expect(browser.waitForValue(rowNumbersJs, sameJson([203, 210]))).toEqual([203, 210])

    browser.click('[data-slot="gh-row"][data-number="210"]')
    const detailUrl = `${scoped('/github/prs/210')}?filter=review`
    expect(browser.waitForValue(locationJs, (value) => value === detailUrl)).toBe(detailUrl)
    browser.waitForFunction(`document.querySelector('[data-slot="gh-detail-inner"]') !== null`)
    expect(browser.waitForValue(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    expect(browser.waitForValue(`document.querySelector('[data-slot="gh-back"]')?.getAttribute('href')`)).toBe(listUrl)
    browser.click('[data-slot="gh-back"]')
    expect(browser.waitForValue(locationJs, (value) => value === listUrl)).toBe(listUrl)
    expect(browser.waitForValue(rowNumbersJs, sameJson([203, 210]))).toEqual([203, 210])
  }, 90_000)

  it('leaves the other phone views on their own screens', () => {
    browser.setViewport(PHONE.width, PHONE.height)
    browser.goto(`${base}${scoped('/')}`)
    browser.waitForFunction(`document.querySelector('[data-route="tasks"]') !== null`)
    expect(browser.count(SCREEN)).toBe(0)
    expect(browser.count(SIDEBAR)).toBe(0)
    browser.goto(`${base}/settings/global/appearance`)
    browser.waitForFunction(`document.querySelector('[data-route="settings-global-appearance"]') !== null`)
    expect(browser.count(SCREEN)).toBe(0)
  }, 90_000)
})
