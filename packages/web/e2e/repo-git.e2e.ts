import { execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { waitForSettledSample } from './visual-ready'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv, readTestEnv } from './agent-browser'
import { assertDiffCoverage } from './repo-diff-coverage'
// fixture-server starts: 1

/**
 * The repo view (R5 Step 1.7) end-to-end against the shared dry-run environment — which
 * serves THIS repository, so every assertion is against real git state, read at test time
 * rather than assumed: the working tree may be clean or dirty (both are honest states the
 * view must render), the log is whatever this checkout's history is, and the branch list is
 * live. Strictly READ-ONLY: no branch creation, no switching, no commits — the mutation
 * flows (switch/create incl. 409 reasons, base-branch picker) are pinned in
 *  `src/routes/repo-git/repo-git.test.tsx` against fixtures.
 *
 *  Diff completeness is NOT mounted-card cardinality: past the row threshold the same
 *  `<Diff>` virtualizes and the viewport mounts a window. Totals, the file tree, and
 *  last-row selection are the oracles (`repo-diff-coverage.ts`); card counts stay for
 *  the flat renderer. Deterministic small/large fixtures live in `repo-git-diff.e2e.ts`.
 *
 *  The one exception to "real git state" is opening a commit's structured diff, which runs
 *  against a two-commit repository this spec builds and serves itself (see the last
 *  `describe`): what the served clone's commit diffs hold depends on how the checkout was
 *  made and how big its tree is, which is no business of a test about opening a commit.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-repo-git-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }
const IPHONE = { width: 390, height: 844 }

let browser: AgentBrowser
let baseUrl: string
let bootProject: string

/** A flat route target under this server's own project prefix (multi-project spec, step 3.2):
 *  every cockpit link is scoped, and every legacy flat URL redirects onto its scoped twin. */
const scoped = (path: string) => `/p/${bootProject}${path}`

async function api<T>(path: string, origin = baseUrl): Promise<T> {
  const res = await fetch(`${origin}${path}`)
  if (!res.ok) throw new Error(`cezar e2e: GET ${path} answered ${res.status}`)
  return (await res.json()) as T
}

interface RepoPayload {
  info: { branch: string } | null
  log: Array<{ hash: string; subject: string }>
  branches: string[]
}

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  browser?.close()
})

