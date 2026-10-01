import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { artifactsDir } from './github-fixture'
import { stopFixtureServer } from './fixture-server'
import { waitForHealth } from './poll'

/**
 * Issue 06 §3 (#622, Git slice) and issue 08 §C: the Git view's sidebar (desktop) and Git screen
 * (phone), in a real browser against its own fixture server. The checkout block and the sections
 * read `GET /repo`, `GET /repo/branches` and `GET /worktrees`, and act through `POST /repo/pull`,
 * `POST /repo/branch`, `PUT /config` and `POST /repo/branches/delete`.
 *
 * The fixture pins what the view must show and what it must no longer show:
 *   - Project A is on `main` with a second branch (`feature`), commits made today, one
 *     uncommitted file, and task worktrees on disk. Its `cez/*` branches cover issue 08's classes:
 *     a finished task's unmerged work (`cez/nl-task`), a branch whose task was deleted
 *     (`cez/orphan1`), and one already on main (`cez/merged1`). It has no remote, so the forge
 *     cannot answer and classification is by ancestry only. The sidebar lists the checkout block
 *     and the sections Recently on main / Not landed / Cleanup / All branches — never a
 *     task-worktree row or a task link.
 *   - Project B is on `b-main` with its own worktree; neither project's checkout or worktrees
 *     may appear under the other.
 */

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1440, height: 900 }

const SIDEBAR = '[data-slot="git-sidebar"]'
const CHECKOUT = '[data-slot="git-checkout"]'
const SECTIONS = '[data-slot="git-sections"]'
const SCREEN = '[data-slot="git-screen"]'
const HEADER = '[data-slot="repo-header"]'

const A_WORKTREES = ['wt-done', 'wt-review']
const B_WORKTREES = ['b-only']

let root: string
let rootB: string
let base: string
let project: string
let projectB: string
let server: ChildProcess
let browser: AgentBrowser

const scoped = (path: string, id = project) => `/p/${id}${path}`
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const locationJs = `location.pathname + location.search`
const has = (selector: string) => `document.querySelector(${JSON.stringify(selector)}) !== null`

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cez-git-view-'))
  rootB = mkdtempSync(join(tmpdir(), 'cez-git-view-b-'))
  const seed = (dir: string, branch: string, subjects: string[]) => {
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
    git('init', '-q', '-b', branch)
    for (const subject of subjects) {
      git('-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit', '--allow-empty', '-q', '-m', subject)
    }
    // The fixture's own state stays out of `git status`, so the dirty count is exactly ours.
    writeFileSync(join(dir, '.git/info/exclude'), '.ai/\n')
    mkdirSync(join(dir, '.ai/cezar/worktrees'), { recursive: true })
  }
  seed(root, 'main', ['fixture: first', 'fixture: second', 'fixture: third'])
  execFileSync('git', ['-C', root, 'branch', 'feature'])
  // Issue 08's classes: two branches with work main does not have, and one already on main.
  const commitOn = (branch: string, subject: string) => {
    execFileSync('git', ['-C', root, 'branch', branch, 'main'])
    const tree = execFileSync('git', ['-C', root, 'rev-parse', 'main^{tree}'], { encoding: 'utf8' }).trim()
    const sha = execFileSync('git', ['-C', root, '-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit-tree', tree, '-p', branch, '-m', subject], { encoding: 'utf8' }).trim()
    execFileSync('git', ['-C', root, 'update-ref', `refs/heads/${branch}`, sha])
  }
  commitOn('cez/nl-task', 'feat: work that never landed')
  commitOn('cez/orphan1', 'feat: work whose task was deleted')
  execFileSync('git', ['-C', root, 'branch', 'cez/merged1', 'main~1'])
  writeFileSync(join(root, 'dirty.txt'), 'uncommitted\n')
  seed(rootB, 'b-main', ['fixture: b'])

  const worktree = (dir: string, id: string) => {
    const path = join(dir, '.ai/cezar/worktrees', id)
    mkdirSync(path, { recursive: true })
    // Something for `du` to measure, so Cleanup has a real size to show.
    writeFileSync(join(path, 'payload.bin'), Buffer.alloc(512 * 1024, 1))
    return path
  }
  const run = (dir: string, id: string, extra: Record<string, unknown>) => ({
    id, title: `Task ${id}`, workflow: 'default', task: id, status: 'done', createdAt: ago(7_200_000), finishedAt: ago(3_600_000),
    tokensUsed: 0, archived: false, steps: [], worktreePath: worktree(dir, id), branch: `cez/${id}`, ...extra,
  })
  writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify([
    run(root, 'wt-done', { title: 'Finished but retained' }),
    run(root, 'wt-review', { title: 'Waiting for review', status: 'review', finishedAt: undefined }),
    // A finished task whose branch holds work main lacks, its worktree already reclaimed.
    { ...run(root, 'nl-task', { title: 'Work that never landed', branch: 'cez/nl-task' }), worktreePath: undefined },
  ]))
  writeFileSync(join(rootB, '.ai/cezar/runs.json'), JSON.stringify([run(rootB, 'b-only', { title: 'B only worktree' })]))

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
  browser = AgentBrowser.open(`git-view-${process.pid}`)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
}, 60_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  for (const dir of [root, rootB]) if (dir) rmSync(dir, { recursive: true, force: true })
})

