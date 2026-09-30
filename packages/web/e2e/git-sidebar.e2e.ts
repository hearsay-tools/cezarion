import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { focusWithKeyboard } from './contrast'
import { artifactsDir } from './github-fixture'
import { stopFixtureServer } from './fixture-server'
import { waitForHealth } from './poll'

/**
 * #622 (Git slice): the Git view's own sidebar (desktop) and worktree screen (phone), in a real
 * browser against its own fixture server. No server or contract change: the list is `GET /worktrees`
 * joined to the same project's `/runs`.
 *
 * The fixture is built around what a worktree row must NOT claim:
 *   - Membership is the directories on disk. A run whose `worktreePath` points at a directory that
 *     is gone (`wt-stale`) and a run that never had one (`wt-reclaimed`) are not listed, however
 *     recent their records are. A finished-but-retained worktree (`wt-done`, `wt-cancelled`) is.
 *   - A row without a recorded diff (`wt-nodiff`) shows NO diff numbers, never a fake `+0 −0`.
 *   - A row without a branch (`wt-nobranch`) shows an honest fallback, never "null".
 *   - A second registered project owns its own worktree (`b-only`); neither project's rows may
 *     appear under the other, in either direction of a client-side switch.
 */

const PHONE = { width: 360, height: 640 }
const DESKTOP = { width: 1440, height: 900 }

const SIDEBAR = '[data-slot="git-sidebar"]'
const SCREEN = '[data-slot="git-worktree-screen"]'
const LIST = '[data-slot="git-worktree-list"]'
const ROW = '[data-slot="git-worktree-row"]'
const BRANCH = '[data-slot="git-worktree-branch"]'
const META = '[data-slot="git-worktree-meta"]'
const OPEN_REPO = '[data-slot="git-open-repository"]'
const BACK = '[data-slot="git-back-worktrees"]'
const TAB_BAR = '[data-slot="mobile-tab-bar"]'
const REPO_TABS = '[data-slot="repo-tabs"]'
const EMPTY_TEXT = 'No task worktrees on disk'

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const run = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: `Task ${id}`, workflow: 'default', task: id, status: 'done', createdAt: ago(7_200_000), finishedAt: ago(3_600_000),
  tokensUsed: 0, archived: false, steps: [], ...extra,
})

const LONG_TITLE = `An extremely long task title that keeps going well past any sidebar width so it must truncate ${'and truncate '.repeat(12)}`
const LONG_BRANCH = `cez/${'very-long-branch-segment-'.repeat(8)}end`

/** Named rows first, then fillers so the phone screen has to scroll. */
const NAMED = ['wt-review', 'wt-failed', 'wt-done', 'wt-cancelled', 'wt-nodiff', 'wt-nobranch', 'wt-long']
const FILLERS = Array.from({ length: 10 }, (_, index) => `wt-fill-${String(index + 1).padStart(2, '0')}`)
const MEMBERS = [...NAMED, ...FILLERS].sort()
const NON_MEMBERS = ['wt-stale', 'wt-reclaimed']
const B_MEMBERS = ['b-only']

let root: string
let rootB: string
let base: string
let project: string
let projectB: string
let server: ChildProcess
let browser: AgentBrowser
const extraBrowsers: AgentBrowser[] = []

const scoped = (path: string, id = project) => `/p/${id}${path}`