describe('the repo view against the live dry-run server', () => {
  it('/git/changes renders a title-and-meta header and an honest uncommitted-changes section', async () => {
    const repo = await api<RepoPayload>('/api/v1/repo')
    expect(repo.info).not.toBeNull()

    browser.goto(`${baseUrl}${scoped('/git/changes')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="repo-header"] [data-slot="repo-meta"]') !== null`)
    expect(browser.text('[data-slot="repo-header"] h1')).toBe('Uncommitted changes')
    // Issue 06 §3: the sections live in the sidebar; the main header carries no tabs.
    expect(browser.count('[data-slot="repo-tabs"]')).toBe(0)

    // The working tree may be clean or dirty — assert the view tells the same story the API does.
    const changes = await api<{ files: Array<{ path: string }> }>('/api/v1/repo/changes')
    if (changes.files.length === 0) {
      browser.waitForFunction(
        `[...document.querySelectorAll('[data-slot="repo-changes"] h2')].some((h) => h.textContent === 'Working tree clean')`,
      )
    } else {
      assertDiffCoverage(browser, changes.files, { tree: true })
    }

    browser.screenshot(`${artifactsDir}/repo-git-desktop.png`)
  })

  it.each(['/git', '/git/commits'])('%s is Recently on the checkout: this repository’s real commits, grouped by day', async (path) => {
    const repo = await api<RepoPayload>('/api/v1/repo')
    expect(repo.log.length).toBeGreaterThan(0)

    browser.goto(`${baseUrl}${scoped(path)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="repo-commits"] [data-slot="repo-commit-day"]') !== null`)
    // The title carries the REAL current branch, not a fixture (a detached CI checkout reads HEAD).
    expect(browser.text('[data-slot="repo-header"] h1')).toBe(`Recently on ${repo.info?.branch ?? ''}`)
    expect(browser.count('[data-slot="repo-tabs"]')).toBe(0)

    expect(browser.count('[data-slot="commit-row"]')).toBe(repo.log.length)
    const first = repo.log[0]!
    const firstRow = browser.text(`[data-slot="commit-row"][data-sha="${first.hash}"]`)
    expect(firstRow).toContain(first.hash)
    expect(firstRow).toContain(first.subject)
  })

  it('/git/branches renders the live branch list with the checkout marked current', async () => {
    const repo = await api<RepoPayload>('/api/v1/repo')
    expect(repo.branches.length).toBeGreaterThan(0)

    // Issue 08: the list is `GET /repo`'s switch list plus every classified local branch, which is
    // where the `cez/*` task branches come from.
    const classified = await api<{ branches: Array<{ name: string }> }>('/api/v1/repo/branches')
    const listed = new Set([...repo.branches, ...classified.branches.map((entry) => entry.name)])

    browser.goto(`${baseUrl}${scoped('/git/branches')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="repo-branch-list"]') !== null`)

    // The classified half is a second request that lands after the list first paints, so the
    // count is waited for, not read once.
    expect(browser.waitForValue(`document.querySelectorAll('[data-slot="branch-row"]').length`, (value) => value === listed.size)).toBe(listed.size)
    // An attached checkout marks exactly its current branch. CI may run this suite from a
    // detached task worktree; then git honestly reports no branch and no row may be marked.
    const expectedCurrent = repo.info?.branch && listed.has(repo.info.branch) ? 1 : 0
    expect(browser.count('[data-slot="branch-current"]')).toBe(expectedCurrent)
    if (expectedCurrent === 1 && repo.info) {
      expect(
        browser.evaluate(
          `document.querySelector('[data-slot="branch-current"]').closest('[data-slot="branch-row"]').dataset.branch`,
        ),
      ).toBe(repo.info.branch)
    }
    // The base-branch picker is listed once, in the sidebar's checkout block (issue 06 §3).
    expect(browser.count('[data-slot="base-branch-picker"]')).toBe(1)
    expect(browser.count('[data-slot="git-sidebar"] [data-slot="base-branch-picker"]')).toBe(1)
  })

  it('below md the repo view forces unified+wrap, hides the toggles, and never overflows', async () => {
    browser.setViewport(IPHONE.width, IPHONE.height)
    try {
      const changes = await api<{ files: unknown[] }>('/api/v1/repo/changes')
      // The main tree's uncommitted files, as the checkout block's warning opens them.
      browser.goto(`${baseUrl}${scoped('/git/changes')}`)
      browser.waitForFunction(`document.querySelector('[data-slot="repo-changes"]') !== null`)

      if (changes.files.length > 0) {
        browser.waitForFunction(`document.querySelector('[data-slot="diff"]') !== null`)
        // Forced mobile combination, whatever the desktop toggles said.
        expect(browser.evaluate(`document.querySelector('[data-slot="diff"]').dataset.mode`)).toBe('unified')
        // The integrated mobile design stacks the selectable file tree above the diff.
        expect(
          waitForSettledSample(browser,
            `(() => { const el = document.querySelector('[data-slot="changes-tree"]'); return el !== null && el.checkVisibility() && el.getBoundingClientRect().width <= innerWidth })()`,
          ),
        ).toBe(true)
      } else {
        browser.waitForFunction(
          `[...document.querySelectorAll('[data-slot="repo-changes"] h2')].some((h) => h.textContent === 'Working tree clean')`,
        )
      }
      // The mode/wrap toggles are hidden below md (`md:flex` wrapper).
      expect(
        browser.evaluate(
          `getComputedStyle(document.querySelector('[data-slot="diff-mode-toggle"]').parentElement).display`,
        ),
      ).toBe('none')
      // No tab strip, a way back to the Git screen, and the page never scrolls sideways.
      expect(browser.count('[data-slot="repo-tabs"]')).toBe(0)
      expect(browser.count('[data-slot="git-back"]')).toBe(1)
      expect(waitForSettledSample(browser, `document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true)

      browser.screenshot(`${artifactsDir}/repo-git-iphone.png`)
    } finally {
      browser.setViewport(DESKTOP.width, DESKTOP.height)
    }
  })
})

const COMMIT_SUBJECT = 'change two modules'
const COMMIT_FILES = 2

/** A base commit, then a non-merge commit that rewrites two small files: a diff that is the same
 *  size on every machine, whatever the checkout this suite runs from looks like. */
function buildCommitFixture(dir: string): void {
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  const writeModules = (tag: string) => {
    for (const name of ['alpha', 'beta']) {
      const lines = Array.from({ length: 4 }, (_, line) => `export const ${tag}_${name}_${line} = ${line}\n`)
      writeFileSync(join(dir, `${name}.ts`), lines.join(''), 'utf8')
    }
  }
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'e2e@example.com'])
  git(['config', 'user.name', 'cezar e2e'])
  writeModules('before')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'base'])
  writeModules('after')
  git(['add', '-A'])
  git(['commit', '-q', '-m', COMMIT_SUBJECT])
}

// This test used to search the served clone's log for "the newest commit that carries a diff", so
// it depended on how the checkout was made and how big its tree is. CI checks out at depth 1: the
// clone's only commit is a root commit, and its whole-tree `git diff-tree --root --patch` (33,564,799
// bytes at 3bed231) is over the 32 MiB `maxBuffer` of `collectCommitChanges`, so the route answers 409
// (hearsay-tools/cezarion#1840). The cap and the 409 stay; the test builds its own diff instead.
describe('opening one commit’s structured diff, in a repository this spec builds', () => {
  let repo = ''
  let server: ChildProcess | undefined
  let fixtureUrl = ''
  let fixtureScoped = (path: string) => path

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cezar-e2e-repo-git-commit-'))
    buildCommitFixture(repo)
    server = spawnFixtureServer([cezarCli, 'serve', '--repo', repo, '--port', '0', '--no-open'], {
      env: fixtureServeEnv(repo),
      stdio: 'ignore',
    })
    fixtureUrl = await waitForFixtureServer(server)
    const project = await bootProjectId(fixtureUrl)
    fixtureScoped = (path) => `/p/${project}${path}`
  }, 120_000)

  afterAll(async () => {
    await stopFixtureServer(server)
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  it('opens the newest commit’s structured diff from the Recently list', async () => {
    // The fixture's newest commit is a non-merge commit that carries a diff, so there is nothing to search for.
    const log = await api<RepoPayload>('/api/v1/repo', fixtureUrl)
    const hash = log.log[0]!.hash
    const commit = await api<{ subject: string; files: Array<{ path: string }> }>(
      `/api/v1/repo/commit/${hash}?structured=1`,
      fixtureUrl,
    )
    expect(commit.subject).toBe(COMMIT_SUBJECT)
    expect(commit.files.length).toBe(COMMIT_FILES)

    browser.goto(`${fixtureUrl}${fixtureScoped('/git/commits')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="commit-row"]') !== null`)
    browser.click(`[data-slot="commit-row"][data-sha="${hash}"]`)

    browser.waitForFunction(`document.querySelector('[data-slot="commit-meta"]') !== null`)
    expect(browser.url()).toBe(`${fixtureUrl}${fixtureScoped(`/git/commits/${hash}`)}`)
    expect(browser.text('[data-slot="commit-meta"]')).toContain(commit.subject)
    assertDiffCoverage(browser, commit.files, { tree: false })
    // A commit opens inside Recently on main, and the way back is that section.
    expect(
      browser.evaluate(`document.querySelector('[data-slot="commit-back"]').getAttribute('href')`),
    ).toBe(fixtureScoped('/git'))

    browser.screenshot(`${artifactsDir}/repo-git-commit.png`)
  })
})