/** The section rows as the user sees them: label, count, target, and whether the row is lit. */
const sectionsJs = (container: string) => `(() => {
  const box = document.querySelector(${JSON.stringify(`${container} ${SECTIONS}`)});
  if (!box) return null;
  return [...box.querySelectorAll('a[data-git-section]')].map((row) => ({
    section: row.dataset.gitSection,
    label: row.querySelector('span.truncate')?.textContent ?? null,
    count: row.querySelector('[data-slot="git-section-count"]')?.textContent ?? null,
    href: row.getAttribute('href'),
    current: row.getAttribute('aria-current'),
    height: Math.round(row.getBoundingClientRect().height),
  }));
})()`
type SectionRow = { section: string; label: string | null; count: string | null; href: string; current: string | null; height: number }
const litJs = `[...document.querySelectorAll(${JSON.stringify(`${SIDEBAR} ${SECTIONS} a[aria-current="page"]`)})].map((row) => row.dataset.gitSection)`

/** The size the Cleanup card prints for the worktrees on disk (its heading's `· N MB`). */
const cardSizeJs = `(() => {
  const heading = document.querySelector('[data-slot="worktrees-panel"] h2');
  return heading ? heading.textContent.split(' · ')[1] ?? null : null;
})()`

const openDesktop = (path = '/git', id = project) => {
  browser.setViewport(DESKTOP.width, DESKTOP.height)
  browser.goto(`${base}${scoped(path, id)}`)
  browser.waitForFunction(has(`${SIDEBAR} ${SECTIONS}`))
  // The sections render before `/repo` answers and the checkout block then mounts ABOVE them,
  // pushing every section row down. Clicking a section before that lands on the checkout's
  // uncommitted line instead (CI failure bundle, PR #716 run 36772703613 shard 4:
  // git-sidebar/All-branches-lists-the-branches-…-1 — focus on git-uncommitted, URL /git/changes).
  browser.waitForFunction(has(`${SIDEBAR} ${CHECKOUT}`))
}
const setTheme = (theme: 'light' | 'dark') =>
  browser.evaluate(`document.documentElement.classList.remove('light', 'dark'); document.documentElement.classList.add('${theme}')`)

describe('the fixture', () => {
  it('has the git state this spec assumes', async () => {
    const repo = (await fetch(`${base}/api/v1/p/${project}/repo`).then((r) => r.json())) as { info: { branch: string }; status: Array<{ path: string }>; branches: string[] }
    expect(repo.info.branch).toBe('main')
    // Booting may add files of its own (cezar's data gitignore); ours is the one this spec names.
    expect(repo.status.map((entry) => entry.path)).toContain('dirty.txt')
    expect(repo.branches).toEqual(['feature', 'main'])
    const branches = (await fetch(`${base}/api/v1/p/${project}/repo/branches`).then((r) => r.json())) as { prStateKnown: boolean; branches: Array<{ name: string; class: string }> }
    expect(Object.fromEntries(branches.branches.map((entry) => [entry.name, entry.class]))).toEqual({
      'cez/merged1': 'merged', 'cez/nl-task': 'not-landed', 'cez/orphan1': 'orphan', feature: 'other', main: 'active',
    })
    expect(branches.prStateKnown).toBe(false)
    const worktrees = (await fetch(`${base}/api/v1/p/${project}/worktrees`).then((r) => r.json())) as { worktrees: Array<{ runId: string }>; totalBytes: number | null }
    expect(worktrees.worktrees.map((entry) => entry.runId).sort()).toEqual(A_WORKTREES)
    expect(worktrees.totalBytes).toBeGreaterThan(0)
  })
})