/** The runs the fixture writes for one project; `dir` is where its worktrees live on disk. */
function projectRuns(dir: string, ids: string[]): Record<string, unknown>[] {
  return ids.map((id) => run(id, { worktreePath: join(dir, '.ai/cezar/worktrees', id), branch: `cez/${id}` }))
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cez-git-sidebar-'))
  rootB = mkdtempSync(join(tmpdir(), 'cez-git-sidebar-b-'))
  for (const dir of [root, rootB]) {
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
    git('init', '-q', '-b', 'main')
    git('-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit', '--allow-empty', '-m', 'fixture')
    mkdirSync(join(dir, '.ai/cezar/worktrees'), { recursive: true })
  }
  const worktree = (dir: string, id: string) => join(dir, '.ai/cezar/worktrees', id)
  for (const id of [...MEMBERS]) mkdirSync(worktree(root, id), { recursive: true })
  for (const id of B_MEMBERS) mkdirSync(worktree(rootB, id), { recursive: true })

  const withDir = (id: string, extra: Record<string, unknown>) =>
    run(id, { worktreePath: worktree(root, id), branch: `cez/${id}`, ...extra })
  // Unfinished on purpose: retention reclaims finished worktrees beyond its keep-limit (10) at boot.
  const filler = FILLERS.map((id, index) => withDir(id, { title: `Filler worktree ${index + 1}`, status: 'review', finishedAt: undefined }))
  const noBranch = withDir('wt-nobranch', { title: 'Worktree without a branch' })
  delete (noBranch as { branch?: string }).branch
  writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify([
    withDir('wt-review', { title: 'Review the sidebar', status: 'review', diffStat: { adds: 12, dels: 3, files: 2 } }),
    withDir('wt-failed', { title: 'A failed attempt', status: 'failed', diffStat: { adds: 5, dels: 9, files: 1 } }),
    withDir('wt-done', { title: 'Finished but retained', diffStat: { adds: 40, dels: 7, files: 5 } }),
    withDir('wt-cancelled', { title: 'Cancelled but retained', status: 'cancelled', diffStat: { adds: 2, dels: 0, files: 1 } }),
    withDir('wt-nodiff', { title: 'Worktree without a diff stat' }),
    noBranch,
    withDir('wt-long', { title: LONG_TITLE, branch: LONG_BRANCH, diffStat: { adds: 1234, dels: 56, files: 9 } }),
    ...filler,
    // Recorded worktree that no longer exists on disk, and one whose directory was reclaimed.
    run('wt-stale', { title: 'Stale worktree record', worktreePath: worktree(root, 'wt-stale'), branch: 'cez/wt-stale', diffStat: { adds: 99, dels: 99, files: 9 } }),
    run('wt-reclaimed', { title: 'Reclaimed worktree', branch: 'cez/wt-reclaimed', diffStat: { adds: 98, dels: 98, files: 8 } }),
  ]))
  writeFileSync(join(rootB, '.ai/cezar/runs.json'), JSON.stringify(
    projectRuns(rootB, B_MEMBERS).map((record) => ({ ...record, title: 'B only worktree', diffStat: { adds: 7, dels: 1, files: 1 } })),
  ))

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
  const registered = await fetch(`${base}/api/v1/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: rootB }),
  })
  if (!registered.ok) throw new Error(`cezar e2e: registering the second fixture project answered ${registered.status}`)
  const listed = (await fetch(`${base}/api/v1/projects`).then((response) => response.json())) as { projects: Array<{ id: string; root: string }> }
  const entry = listed.projects.find((candidate) => realpathSync(candidate.root) === realpathSync(rootB))
  if (!entry) throw new Error('cezar e2e: the second fixture project is not in the registry')
  projectB = entry.id
  mkdirSync(artifactsDir, { recursive: true })
  browser = AgentBrowser.open(`git-sidebar-${process.pid}`)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
}, 60_000)

afterAll(async () => {
  browser?.close()
  for (const extra of extraBrowsers) extra.close()
  await stopFixtureServer(server)
  for (const dir of [root, rootB]) if (dir) rmSync(dir, { recursive: true, force: true })
})

function session(name: string, viewport = DESKTOP): AgentBrowser {
  const target = AgentBrowser.open(`git-sidebar-${name}-${process.pid}`)
  extraBrowsers.push(target)
  target.setViewport(viewport.width, viewport.height)
  return target
}

const canonical = (value: unknown): string => JSON.stringify(value)
const sameJson = (expected: unknown) => (value: unknown) => canonical(value) === canonical(expected)
const locationJs = `location.pathname + location.search`

/** The run ids of the rows inside `container`, sorted (row order is the list's own business). */
const idsJs = (container: string) => `(() => {
  const box = document.querySelector(${JSON.stringify(container)});
  if (!box) return null;
  return [...box.querySelectorAll(${JSON.stringify(ROW)})].map((row) => row.getAttribute('data-run-id')).sort();
})()`

/** Everything a row shows or links, keyed by run id. Null while the list is not on screen. */
const factsJs = (container: string) => `(() => {
  const box = document.querySelector(${JSON.stringify(container)});
  if (!box) return null;
  const out = {};
  for (const row of box.querySelectorAll(${JSON.stringify(ROW)})) {
    const anchor = row.matches('a') ? row : row.querySelector('a');
    const dot = row.querySelector('[data-slot="status-dot"]');
    const stat = row.querySelector('[data-slot="diff-stat"]');
    out[row.getAttribute('data-run-id')] = {
      href: anchor ? anchor.getAttribute('href') : null,
      branch: row.querySelector(${JSON.stringify(BRANCH)})?.textContent.trim() ?? null,
      meta: row.querySelector(${JSON.stringify(META)})?.textContent.trim() ?? null,
      tone: dot ? dot.getAttribute('data-tone') : null,
      diff: stat ? stat.textContent.replace(/\\s+/g, ' ').trim() : null,
    };
  }
  return out;
})()`

/** Rows come from `/worktrees`; diff and attention arrive with the scoped `/runs`. A sample is only
 *  trustworthy once the join has landed, so these gate on the enriched fields of known rows and the
 *  caller asserts on that SAME sample (a null count then neither false-passes nor flakes). */
const enriched = (value: Record<string, RowFacts> | null): boolean =>
  Boolean(value && Object.keys(value).length === MEMBERS.length
    && value['wt-review']?.diff === '+12 −3' && value['wt-review']?.tone === 'info'
    && value['wt-failed']?.diff === '+5 −9' && value['wt-failed']?.tone === 'danger'
    && value['wt-cancelled']?.diff === '+2 −0' && value['wt-done']?.diff === '+40 −7' && value['wt-long']?.diff !== null)
type RowFacts = { href: string | null; branch: string | null; meta: string | null; tone: string | null; diff: string | null }
const has = (container: string) => `document.querySelector(${JSON.stringify(container)}) !== null`
const rowsReady = (container: string, count: number) =>
  `document.querySelectorAll(${JSON.stringify(`${container} ${ROW}`)}).length === ${count}`

const openDesktop = (path = '/git', id = project) => {
  browser.setViewport(DESKTOP.width, DESKTOP.height)
  browser.goto(`${base}${scoped(path, id)}`)
  // Only Git views carry the Git sidebar; anywhere else the caller waits for what it needs.
  if (path.startsWith('/git')) browser.waitForFunction(has(SIDEBAR))
}
const openPhone = (path = '/git', target = browser) => {
  target.setViewport(PHONE.width, PHONE.height)
  target.goto(`${base}${scoped(path)}`)
}
/** The completed desktop layout: the repository header, its tabs and the Changes body are mounted
 *  (not the Suspense fallback), so a representative screenshot shows the finished page. */
const repositorySettled = `document.querySelector('[data-slot="repo-header"]') !== null && document.querySelector('[data-slot="repo-tabs"]') !== null && document.querySelector('[data-slot="repo-changes"]') !== null`
const setTheme = (target: AgentBrowser, theme: 'light' | 'dark') =>
  target.evaluate(`document.documentElement.classList.remove('light', 'dark'); document.documentElement.classList.add('${theme}')`)

describe('the fixture', () => {
  it('has the worktrees this spec assumes: the API lists exactly the directories on disk', async () => {
    const listing = async (id: string) => {
      const response = (await fetch(`${base}/api/v1/p/${id}/worktrees`).then((r) => r.json())) as { worktrees: Array<{ runId: string }> }
      return response.worktrees.map((entry) => entry.runId).sort()
    }
    expect(await listing(project)).toEqual(MEMBERS)
    expect(await listing(projectB)).toEqual(B_MEMBERS)
    for (const id of NON_MEMBERS) expect(MEMBERS).not.toContain(id)
  })
})

describe('Git desktop sidebar (#622)', () => {
  it('lists the worktrees on disk under a Task worktrees group, not the task quick list', () => {
    openDesktop()
    expect(browser.waitForValue(idsJs(SIDEBAR), sameJson(MEMBERS))).toEqual(MEMBERS)
    expect(browser.count(`${SIDEBAR} ${LIST}`)).toBe(1)
    const text = String(browser.evaluate(`document.querySelector(${JSON.stringify(SIDEBAR)}).textContent`))
    expect(text).toContain('Task worktrees')
    // Stale and reclaimed metadata is never a row, whatever the run history says.
    for (const id of NON_MEMBERS) expect(browser.count(`${SIDEBAR} ${ROW}[data-run-id="${id}"]`)).toBe(0)
    expect(text).not.toContain('Stale worktree record')
    expect(text).not.toContain('Reclaimed worktree')
    expect(browser.count('[data-slot="task-quick-list"]')).toBe(0)
    expect(browser.count(SCREEN)).toBe(0)
    // The main repository facets appear once, in the main header, and not in the sidebar.
    browser.waitForFunction(has(REPO_TABS))
    expect(browser.count(REPO_TABS)).toBe(1)
    expect(browser.count(`${REPO_TABS} a`)).toBe(3)
    expect(browser.count(`${SIDEBAR} ${REPO_TABS}`)).toBe(0)
    expect(browser.count(`${SIDEBAR} a[href$="/git/commits"], ${SIDEBAR} a[href$="/git/branches"]`)).toBe(0)
    expect(browser.count('[data-slot="repo-header"]')).toBe(1)
  }, 90_000)

  it('each row links to its scoped task Changes tab and carries branch, title, status and diff', () => {
    openDesktop()
    const facts = browser.waitForValue<Record<string, RowFacts>>(factsJs(SIDEBAR), enriched)
    for (const id of MEMBERS) {
      expect(facts[id]?.href, `${id} links`).toBe(scoped(`/tasks/${id}/changes`))
    }
    expect(facts['wt-review']).toMatchObject({ branch: 'cez/wt-review', tone: 'info', diff: '+12 −3' })
    expect(facts['wt-review']?.meta).toContain('Review the sidebar')
    expect(facts['wt-failed']).toMatchObject({ branch: 'cez/wt-failed', tone: 'danger', diff: '+5 −9' })
    expect(facts['wt-cancelled']).toMatchObject({ tone: 'neutral', diff: '+2 −0' })
    // Finished but retained is still on disk, so it is still a row, with its outcome dot.
    expect(facts['wt-done']).toMatchObject({ branch: 'cez/wt-done', diff: '+40 −7' })
    expect(['success', 'accent']).toContain(facts['wt-done']?.tone)
    expect(facts['wt-done']?.meta).toContain('Finished but retained')
    // DiffStatLabel is compact in a row: 1,234 reads "1k" (exact counts stay in its title).
    expect(facts['wt-long']?.diff).toBe('+1k −56')
    browser.waitForFunction(repositorySettled)
    browser.screenshot(`${artifactsDir}/git-sidebar-desktop-light.png`, { viewport: true })
  }, 90_000)

  it('a missing diff stat is unknown, not +0 −0; a missing branch has an honest fallback', () => {
    openDesktop()
    const facts = browser.waitForValue<Record<string, RowFacts>>(factsJs(SIDEBAR), enriched)
    expect(facts['wt-nodiff']?.diff).toBeNull()
    expect(browser.count(`${SIDEBAR} ${ROW}[data-run-id="wt-nodiff"] [data-slot="diff-stat"]`)).toBe(0)
    expect(String(browser.evaluate(`document.querySelector('${SIDEBAR} ${ROW}[data-run-id="wt-nodiff"]').textContent`))).not.toMatch(/\+0|−0/)
    const branch = facts['wt-nobranch']?.branch ?? ''
    expect(branch).not.toBe('')
    expect(branch).not.toMatch(/null|undefined/i)
    expect(facts['wt-nobranch']?.meta).toContain('Worktree without a branch')
  }, 90_000)

  it('paints 48px two-line rows with a 12px mono branch in light and dark, truncating long text', () => {
    for (const theme of ['light', 'dark'] as const) {
      openDesktop()
      setTheme(browser, theme)
      browser.waitForFunction(rowsReady(SIDEBAR, MEMBERS.length))
      const facts = browser.waitForValue<Record<string, unknown>>(`(() => {
        const sidebar = document.querySelector(${JSON.stringify(SIDEBAR)});
        const rows = [...sidebar.querySelectorAll(${JSON.stringify(ROW)})];
        const branch = rows[0]?.querySelector(${JSON.stringify(BRANCH)});
        const long = sidebar.querySelector('${ROW}[data-run-id="wt-long"]');
        if (!branch || !long) return null;
        const sidebarRect = sidebar.getBoundingClientRect();
        const longRect = long.getBoundingClientRect();
        const meta = long.querySelector(${JSON.stringify(META)}).getBoundingClientRect();
        const longBranch = long.querySelector(${JSON.stringify(BRANCH)}).getBoundingClientRect();
        return {
          light: document.documentElement.classList.contains('light'),
          heights: [...new Set(rows.map((row) => Math.round(row.getBoundingClientRect().height)))],
          branchSize: getComputedStyle(branch).fontSize,
          branchMono: /mono|menlo|consolas|courier/i.test(getComputedStyle(branch).fontFamily),
          longClipped: longRect.right <= sidebarRect.right + 1 && meta.right <= longRect.right + 1 && longBranch.right <= longRect.right + 1,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      })()`)
      // The sidebar lays two-line rows at 49px (the board's 6 + 19 + 1 + 17 + 6) whatever they hold: titles and branches truncate, never wrap.
      expect(facts).toEqual({ light: theme === 'light', heights: [49], branchSize: '12px', branchMono: true, longClipped: true, overflow: false })
      browser.waitForFunction(repositorySettled)
      browser.screenshot(`${artifactsDir}/git-sidebar-desktop-${theme}.png`, { viewport: true })
    }
  }, 90_000)

  it('Changes, Commits and Branches in the main header stay main-repository views and the sidebar stays put', () => {
    openDesktop()
    browser.waitForFunction(rowsReady(SIDEBAR, MEMBERS.length))
    for (const [tab, path] of [['Commits', '/git/commits'], ['Branches', '/git/branches']] as const) {
      browser.click(`${REPO_TABS} a[href="${scoped(path)}"]`)
      expect(browser.waitForValue(locationJs, (value) => value === scoped(path))).toBe(scoped(path))
      expect(browser.waitForValue(idsJs(SIDEBAR), sameJson(MEMBERS)), `${tab} keeps the sidebar`).toEqual(MEMBERS)
      expect(browser.count(REPO_TABS)).toBe(1)
    }
    // A commit deep link keeps the sidebar too.
    const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    browser.goto(`${base}${scoped(`/git/commits/${sha}`)}`)
    browser.waitForFunction(has(SIDEBAR))
    expect(browser.waitForValue(idsJs(SIDEBAR), sameJson(MEMBERS))).toEqual(MEMBERS)
  }, 90_000)

  it('the sidebar lists Changes, Commits and Branches above the worktrees and lights the open one', () => {
    openDesktop()
    const FACET = `${SIDEBAR} [data-slot="git-repo-nav"] a[data-git-facet]`
    expect(browser.waitForValue(`[...document.querySelectorAll(${JSON.stringify(FACET)})].map((a) => a.textContent.replace(/\\d+$/, ''))`,
      (value) => JSON.stringify(value) === JSON.stringify(['Changes', 'Commits', 'Branches']))).toEqual(['Changes', 'Commits', 'Branches'])
    const current = `document.querySelector(${JSON.stringify(`${FACET}[aria-current="page"]`)})?.dataset.gitFacet ?? null`
    expect(browser.waitForValue(current, (value) => value === 'changes')).toBe('changes')
    for (const [facet, path] of [['commits', '/git/commits'], ['branches', '/git/branches']] as const) {
      browser.click(`${FACET}[data-git-facet="${facet}"]`)
      expect(browser.waitForValue(locationJs, (value) => value === scoped(path))).toBe(scoped(path))
      expect(browser.waitForValue(current, (value) => value === facet)).toBe(facet)
      // The facet's route is lazy: its header mounts after the URL changes (first run failed a one-shot count here).
      expect(browser.waitForValue(`document.querySelectorAll(${JSON.stringify(REPO_TABS)}).length`, (value) => value === 1)).toBe(1)
    }
  }, 90_000)

  it('/git?view=repo is harmless on desktop: still the repository Changes with the sidebar', () => {
    openDesktop('/git?view=repo')
    browser.waitForFunction(has('[data-slot="repo-header"]'))
    expect(browser.waitForValue(idsJs(SIDEBAR), sameJson(MEMBERS))).toEqual(MEMBERS)
    expect(browser.count(SCREEN)).toBe(0)
    // The Back link is a phone affordance: present in the DOM at most, never on screen at desktop.
    expect(browser.evaluate(`document.querySelector('${BACK}')?.checkVisibility() ?? false`)).toBe(false)
    expect(browser.count(REPO_TABS)).toBe(1)
  }, 90_000)

  it('is keyboard operable: Tab reaches a row with a visible focus ring and Enter opens its Changes tab', () => {
    openDesktop()
    browser.waitForFunction(rowsReady(SIDEBAR, MEMBERS.length))
    const target = `${SIDEBAR} ${ROW}[data-run-id="wt-done"]`
    focusWithKeyboard(browser, target)
    const ring = browser.waitForValue<Record<string, unknown>>(`(() => {
      const el = document.activeElement;
      const row = el?.closest(${JSON.stringify(ROW)});
      if (!el || row?.getAttribute('data-run-id') !== 'wt-done') return null;
      const style = getComputedStyle(el);
      return { focusVisible: el.matches(':focus-visible'), ring: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 || style.boxShadow !== 'none' };
    })()`)
    expect(ring).toEqual({ focusVisible: true, ring: true })
    browser.press('Enter')
    const url = scoped('/tasks/wt-done/changes')
    expect(browser.waitForValue(locationJs, (value) => value === url)).toBe(url)
  }, 90_000)

  it('reflects the disk: a worktree removed from disk leaves the list after a reload', () => {
    // A private stale-able worktree so no other test's membership moves.
    const doomed = join(root, '.ai/cezar/worktrees', 'wt-fill-10')
    openDesktop()
    browser.waitForFunction(rowsReady(SIDEBAR, MEMBERS.length))
    rmSync(doomed, { recursive: true, force: true })
    try {
      browser.goto(`${base}${scoped('/git')}`)
      browser.waitForFunction(rowsReady(SIDEBAR, MEMBERS.length - 1))
      expect(browser.count(`${SIDEBAR} ${ROW}[data-run-id="wt-fill-10"]`)).toBe(0)
    } finally {
      mkdirSync(doomed, { recursive: true })
    }
    browser.goto(`${base}${scoped('/git')}`)
    browser.waitForFunction(rowsReady(SIDEBAR, MEMBERS.length))
  }, 90_000)
})

describe('Git sidebar states and project scoping (#622)', () => {
  it('shows an explicit empty state, not a blank group', () => {
    const empty = session('empty')
    empty.routeJson('**/worktrees', { worktrees: [], totalBytes: 0, keep: 0 })
    empty.goto(`${base}${scoped('/git')}`)
    empty.waitForFunction(has(SIDEBAR))
    expect(empty.waitForValue(`document.querySelector(${JSON.stringify(SIDEBAR)}).textContent.includes(${JSON.stringify(EMPTY_TEXT)}) ? true : null`)).toBe(true)
    expect(empty.count(`${SIDEBAR} ${ROW}`)).toBe(0)
    empty.screenshot(`${artifactsDir}/git-sidebar-empty.png`, { viewport: true })
  }, 90_000)

  /** Serve `/worktrees` through an in-page fetch stub installed BEFORE the Git view first asks
   *  (a client-side navigation), so loading and failure are deterministic. */
  const stubbed = (target: AgentBrowser, stub: string) => {
    target.goto(`${base}${scoped('/')}`)
    target.waitForFunction(`document.querySelector('a[href="${scoped('/git')}"]') !== null`)
    target.evaluate(`(() => {
      const nativeFetch = window.fetch;
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        if (new URL(url, location.href).pathname.endsWith('/worktrees')) {
          ${stub}
        }
        return nativeFetch(input, init);
      };
      document.querySelector('a[href="${scoped('/git')}"]').click();
    })()`)
    target.waitForFunction(has(SIDEBAR))
  }

  it('shows a loading state while the list is pending, then the rows', () => {
    const slow = session('loading')
    stubbed(slow, `return new Promise((resolve) => { window.__release = () => resolve(nativeFetch(input, init)); });`)
    expect(slow.waitForValue(`/loading/i.test(document.querySelector(${JSON.stringify(SIDEBAR)}).textContent) ? true : null`)).toBe(true)
    expect(slow.count(`${SIDEBAR} ${ROW}`)).toBe(0)
    expect(String(slow.evaluate(`document.querySelector(${JSON.stringify(SIDEBAR)}).textContent`))).not.toContain(EMPTY_TEXT)
    slow.screenshot(`${artifactsDir}/git-sidebar-loading.png`, { viewport: true })
    slow.evaluate(`window.__release()`)
    expect(slow.waitForValue(idsJs(SIDEBAR), sameJson(MEMBERS))).toEqual(MEMBERS)
  }, 90_000)

  it('shows a meaningful error, never the empty state, when the list request fails', () => {
    const broken = session('error')
    stubbed(broken, `return Promise.resolve(new Response('boom', { status: 500, statusText: 'Server Error' }));`)
    const text = broken.waitForValue<string>(`(() => {
      const box = document.querySelector(${JSON.stringify(SIDEBAR)});
      const t = box ? box.textContent : '';
      return /couldn.?t|could not|failed|unable|error|try again/i.test(t) ? t : null;
    })()`)
    expect(text).not.toContain(EMPTY_TEXT)
    expect(broken.count(`${SIDEBAR} ${ROW}`)).toBe(0)
    broken.screenshot(`${artifactsDir}/git-sidebar-error.png`, { viewport: true })
  }, 90_000)

  it('never bleeds one project’s worktrees into another through a client-side switch', () => {
    openDesktop('/')
    const nav = '[data-slot="sidebar"] nav[aria-label="Main"]'
    const rail = (id: string) => `[data-slot="rail-project"][data-project-id="${id}"] a`
    browser.waitForFunction(has(rail(projectB)))
    browser.click(`${nav} a[href="${scoped('/git')}"]`)
    expect(browser.waitForValue(idsJs(SIDEBAR), sameJson(MEMBERS))).toEqual(MEMBERS)

    browser.click(rail(projectB))
    browser.waitForFunction(`location.pathname === ${JSON.stringify(scoped('/', projectB))}`)
    browser.click(`${nav} a[href="${scoped('/git', projectB)}"]`)
    expect(browser.waitForValue(idsJs(SIDEBAR), sameJson(B_MEMBERS))).toEqual(B_MEMBERS)
    const facts = browser.waitForValue<Record<string, RowFacts>>(factsJs(SIDEBAR), (value) => value?.['b-only']?.diff === '+7 −1')
    expect(facts['b-only']).toMatchObject({ href: scoped('/tasks/b-only/changes', projectB), diff: '+7 −1' })
    expect(facts['b-only']?.meta).toContain('B only worktree')

    browser.click(rail(project))
    browser.waitForFunction(`location.pathname === ${JSON.stringify(scoped('/'))}`)
    browser.click(`${nav} a[href="${scoped('/git')}"]`)
    expect(browser.waitForValue(idsJs(SIDEBAR), sameJson(MEMBERS))).toEqual(MEMBERS)
    // And a cold load of the other project's URL.
    browser.goto(`${base}${scoped('/git', projectB)}`)
    expect(browser.waitForValue(idsJs(SIDEBAR), sameJson(B_MEMBERS))).toEqual(B_MEMBERS)
  }, 90_000)
})

describe('Git rows without the runs join (#622)', () => {
  it('lists the disk with no invented diff when /runs knows nothing, and enriches once it answers', () => {
    // A held /runs cannot be staged: the shell's own task list has already cached it by the time the
    // Git view mounts. An empty answer is the deterministic stand-in for "the join has nothing yet".
    const bare = session('runs-empty')
    bare.routeJson('**/runs', [])
    bare.goto(`${base}${scoped('/git')}`)
    bare.waitForFunction(has(SIDEBAR))
    expect(bare.waitForValue(idsJs(SIDEBAR), sameJson(MEMBERS))).toEqual(MEMBERS)
    const before = bare.waitForValue<Record<string, RowFacts>>(factsJs(SIDEBAR), (value) => Boolean(value && Object.keys(value).length === MEMBERS.length))
    // Membership is /worktrees' alone; nothing about a diff is claimed for rows the join cannot describe.
    expect(Object.values(before).filter((row) => row.diff !== null)).toEqual([])
    expect(String(bare.evaluate(`document.querySelector(${JSON.stringify(SIDEBAR)}).textContent`))).not.toMatch(/\+\d|−\d/)
    bare.screenshot(`${artifactsDir}/git-sidebar-runs-empty.png`, { viewport: true })
    bare.unroute('**/runs')
    bare.goto(`${base}${scoped('/git')}`)
    const after = bare.waitForValue<Record<string, RowFacts>>(factsJs(SIDEBAR), enriched)
    expect(after['wt-review']).toMatchObject({ diff: '+12 −3', tone: 'info' })
  }, 90_000)
})

describe('Git view regressions found in review (#622)', () => {
  it('A -> B -> A refetches membership that changed while away, without a reload', () => {
    const doomed = join(root, '.ai/cezar/worktrees', 'wt-fill-09')
    const nav = '[data-slot="sidebar"] nav[aria-label="Main"]'
    const rail = (id: string) => `[data-slot="rail-project"][data-project-id="${id}"] a`
    openDesktop('/')
    browser.waitForFunction(has(rail(projectB)))
    browser.click(`${nav} a[href="${scoped('/git')}"]`)
    expect(browser.waitForValue(idsJs(SIDEBAR), sameJson(MEMBERS))).toEqual(MEMBERS)
    browser.click(rail(projectB))
    browser.waitForFunction(`location.pathname === ${JSON.stringify(scoped('/', projectB))}`)
    browser.click(`${nav} a[href="${scoped('/git', projectB)}"]`)
    expect(browser.waitForValue(idsJs(SIDEBAR), sameJson(B_MEMBERS))).toEqual(B_MEMBERS)
    rmSync(doomed, { recursive: true, force: true })
    try {
      browser.click(rail(project))
      browser.waitForFunction(`location.pathname === ${JSON.stringify(scoped('/'))}`)
      browser.click(`${nav} a[href="${scoped('/git')}"]`)
      const remaining = MEMBERS.filter((id) => id !== 'wt-fill-09')
      expect(browser.waitForValue(idsJs(SIDEBAR), sameJson(remaining))).toEqual(remaining)
    } finally {
      mkdirSync(doomed, { recursive: true })
    }
  }, 90_000)

  /** Install a fetch stub for one API path, then push the repository view CLIENT-side from the phone
   *  screen so the stub is in place before the repository first asks. */
  const repoViewWith = (target: AgentBrowser, stub: string) => {
    // Installed on a non-Git route BEFORE the first Git navigation, so no cached or in-flight
    // `/repo` answer can predate it; the Git tab and Open repository are then client-side pushes.
    target.setViewport(PHONE.width, PHONE.height)
    target.goto(`${base}${scoped('/')}`)
    target.waitForFunction(has(`${TAB_BAR} a[data-tab="/git"]`))
    target.evaluate(`(() => {
      const nativeFetch = window.fetch;
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        if (new URL(url, location.href).pathname.endsWith('/repo')) { ${stub} }
        return nativeFetch(input, init);
      };
    })()`)
    target.click(`${TAB_BAR} a[data-tab="/git"]`)
    target.waitForFunction(has(SCREEN))
    target.click(OPEN_REPO)
  }

  it('the phone keeps Back to worktrees while the repository is loading', () => {
    const slow = session('repo-loading', PHONE)
    repoViewWith(slow, `return new Promise(() => {});`)
    slow.waitForFunction(`location.search === '?view=repo'`)
    // The exact loading surface, not just a Back link that a finished view would also have.
    slow.waitForFunction(`document.body.textContent.includes('Loading repository')`)
    slow.waitForFunction(has(BACK))
    expect(slow.count(REPO_TABS)).toBe(0)
    expect(slow.evaluate(`document.querySelector('${BACK}').getAttribute('href')`)).toBe(scoped('/git'))
    slow.screenshot(`${artifactsDir}/git-repository-phone-loading.png`, { viewport: true })
    slow.click(BACK)
    slow.waitForFunction(has(SCREEN))
  }, 90_000)

  it('the phone keeps Back to worktrees when the repository request fails', () => {
    const broken = session('repo-error', PHONE)
    repoViewWith(broken, `return Promise.resolve(new Response('boom', { status: 500, statusText: 'Server Error' }));`)
    broken.waitForFunction(`location.search === '?view=repo'`)
    broken.waitForFunction(`document.body.textContent.includes('Could not load the repository')`)
    broken.waitForFunction(has(BACK))
    expect(broken.count(REPO_TABS)).toBe(0)
    expect(broken.count(SCREEN)).toBe(0)
    broken.screenshot(`${artifactsDir}/git-repository-phone-error.png`, { viewport: true })
    broken.click(BACK)
    broken.waitForFunction(has(SCREEN))
  }, 90_000)

  /** Scroll the repository view down, leave it by `leave`, and expect the worktree screen at the top. */
  const leavesAtTop = (leave: (target: AgentBrowser) => void) => {
    const target = session(`scroll-${Math.random().toString(36).slice(2, 7)}`, PHONE)
    openPhone('/git', target)
    target.waitForFunction(has(SCREEN))
    target.click(OPEN_REPO)
    target.waitForFunction(has(BACK))
    const scrolled = target.waitForValue<number>(`(() => {
      const main = document.querySelector('[data-slot="main"]');
      if (!main) return null;
      main.scrollTop = main.scrollHeight;
      return main.scrollTop;
    })()`, (value) => typeof value === 'number' && value > 0)
    expect(scrolled).toBeGreaterThan(0)
    leave(target)
    target.waitForFunction(has(SCREEN))
    const facts = target.waitForValue<Record<string, unknown>>(`(() => {
      const main = document.querySelector('[data-slot="main"]');
      const open = document.querySelector('${OPEN_REPO}');
      if (!main || !open) return null;
      const rect = open.getBoundingClientRect();
      return { top: main.scrollTop, openVisible: rect.top >= 0 && rect.bottom <= innerHeight };
    })()`, (value) => Boolean(value && value.top === 0))
    expect(facts).toEqual({ top: 0, openVisible: true })
  }

  it('a scrolled repository view returns to the top of the worktree screen via the Back link', () => {
    leavesAtTop((target) => target.click(BACK))
  }, 90_000)

  it('a scrolled repository view returns to the top of the worktree screen via browser Back', () => {
    leavesAtTop((target) => { target.evaluate(`history.back()`) })
  }, 90_000)

  it('a scrolled repository view returns to the top of the worktree screen via the Git tab', () => {
    leavesAtTop((target) => target.click(`${TAB_BAR} a[data-tab="/git"]`))
  }, 90_000)
})

describe('Git phone worktree screen at 360x640 (#622)', () => {
  const openScreen = () => {
    openPhone('/git')
    browser.waitForFunction(has(SCREEN))
  }

  it('bare /git is the worktree screen: rows for the disk, no duplicate repository facets', () => {
    openScreen()
    expect(browser.waitForValue(idsJs(SCREEN), sameJson(MEMBERS))).toEqual(MEMBERS)
    expect(browser.count(`${SCREEN} ${LIST}`)).toBe(1)
    for (const id of NON_MEMBERS) expect(browser.count(`${SCREEN} ${ROW}[data-run-id="${id}"]`)).toBe(0)
    // Own screen: no Changes / Commits / Branches facets, no repository header, no sidebar.
    expect(browser.count(REPO_TABS)).toBe(0)
    expect(browser.count('[data-slot="repo-header"]')).toBe(0)
    expect(browser.count(`${SCREEN} a[href$="/git/commits"], ${SCREEN} a[href$="/git/branches"]`)).toBe(0)
    expect(browser.evaluate(`document.querySelector(${JSON.stringify(SIDEBAR)})?.checkVisibility() ?? false`)).toBe(false)
    expect(browser.count(BACK)).toBe(0)
    expect(browser.count(`${SCREEN} ${OPEN_REPO}`)).toBe(1)
    expect(browser.evaluate(`document.querySelector('${OPEN_REPO}').getAttribute('href')`)).toBe(`${scoped('/git')}?view=repo`)
    // The tab bar is the phone's main navigation; the Git tab is the lit one.
    expect(browser.waitForValue(`document.querySelector('${TAB_BAR} a[data-tab="/git"]')?.getAttribute('aria-current')`)).toBe('page')
  }, 90_000)

  it('is reached from the Git tab, and carries the same row facts as the desktop sidebar', () => {
    browser.setViewport(PHONE.width, PHONE.height)
    browser.goto(`${base}${scoped('/')}`)
    browser.waitForFunction(has(`${TAB_BAR} a[data-tab="/git"]`))
    browser.click(`${TAB_BAR} a[data-tab="/git"]`)
    browser.waitForFunction(`location.pathname === ${JSON.stringify(scoped('/git'))} && document.querySelector(${JSON.stringify(SCREEN)}) !== null`)
    expect(browser.waitForValue(`location.search`, (value) => value === '')).toBe('')
    const facts = browser.waitForValue<Record<string, RowFacts>>(factsJs(SCREEN), enriched)
    for (const id of MEMBERS) expect(facts[id]?.href, `${id} links`).toBe(scoped(`/tasks/${id}/changes`))
    expect(facts['wt-review']).toMatchObject({ branch: 'cez/wt-review', tone: 'info', diff: '+12 −3' })
    expect(facts['wt-failed']).toMatchObject({ tone: 'danger', diff: '+5 −9' })
    expect(facts['wt-nodiff']?.diff).toBeNull()
    expect(facts['wt-nobranch']?.branch).not.toMatch(/null|undefined|^$/i)
  }, 90_000)

  it('paints 56px rows with the branch in mono, without overflow, in light and dark', () => {
    for (const theme of ['light', 'dark'] as const) {
      openScreen()
      setTheme(browser, theme)
      browser.waitForFunction(rowsReady(SCREEN, MEMBERS.length))
      const facts = browser.waitForValue<Record<string, unknown>>(`(() => {
        const rows = [...document.querySelectorAll('${SCREEN} ${ROW}')];
        const branch = rows[0]?.querySelector(${JSON.stringify(BRANCH)});
        const long = document.querySelector('${SCREEN} ${ROW}[data-run-id="wt-long"]');
        if (!branch || !long) return null;
        const screen = document.querySelector(${JSON.stringify(SCREEN)}).getBoundingClientRect();
        return {
          light: document.documentElement.classList.contains('light'),
          heights: [...new Set(rows.map((row) => Math.round(row.getBoundingClientRect().height)))],
          branchSize: getComputedStyle(branch).fontSize,
          branchMono: /mono|menlo|consolas|courier/i.test(getComputedStyle(branch).fontFamily),
          longClipped: long.getBoundingClientRect().right <= screen.right + 1,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      })()`)
      expect(facts).toEqual({ light: theme === 'light', heights: [56], branchSize: '12px', branchMono: true, longClipped: true, overflow: false })
      browser.screenshot(`${artifactsDir}/git-worktree-screen-${theme}.png`, { viewport: true })
    }
  }, 90_000)

  it('keeps every row, the Open repository link and the Back link at 44px or more', () => {
    openScreen()
    browser.waitForFunction(rowsReady(SCREEN, MEMBERS.length))
    const small = (selector: string) => browser.evaluate(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      if (nodes.length === 0) return null;
      return nodes.map((node) => { const r = node.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })
        .filter((box) => box.w < 44 || box.h < 44);
    })()`)
    expect(small(`${SCREEN} ${ROW}`)).toEqual([])
    expect(small(OPEN_REPO)).toEqual([])
    browser.click(OPEN_REPO)
    browser.waitForFunction(has(BACK))
    expect(small(BACK)).toEqual([])
  }, 90_000)

  it('Open repository pushes the repository Changes with a Back link; Back returns to the screen', () => {
    openScreen()
    browser.click(OPEN_REPO)
    const repoUrl = `${scoped('/git')}?view=repo`
    expect(browser.waitForValue(locationJs, (value) => value === repoUrl)).toBe(repoUrl)
    browser.waitForFunction(has('[data-slot="repo-header"]'))
    expect(browser.count(SCREEN)).toBe(0)
    expect(browser.count(REPO_TABS)).toBe(1)
    expect(browser.count(`${REPO_TABS} a`)).toBe(3)
    expect(browser.count(BACK)).toBe(1)
    expect(String(browser.evaluate(`document.querySelector('${BACK}').textContent + ' ' + (document.querySelector('${BACK}').getAttribute('aria-label') ?? '')`))).toMatch(/worktrees/i)
    expect(browser.evaluate(`document.querySelector('${BACK}').getAttribute('href')`)).toBe(scoped('/git'))
    // The Changes segment keeps the repository view, so it does not bounce to the screen.
    expect(browser.evaluate(`document.querySelector('${REPO_TABS} a[aria-current="page"]').getAttribute('href')`)).toBe(repoUrl)
    browser.screenshot(`${artifactsDir}/git-repository-phone.png`, { viewport: true })

    browser.click(BACK)
    browser.waitForFunction(has(SCREEN))
    expect(browser.waitForValue(locationJs, (value) => value === scoped('/git'))).toBe(scoped('/git'))
    expect(browser.count(REPO_TABS)).toBe(0)
  }, 90_000)

  it('Commits, Branches and back to Changes stay in the repository view and never bounce to the screen', () => {
    openPhone('/git?view=repo')
    browser.waitForFunction(has(REPO_TABS))
    browser.click(`${REPO_TABS} a[href="${scoped('/git/commits')}"]`)
    browser.waitForFunction(`location.pathname === ${JSON.stringify(scoped('/git/commits'))} && document.querySelector('[data-slot="repo-commits"]') !== null`)
    expect(browser.count(SCREEN)).toBe(0)
    browser.click(`${REPO_TABS} a[href="${scoped('/git/branches')}"]`)
    browser.waitForFunction(`location.pathname === ${JSON.stringify(scoped('/git/branches'))} && document.querySelector('[data-slot="repo-branch-list"]') !== null`)
    expect(browser.count(SCREEN)).toBe(0)
    browser.click(`${REPO_TABS} a[href="${scoped('/git')}?view=repo"]`)
    const repoUrl = `${scoped('/git')}?view=repo`
    expect(browser.waitForValue(locationJs, (value) => value === repoUrl)).toBe(repoUrl)
    browser.waitForFunction(has('[data-slot="repo-changes"]'))
    expect(browser.count(SCREEN)).toBe(0)
  }, 90_000)

  it('deep links and reloads land where they say: commits, branches, ?view=repo and the bare screen', () => {
    for (const path of ['/git/commits', '/git/branches']) {
      openPhone(path)
      browser.waitForFunction(has(REPO_TABS))
      expect(browser.count(SCREEN)).toBe(0)
      expect(browser.waitForValue(locationJs)).toBe(scoped(path))
    }
    openPhone('/git?view=repo')
    browser.waitForFunction(has('[data-slot="repo-changes"]'))
    browser.goto(`${base}${scoped('/git')}?view=repo`)
    browser.waitForFunction(has('[data-slot="repo-changes"]'))
    expect(browser.count(SCREEN)).toBe(0)
    expect(browser.count(BACK)).toBe(1)
    openScreen()
    browser.goto(`${base}${scoped('/git')}`)
    browser.waitForFunction(has(SCREEN))
    expect(browser.count(REPO_TABS)).toBe(0)
  }, 90_000)

  it('a row opens the task Changes tab, and Back from the task returns to the worktree screen', () => {
    openScreen()
    browser.waitForFunction(rowsReady(SCREEN, MEMBERS.length))
    browser.click(`${SCREEN} ${ROW}[data-run-id="wt-review"]`)
    const url = scoped('/tasks/wt-review/changes')
    expect(browser.waitForValue(locationJs, (value) => value === url)).toBe(url)
    browser.waitForFunction(`document.querySelector('[data-route="task-changes"]') !== null`)
    browser.evaluate(`history.back()`)
    browser.waitForFunction(has(SCREEN))
    expect(browser.waitForValue(locationJs, (value) => value === scoped('/git'))).toBe(scoped('/git'))
  }, 90_000)

  it('survives a resize: desktop docks the sidebar over repository Changes, phone brings the screen back', () => {
    openScreen()
    browser.setViewport(DESKTOP.width, DESKTOP.height)
    browser.waitForFunction(`${has(SIDEBAR)} && document.querySelector(${JSON.stringify(SCREEN)}) === null && document.querySelector('[data-slot="repo-header"]') !== null`)
    expect(browser.waitForValue(idsJs(SIDEBAR), sameJson(MEMBERS))).toEqual(MEMBERS)
    expect(browser.waitForValue(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    browser.setViewport(PHONE.width, PHONE.height)
    browser.waitForFunction(has(SCREEN))
    expect(browser.waitForValue(locationJs, (value) => value === scoped('/git'))).toBe(scoped('/git'))
    // A pushed repository view survives the round trip too.
    browser.click(OPEN_REPO)
    browser.waitForFunction(has(BACK))
    browser.setViewport(DESKTOP.width, DESKTOP.height)
    browser.waitForFunction(`${has(SIDEBAR)} && document.querySelector(${JSON.stringify(BACK)})?.checkVisibility() !== true`)
    browser.setViewport(PHONE.width, PHONE.height)
    browser.waitForFunction(has(BACK))
    expect(browser.waitForValue(locationJs, (value) => value === `${scoped('/git')}?view=repo`)).toBe(`${scoped('/git')}?view=repo`)
    expect(browser.count(SCREEN)).toBe(0)
  }, 90_000)

  it('scrolls the last row clear of the New task button and the tab bar, and it stays clickable', () => {
    openScreen()
    browser.waitForFunction(rowsReady(SCREEN, MEMBERS.length))
    const facts = browser.waitForValue<Record<string, boolean>>(`(() => {
      const main = document.querySelector('[data-slot="main"]');
      const rows = [...document.querySelectorAll('${SCREEN} ${ROW}')];
      const row = rows[rows.length - 1];
      if (!main || !row) return null;
      main.scrollTop = main.scrollHeight;
      const rect = row.getBoundingClientRect();
      const fab = document.querySelector('[data-slot="mobile-new-task"]')?.getBoundingClientRect();
      const tabs = document.querySelector('${TAB_BAR}')?.getBoundingClientRect();
      const hits = [0.1, 0.5, 0.9].map((x) => document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height / 2));
      return {
        scrolls: main.scrollHeight > main.clientHeight,
        inViewport: rect.top >= 0 && rect.bottom <= innerHeight,
        aboveTabBar: !tabs || rect.bottom <= tabs.top + 1,
        clearOfFab: !fab || rect.bottom <= fab.top + 1 || rect.top >= fab.bottom || rect.right <= fab.left || rect.left >= fab.right,
        hitsRow: hits.every((hit) => hit !== null && row.contains(hit)),
      };
    })()`, (value) => Boolean(value?.inViewport))
    browser.screenshot(`${artifactsDir}/git-worktree-screen-scrolled.png`, { viewport: true })
    expect(facts).toEqual({ scrolls: true, inViewport: true, aboveTabBar: true, clearOfFab: true, hitsRow: true })
    const lastId = String(browser.evaluate(`[...document.querySelectorAll('${SCREEN} ${ROW}')].pop().getAttribute('data-run-id')`))
    browser.click(`${SCREEN} ${ROW}[data-run-id="${lastId}"]`)
    const url = scoped(`/tasks/${lastId}/changes`)
    expect(browser.waitForValue(locationJs, (value) => value === url)).toBe(url)
  }, 90_000)

  it('is keyboard operable: Tab reaches Open repository with a focus ring and Enter opens it', () => {
    openScreen()
    browser.waitForFunction(rowsReady(SCREEN, MEMBERS.length))
    focusWithKeyboard(browser, OPEN_REPO)
    const ring = browser.waitForValue<Record<string, unknown>>(`(() => {
      const el = document.activeElement;
      if (!el || !el.matches(${JSON.stringify(OPEN_REPO)})) return null;
      const style = getComputedStyle(el);
      return { focusVisible: el.matches(':focus-visible'), ring: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 || style.boxShadow !== 'none' };
    })()`)
    expect(ring).toEqual({ focusVisible: true, ring: true })
    browser.press('Enter')
    const url = `${scoped('/git')}?view=repo`
    expect(browser.waitForValue(locationJs, (value) => value === url)).toBe(url)
    // The Back link is also shown while the repository loads; wait for the loaded view's own link
    // so the focus we place is not thrown away by the swap.
    browser.waitForFunction(has(REPO_TABS))
    focusWithKeyboard(browser, BACK)
    browser.press('Enter')
    browser.waitForFunction(has(SCREEN))

    focusWithKeyboard(browser, `${SCREEN} ${ROW}[data-run-id="wt-failed"]`)
    browser.press('Enter')
    const task = scoped('/tasks/wt-failed/changes')
    expect(browser.waitForValue(locationJs, (value) => value === task)).toBe(task)
  }, 90_000)

  it('runs no animation or transition on the worktree screen under reduced motion', () => {
    const calm = session('reduced', PHONE)
    openPhone('/git', calm)
    calm.setReducedMotion()
    calm.goto(`${base}${scoped('/git')}`)
    calm.waitForFunction(has(SCREEN))
    expect(calm.waitForValue(idsJs(SCREEN), sameJson(MEMBERS))).toEqual(MEMBERS)
    const facts = calm.waitForValue<Record<string, unknown>>(`(() => {
      const box = document.querySelector('${SCREEN}');
      if (!box) return null;
      const nodes = [box, ...box.querySelectorAll('*')];
      return {
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
        animations: nodes.flatMap((node) => node.getAnimations()).length,
        transitions: [...new Set(nodes.map((node) => getComputedStyle(node).transitionDuration))].filter((d) => d.split(',').some((part) => parseFloat(part) > 0.001)),
      };
    })()`)
    expect(facts).toEqual({ reduced: true, animations: 0, transitions: [] })
  }, 90_000)

  it('shows an explicit empty state on the phone screen too', () => {
    const empty = session('phone-empty', PHONE)
    empty.routeJson('**/worktrees', { worktrees: [], totalBytes: 0, keep: 0 })
    empty.goto(`${base}${scoped('/git')}`)
    empty.waitForFunction(has(SCREEN))
    expect(empty.waitForValue(`document.querySelector(${JSON.stringify(SCREEN)}).textContent.includes(${JSON.stringify(EMPTY_TEXT)}) ? true : null`)).toBe(true)
    // With nothing listed, the way into the repository is still there.
    expect(empty.count(OPEN_REPO)).toBe(1)
    empty.screenshot(`${artifactsDir}/git-worktree-screen-empty.png`, { viewport: true })
  }, 90_000)

  it('leaves the other phone views on their own screens', () => {
    browser.setViewport(PHONE.width, PHONE.height)
    browser.goto(`${base}${scoped('/')}`)
    browser.waitForFunction(`document.querySelector('[data-route="tasks"]') !== null`)
    expect(browser.count(SCREEN)).toBe(0)
    expect(browser.count(SIDEBAR)).toBe(0)
  }, 90_000)
})
