import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv, getJson } from './agent-browser'
import { assertDiffCoverage } from './repo-diff-coverage'

/**
 * Repo Git diff completeness over generated fixtures — the live `repo-git.e2e.ts` suite
 * cannot control changeset size, so a dirty checkout past the 1,500-row threshold used to
 * time out waiting for every `diff-file` card (#136).
 *
 * Two throwaway repos, each with its own cezar: a small auto-flat changeset and a large
 * auto-virtual one. Both carry a committed snapshot AND a dirty working tree so `/git` and
 * `/git/commits/:sha` exercise the same checks. `?diff=` is not used — mode is the threshold
 * rule, not a forced override.
 */

const sessionId = `e2e-repo-git-diff-${process.pid}`

const SMALL_FILES = 2
const SMALL_LINES = 4
const LARGE_FILES = 120
const LARGE_LINES = 8

type ChangedFiles = { files: Array<{ path: string }> }

let browser: AgentBrowser

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`cezar e2e: the fixture server never answered at ${url}`)
}

function writeModules(dir: string, count: number, lines: number, tag: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true })
  for (let index = 0; index < count; index += 1) {
    writeFileSync(
      join(dir, 'src', `module-${index}.ts`),
      Array.from({ length: lines }, (_, line) => `export const ${tag}_${index}_${line} = ${line}`).join('\n') + '\n',
      'utf8',
    )
  }
}

/** Base commit, a second commit with the named tag, then a dirty working tree. */
function buildFixtureRepo(dir: string, count: number, lines: number): void {
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'e2e@example.com'])
  git(['config', 'user.name', 'cezar e2e'])
  writeModules(dir, count, lines, 'before')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'base'])
  writeModules(dir, count, lines, 'commit')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'changed files'])
  writeModules(dir, count, lines, 'after')
}

async function bootFixture(
  label: string,
  count: number,
  lines: number,
): Promise<{
  repo: string
  server: ChildProcess
  baseUrl: string
  scoped: (path: string) => string
}> {
  const repo = mkdtempSync(join(tmpdir(), `cezar-e2e-repo-git-diff-${label}-`))
  buildFixtureRepo(repo, count, lines)
  const port = await freePort()
  const baseUrl = `http://localhost:${port}`
  const server = spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', repo, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(repo), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  const project = await bootProjectId(baseUrl)
  return { repo, server, baseUrl, scoped: (path: string) => `/p/${project}${path}` }
}

function stopFixture(server: ChildProcess | undefined, repo: string | undefined): void {
  server?.kill()
  try {
    if (repo) rmSync(repo, { recursive: true, force: true })
  } catch {
    /* the OS reaps it */
  }
}

beforeAll(() => {
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
})

afterAll(() => {
  browser?.close()
})

describe('repo Git diffs on a small auto-flat fixture', () => {
  let repo: string
  let server: ChildProcess
  let baseUrl: string
  let scoped: (path: string) => string
  let workingTree: ChangedFiles
  let commit: ChangedFiles & { hash: string }

  beforeAll(async () => {
    const fixture = await bootFixture('small', SMALL_FILES, SMALL_LINES)
    repo = fixture.repo
    server = fixture.server
    baseUrl = fixture.baseUrl
    scoped = fixture.scoped
    workingTree = await getJson<ChangedFiles>(`${baseUrl}/api/v1/repo/changes`)
    expect(workingTree.files.length).toBeGreaterThanOrEqual(SMALL_FILES)
    const log = await getJson<{ log: Array<{ hash: string }> }>(`${baseUrl}/api/v1/repo`)
    const hash = log.log[0]?.hash
    expect(hash).toBeTruthy()
    commit = {
      hash: hash!,
      ...(await getJson<ChangedFiles>(`${baseUrl}/api/v1/repo/commit/${hash}?structured=1`)),
    }
    expect(commit.files.length).toBe(SMALL_FILES)
  }, 120_000)

  afterAll(() => {
    stopFixture(server, repo)
  })

  it('working-tree totals, tree paths, and mounted cards match the API', () => {
    browser.goto(`${baseUrl}${scoped('/git')}`)
    const { virtualized } = assertDiffCoverage(browser, workingTree.files, { tree: true })
    expect(virtualized).toBe(false)
  }, 120_000)

  it('selected-commit totals and mounted cards match the API', () => {
    browser.goto(`${baseUrl}${scoped(`/git/commits/${commit.hash}`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="commit-meta"]') !== null`)
    const { virtualized } = assertDiffCoverage(browser, commit.files, { tree: false })
    expect(virtualized).toBe(false)
  }, 120_000)
})

describe('repo Git diffs on a large auto-virtual fixture', () => {
  let repo: string
  let server: ChildProcess
  let baseUrl: string
  let scoped: (path: string) => string
  let workingTree: ChangedFiles
  let commit: ChangedFiles & { hash: string }

  beforeAll(async () => {
    const fixture = await bootFixture('large', LARGE_FILES, LARGE_LINES)
    repo = fixture.repo
    server = fixture.server
    baseUrl = fixture.baseUrl
    scoped = fixture.scoped
    workingTree = await getJson<ChangedFiles>(`${baseUrl}/api/v1/repo/changes`)
    expect(workingTree.files.length).toBeGreaterThanOrEqual(LARGE_FILES)
    const log = await getJson<{ log: Array<{ hash: string }> }>(`${baseUrl}/api/v1/repo`)
    const hash = log.log[0]?.hash
    expect(hash).toBeTruthy()
    commit = {
      hash: hash!,
      ...(await getJson<ChangedFiles>(`${baseUrl}/api/v1/repo/commit/${hash}?structured=1`)),
    }
    expect(commit.files.length).toBe(LARGE_FILES)
  }, 120_000)

  afterAll(() => {
    stopFixture(server, repo)
  })

  it('working-tree totals and tree match the API; last off-screen file mounts', () => {
    browser.goto(`${baseUrl}${scoped('/git')}`)
    const { virtualized } = assertDiffCoverage(browser, workingTree.files, { tree: true, expectWindow: true })
    expect(virtualized).toBe(true)
  }, 120_000)

  it('selected-commit totals match the API without mounting every file', () => {
    browser.goto(`${baseUrl}${scoped(`/git/commits/${commit.hash}`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="commit-meta"]') !== null`)
    const { virtualized } = assertDiffCoverage(browser, commit.files, { tree: false, expectWindow: true })
    expect(virtualized).toBe(true)
  }, 120_000)
})