describe('Git desktop sidebar (issue 06 §3)', () => {
  it('shows the checkout block, then Recently on main (lit), Not landed, Cleanup and All branches with counts', async () => {
    const dirty = ((await fetch(`${base}/api/v1/p/${project}/repo`).then((r) => r.json())) as { status: unknown[] }).status.length
    openDesktop()
    const rows = browser.waitForValue<SectionRow[]>(sectionsJs(SIDEBAR), (value) => Array.isArray(value) && value[1]?.count !== null && value[2]?.count !== null && value[3]?.count !== null)
    expect(rows.map(({ section, label, href, current, height }) => ({ section, label, href, current, height }))).toEqual([
      { section: 'main', label: 'Recently on main', href: scoped('/git'), current: 'page', height: 32 },
      { section: 'not-landed', label: 'Not landed', href: scoped('/git/not-landed'), current: null, height: 32 },
      { section: 'cleanup', label: 'Cleanup', href: scoped('/git/cleanup'), current: null, height: 32 },
      { section: 'branches', label: 'All branches', href: scoped('/git/branches'), current: null, height: 32 },
    ])
    expect(rows[0]?.count).toBeNull()
    expect(rows[1]?.count).toBe('2')
    expect(rows[2]?.count).toMatch(/^\d+(\.\d)? (kB|MB|GB)$/)
    expect(rows[3]?.count).toBe('5')
    // No upstream: no freshness line.
    expect(browser.count(`${CHECKOUT} [data-slot="git-freshness"]`)).toBe(0)

    // The checkout block: branch, Pull (no remote here, so disabled with its reason), the base picker, the dirty line.
    expect(browser.text(`${CHECKOUT} [data-slot="git-checkout-branch"]`)).toBe('main')
    expect(browser.evaluate(`document.querySelector('${CHECKOUT} [data-action="repo-pull"]').title`)).toContain('No remote configured')
    expect(browser.evaluate(`document.querySelector('${CHECKOUT} [data-slot="base-branch-picker"]').textContent`)).toBe('New tasks start frommain')
    expect(browser.text(`${CHECKOUT} [data-slot="git-uncommitted"]`)).toBe(`${dirty} uncommitted file${dirty === 1 ? '' : 's'}`)
    expect(browser.evaluate(`document.querySelector('${CHECKOUT} [data-slot="git-uncommitted"]').getAttribute('href')`)).toBe(scoped('/git/changes'))
    // Block first, sections below; nothing else in the body.
    expect(browser.evaluate(`[...document.querySelector(${JSON.stringify(SIDEBAR)}).children].map((child) => child.dataset.slot)`)).toEqual(['git-checkout', 'git-sections'])

    // No task-worktree list and no jump into a task; the Tasks quick list is not here either.
    expect(browser.count('[data-slot="git-worktree-list"], [data-slot="git-worktree-row"]')).toBe(0)
    expect(browser.evaluate(`[...document.querySelectorAll('${SIDEBAR} a')].some((a) => a.getAttribute('href').includes('/tasks/'))`)).toBe(false)
    expect(browser.count('[data-slot="task-quick-list"]')).toBe(0)

    // The main area: a title and a meta line, no Changes/Commits/Branches tabs, the log grouped by day.
    browser.waitForFunction(has('[data-slot="repo-commit-day"]'))
    expect(browser.text(`${HEADER} h1`)).toBe('Recently on main')
    expect(browser.text(`${HEADER} [data-slot="repo-meta"]`)).toBe('latest 3 commits in the main checkout')
    expect(browser.count('[data-slot="repo-tabs"]')).toBe(0)
    expect(browser.evaluate(`[...document.querySelectorAll('[data-slot="repo-commit-day"] h2')].map((h) => h.textContent)`)).toEqual(['Today'])
    expect(browser.count('[data-slot="commit-row"]')).toBe(3)
    // No task is known for these commits: each says so, without claiming who wrote them.
    expect(browser.evaluate(`[...document.querySelectorAll('[data-slot="commit-source"]')].map((s) => s.textContent)`)).toEqual([
      'no task found', 'no task found', 'no task found',
    ])
  }, 90_000)

  it('paints the view in light and dark without horizontal overflow', () => {
    for (const theme of ['light', 'dark'] as const) {
      openDesktop()
      setTheme(theme)
      browser.waitForFunction(has('[data-slot="repo-commit-day"]'))
      const facts = browser.evaluate(`({
        light: document.documentElement.classList.contains('light'),
        overflow: document.documentElement.scrollWidth > innerWidth,
        card: getComputedStyle(document.querySelector(${JSON.stringify(CHECKOUT)})).borderTopLeftRadius,
      })`)
      expect(facts).toEqual({ light: theme === 'light', overflow: false, card: '8px' })
      browser.screenshot(`${artifactsDir}/git-view-desktop-${theme}.png`, { viewport: true })
    }
  }, 90_000)

  it('Cleanup shows the worktrees card and the branches safe to delete, sized like its sidebar count', () => {
    openDesktop()
    browser.click(`${SIDEBAR} a[data-git-section="cleanup"]`)
    expect(browser.waitForValue(locationJs, (value) => value === scoped('/git/cleanup'))).toBe(scoped('/git/cleanup'))
    expect(browser.waitForValue(litJs, (value) => JSON.stringify(value) === '["cleanup"]')).toEqual(['cleanup'])
    const size = browser.waitForValue<string | null>(cardSizeJs, (value) => typeof value === 'string')
    const rows = browser.waitForValue<SectionRow[]>(sectionsJs(SIDEBAR), (value) => Array.isArray(value) && value[2]?.count !== null)
    expect(rows[2]?.count).toBe(size)
    expect(browser.text(`${HEADER} h1`)).toBe('Cleanup')
    expect(browser.text(`${HEADER} [data-slot="repo-meta"]`)).toBe('nothing here can delete work that is not on main')
    expect(browser.evaluate(`[...document.querySelectorAll('[data-slot="worktree-row"]')].map((row) => row.dataset.run).sort()`)).toEqual(A_WORKTREES)
    // Issue 08: the per-row action is the directory-only Reclaim, and only on the finished row.
    expect(browser.evaluate(`[...document.querySelectorAll('[data-action="worktree-reclaim"]')].map((b) => b.getAttribute('aria-label'))`)).toEqual([
      'Reclaim the worktree of Finished but retained (branch kept)',
    ])
    expect(browser.count('[data-action="worktree-delete"]')).toBe(0)
    expect(browser.count('[data-action="worktrees-reclaim-now"]')).toBe(1)
    expect(browser.text('[data-slot="worktree-row"][data-run="wt-review"]')).toContain('in use')
    // The branch card: the merged branch only; the not-landed and orphan ones never appear here.
    browser.waitForFunction(has('[data-slot="cleanup-branches"]'))
    expect(browser.text('[data-slot="cleanup-branches"] h2')).toBe('Branches safe to delete · 1')
    expect(browser.text('[data-slot="cleanup-branch-group"][data-group="merged"] button')).toContain('squash-merged branches may show as not landed without github')
    for (const theme of ['light', 'dark'] as const) {
      setTheme(theme)
      browser.screenshot(`${artifactsDir}/git-view-cleanup-${theme}.png`, { viewport: true })
    }
  }, 90_000)

  it('All branches lists the branches, and the uncommitted line opens the main tree’s changes', () => {
    openDesktop()
    browser.click(`${SIDEBAR} a[data-git-section="branches"]`)
    expect(browser.waitForValue(locationJs, (value) => value === scoped('/git/branches'))).toBe(scoped('/git/branches'))
    browser.waitForFunction(has('[data-slot="repo-branch-list"]'))
    expect(browser.count('[data-slot="branch-row"]')).toBe(5)
    expect(browser.evaluate(litJs)).toEqual(['branches'])

    browser.click(`${CHECKOUT} [data-slot="git-uncommitted"]`)
    expect(browser.waitForValue(locationJs, (value) => value === scoped('/git/changes'))).toBe(scoped('/git/changes'))
    browser.waitForFunction(has('[data-slot="diff-file"][data-path="dirty.txt"]'))
    expect(browser.text(`${HEADER} h1`)).toBe('Uncommitted changes')
    // Not a section of its own: nothing in the list is lit.
    expect(browser.evaluate(litJs)).toEqual([])
  }, 90_000)

  it('the old /git/commits, /git/commits/:sha and /git/branches URLs still resolve on a cold load', () => {
    const sha = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
    for (const [path, section, title, ready] of [
      ['/git/commits', 'main', 'Recently on main', '[data-slot="repo-commit-day"]'],
      [`/git/commits/${sha}`, 'main', 'Recently on main', '[data-slot="repo-commit"]'],
      ['/git/branches', 'branches', 'All branches', '[data-slot="repo-branch-list"]'],
    ] as const) {
      openDesktop(path)
      browser.waitForFunction(has(ready))
      expect(browser.text(`${HEADER} h1`), path).toBe(title)
      expect(browser.waitForValue(litJs, (value) => JSON.stringify(value) === JSON.stringify([section])), path).toEqual([section])
      expect(browser.count('[data-slot="repo-tabs"]'), path).toBe(0)
    }
  }, 90_000)

  it('the base-branch picker sets where new tasks start, through PUT /config', async () => {
    openDesktop()
    browser.click(`${CHECKOUT} [data-slot="base-branch-picker"]`)
    browser.click('[role="menuitemradio"][data-branch="feature"]')
    expect(browser.waitForValue(`document.querySelector('${CHECKOUT} [data-slot="base-branch"]')?.textContent ?? null`, (value) => value === 'feature')).toBe('feature')
    const config = (await fetch(`${base}/api/v1/p/${project}/config`).then((r) => r.json())) as { baseBranch: string | null }
    expect(config.baseBranch).toBe('feature')
    // Back to the zero-config default: follow the checked-out branch. Reopen only once the first
    // menu has fully left: a trigger press during its exit animation lands as an outside dismiss
    // and the menu stays closed (.ai/qa/failures/git-sidebar/the-base-branch-picker-sets-where-new-
    // tasks-start-through-PUT-config-1, 2026-09-30T20:17Z: trigger focused, aria-expanded=false).
    browser.waitForFunction(`document.querySelector('[role="menu"]') === null`)
    browser.click(`${CHECKOUT} [data-slot="base-branch-picker"]`)
    browser.click('[role="menuitemradio"][data-branch=""]')
    expect(browser.waitForValue(`document.querySelector('${CHECKOUT} [data-slot="base-branch"]')?.textContent ?? null`, (value) => value === 'main')).toBe('main')
  }, 90_000)

  it('each project shows its own checkout and worktrees, in both directions of a switch', () => {
    openDesktop('/git', projectB)
    expect(browser.waitForValue(`document.querySelector('${CHECKOUT} [data-slot="git-checkout-branch"]')?.textContent ?? null`, (value) => value === 'b-main')).toBe('b-main')
    browser.click(`${SIDEBAR} a[data-git-section="cleanup"]`)
    expect(browser.waitForValue(`[...document.querySelectorAll('[data-slot="worktree-row"]')].map((row) => row.dataset.run)`, (value) => JSON.stringify(value) === JSON.stringify(B_WORKTREES))).toEqual(B_WORKTREES)
    openDesktop('/git/cleanup')
    expect(browser.waitForValue(`document.querySelector('${CHECKOUT} [data-slot="git-checkout-branch"]')?.textContent ?? null`, (value) => value === 'main')).toBe('main')
    expect(browser.waitForValue(`[...document.querySelectorAll('[data-slot="worktree-row"]')].map((row) => row.dataset.run).sort()`, (value) => JSON.stringify(value) === JSON.stringify(A_WORKTREES))).toEqual(A_WORKTREES)
  }, 90_000)
})

describe('Git → Not landed and the branch cleanup (issue 08 §C)', () => {
  it('lists the unmerged work by what the user can do, with the no-forge note and no error', () => {
    openDesktop('/git/not-landed')
    browser.waitForFunction(has('[data-slot="not-landed-group"]'))
    expect(browser.text(`${HEADER} h1`)).toBe('Not landed')
    expect(browser.evaluate(litJs)).toEqual(['not-landed'])
    expect(browser.evaluate(`[...document.querySelectorAll('[data-slot="not-landed-group"]')].map((group) => [group.dataset.group, [...group.querySelectorAll('[data-slot="not-landed-row"]')].map((row) => row.dataset.branch)])`)).toEqual([
      ['no-pr', ['cez/nl-task']],
      ['deleted', ['cez/orphan1']],
    ])
    expect(browser.text('[data-slot="git-no-forge"]')).toBe('Squash-merged branches may show as not landed without GitHub.')
    expect(browser.evaluate(`document.querySelector('[data-branch="cez/nl-task"] [data-action="not-landed-open"]').getAttribute('href')`)).toBe(scoped('/tasks/nl-task'))
    expect(browser.count('[data-branch="cez/orphan1"] [data-action="not-landed-copy"]')).toBe(1)
    for (const theme of ['light', 'dark'] as const) {
      setTheme(theme)
      expect(browser.evaluate(`document.documentElement.scrollWidth > innerWidth`)).toBe(false)
      browser.screenshot(`${artifactsDir}/git-view-not-landed-${theme}.png`, { viewport: true })
    }
  }, 90_000)

  it('deletes an orphan branch only after its name is typed, and the branch is gone from git', () => {
    openDesktop('/git/not-landed')
    browser.click('[data-branch="cez/orphan1"] [data-action="not-landed-more"]')
    browser.click('[data-action="not-landed-delete"]')
    browser.waitForFunction(has('[data-slot="delete-branch-dialog"]'))
    expect(browser.text('[data-slot="delete-branch-dropped"]')).toContain('1 commit will be dropped')
    expect(browser.evaluate(`document.querySelector('[data-action="delete-branch-confirm"]').disabled`)).toBe(true)
    browser.fill('[data-slot="delete-branch-confirm"]', 'cez/orphan1')
    browser.waitForFunction(`document.querySelector('[data-action="delete-branch-confirm"]:not([disabled])') !== null`)
    browser.click('[data-action="delete-branch-confirm"]')
    expect(browser.waitForValue(`[...document.querySelectorAll('[data-slot="not-landed-row"]')].map((row) => row.dataset.branch)`, (value) => JSON.stringify(value) === '["cez/nl-task"]')).toEqual(['cez/nl-task'])
    expect(execFileSync('git', ['-C', root, 'branch', '--list', 'cez/orphan1'], { encoding: 'utf8' }).trim()).toBe('')
    expect(execFileSync('git', ['-C', root, 'branch', '--list', 'cez/nl-task'], { encoding: 'utf8' }).trim()).toBe('cez/nl-task')
  }, 90_000)

  it('Delete N branches removes the merged branch and nothing that is not on main', () => {
    openDesktop('/git/cleanup')
    browser.waitForFunction(`document.querySelector('[data-action="cleanup-branches-delete"]:not([disabled])') !== null`)
    browser.click('[data-action="cleanup-branches-delete"]')
    // The confirm button mounts while the dialog is still fading and zooming in. A click in that
    // window lands wherever the button is at that frame, and a click that misses it deletes
    // nothing (#736). Click once the animations have finished and a hit-test at
    // the button's centre resolves to the button itself.
    // Verified locally: with animation-duration:1500ms !important injected for [role=alertdialog]
    // and [data-slot=alert-dialog-overlay] before opening the dialog, `npm run test:e2e --
    // git-sidebar.e2e.ts -t "Delete N branches"` failed without this wait (the confirm click was
    // covered by the fixed inset-0 backdrop) and passed with it. Full recipe:
    // https://github.com/hearsay-tools/cezarion/pull/739#discussion_r4158594664
    browser.waitForValue(`(() => {
      const button = document.querySelector('[data-action="cleanup-branches-confirm"]')
      const dialog = document.querySelector('[role="alertdialog"]')
      const overlay = document.querySelector('[data-slot="alert-dialog-overlay"]')
      if (!button || !dialog || !overlay) return false
      if ([button, dialog, overlay].some((el) => el.getAnimations().some((animation) => animation.playState === 'running'))) return false
      const rect = button.getBoundingClientRect()
      return button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
    })()`)
    browser.click('[data-action="cleanup-branches-confirm"]')
    expect(browser.waitForValue(`document.querySelector('[data-slot="cleanup-branches"] h2')?.textContent ?? null`, (value) => value === 'Branches safe to delete · 0')).toBe('Branches safe to delete · 0')
    expect(execFileSync('git', ['-C', root, 'branch', '--list', 'cez/merged1'], { encoding: 'utf8' }).trim()).toBe('')
    expect(execFileSync('git', ['-C', root, 'branch', '--list', 'cez/nl-task'], { encoding: 'utf8' }).trim()).toBe('cez/nl-task')
  }, 90_000)
})

describe('the phone Git screen (issue 06 §3)', () => {
  it('opens the checkout block and the sections as 48px rows with chevrons; a section pushes its screen', () => {
    browser.setViewport(PHONE.width, PHONE.height)
    browser.goto(`${base}${scoped('/git')}`)
    const rows = browser.waitForValue<SectionRow[]>(sectionsJs(SCREEN), (value) => Array.isArray(value) && value[1]?.count !== null && value[2]?.count !== null)
    // The earlier specs deleted the orphan and the merged branch: one not landed, three branches.
    expect(rows.map(({ section, label, count, href, height }) => ({ section, label, count, href, height }))).toEqual([
      { section: 'main', label: 'Recently on main', count: '3 today', href: `${scoped('/git')}?view=repo`, height: 48 },
      { section: 'not-landed', label: 'Not landed', count: '1', href: scoped('/git/not-landed'), height: 48 },
      { section: 'cleanup', label: 'Cleanup', count: rows[2]!.count, href: scoped('/git/cleanup'), height: 48 },
      { section: 'branches', label: 'All branches', count: '3', href: scoped('/git/branches'), height: 48 },
    ])
    expect(browser.count(`${SCREEN} ${CHECKOUT}[data-variant="screen"]`)).toBe(1)
    expect(browser.count(`${SCREEN} [data-slot="git-uncommitted"]`)).toBe(1)
    expect(browser.count('[data-slot="git-worktree-row"]')).toBe(0)
    expect(browser.count('[data-slot="mobile-tab-bar"]')).toBe(1)
    expect(browser.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    for (const theme of ['light', 'dark'] as const) {
      setTheme(theme)
      browser.screenshot(`${artifactsDir}/git-view-phone-${theme}.png`, { viewport: true })
    }

    browser.click(`${SCREEN} a[data-git-section="cleanup"]`)
    expect(browser.waitForValue(locationJs, (value) => value === scoped('/git/cleanup'))).toBe(scoped('/git/cleanup'))
    browser.waitForFunction(has('[data-slot="worktrees-panel"]'))
    expect(browser.count(SCREEN)).toBe(0)
    // A pushed section hides the tab bar (issue 08 §C, the slice 5 rule); Back to Git leads home.
    expect(browser.count('[data-slot="mobile-tab-bar"]')).toBe(0)
    browser.click('[data-slot="git-back"]')
    expect(browser.waitForValue(locationJs, (value) => value === scoped('/git'))).toBe(scoped('/git'))
    browser.waitForFunction(has(`${SCREEN} ${SECTIONS}`))

    browser.click(`${SCREEN} a[data-git-section="main"]`)
    expect(browser.waitForValue(locationJs, (value) => value === `${scoped('/git')}?view=repo`)).toBe(`${scoped('/git')}?view=repo`)
    browser.waitForFunction(has('[data-slot="repo-commit-day"]'))
    expect(browser.text(`${HEADER} h1`)).toBe('Recently on main')
    expect(browser.count(SCREEN)).toBe(0)
  }, 90_000)
})
