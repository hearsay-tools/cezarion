// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fixtureServeEnv } from '../../e2e/agent-browser'

const roots: string[] = []
function root() {
  const path = mkdtempSync(join(tmpdir(), 'cez-fixture-boundary-'))
  roots.push(path)
  return path
}
afterEach(() => { vi.unstubAllEnvs(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
function gitRoot() {
  const path = root()
  execFileSync('git', ['init', '-q', path])
  return path
}

it('names this worker in its Git sandbox, so the next worker removes it if this one dies (hearsay-tools/cezarion#1395)', () => {
  const sandbox = dirname(process.env.GIT_CONFIG_GLOBAL!)
  expect(basename(sandbox)).toMatch(/^cez-web-test-git-/)
  expect(JSON.parse(readFileSync(join(sandbox, '.cez-test-owner'), 'utf8'))).toEqual({ pid: process.pid, host: hostname() })
})

it('uses a sandbox Git config with automatic maintenance off and fixed identity in web tests', () => {
  const path = gitRoot()
  // Only what vitest.setup.ts writes, nothing from the host.
  expect(execFileSync('git', ['-C', path, 'config', '--global', '--list'], { encoding: 'utf8' }).trim().split('\n'))
    .toEqual(['gc.auto=0', 'maintenance.auto=false'])
  expect(process.env.GIT_CONFIG_NOSYSTEM).toBe('1')
  expect(execFileSync('git', ['-C', path, 'var', 'GIT_AUTHOR_IDENT'], { encoding: 'utf8' }))
    .toMatch(/^Cezar Tests <tests@cezar.invalid> /)
})
// hearsay-tools/cezarion#1279: Git 2.54+ maintenance repacks in the background and deletes
// loose objects while a test still clones or removes the repository.
it('starts no automatic maintenance after a web fixture commit', () => {
  const commit = spawnSync('git', ['-C', gitRoot(), 'commit', '--allow-empty', '-qm', 'traced'], {
    encoding: 'utf8', env: { ...process.env, GIT_TRACE: '1' },
  })
  expect(commit.status, commit.stderr).toBe(0)
  expect(commit.stderr).not.toMatch(/\b(?:maintenance run|gc) --auto\b/)
})

// These exercise only the pre-spawn environment helper: no Cezar process is ever started.
it('rejects a non-Git fixture below an ambient Git repository before a server can start', () => {
  const parent = gitRoot(), child = join(parent, 'temporary-fixture')
  mkdirSync(child)
  expect(() => fixtureServeEnv(child)).toThrow(/outside fixture/)
})
it('accepts a fixture that owns its Git root, including a canonical symlink alias', () => {
  const path = gitRoot(), alias = join(root(), 'alias')
  symlinkSync(path, alias, 'dir')
  expect(fixtureServeEnv(alias).CEZ_HOME).toBe(join(realpathSync(path), '.cez-home'))
})
it('accepts a genuinely non-Git fixture and always pins its home', () => {
  const path = root()
  expect(fixtureServeEnv(path, { CEZ_HOME: '/unowned/home' }).CEZ_HOME).toBe(join(realpathSync(path), '.cez-home'))
})
it('accepts a non-Git fixture when TMPDIR is inside an ambient Git checkout', () => {
  const ambient = gitRoot()
  const nestedTmp = join(ambient, 'tmp')
  mkdirSync(nestedTmp)
  vi.stubEnv('TMPDIR', nestedTmp)
  vi.stubEnv('TMP', nestedTmp)
  vi.stubEnv('TEMP', nestedTmp)
  const path = mkdtempSync(join(nestedTmp, 'cez-fixture-boundary-'))
  const env = fixtureServeEnv(path)
  expect(env.CEZ_HOME).toBe(join(realpathSync(path), '.cez-home'))
  expect(env.GIT_CEILING_DIRECTORIES).toBe(realpathSync(nestedTmp))
  expect(env.GIT_DIR).toBeUndefined()
  expect(env.GIT_WORK_TREE).toBeUndefined()
  expect(env.GIT_COMMON_DIR).toBeUndefined()
})
it('removes inherited and caller-supplied Git redirection from both discovery and child environment', () => {
  const foreign = gitRoot(), path = root()
  vi.stubEnv('GIT_DIR', join(foreign, '.git'))
  vi.stubEnv('GIT_WORK_TREE', foreign)
  vi.stubEnv('GIT_CONFIG_COUNT', '1')
  vi.stubEnv('GIT_CONFIG_KEY_0', 'core.worktree')
  vi.stubEnv('GIT_CONFIG_VALUE_0', foreign)
  const env = fixtureServeEnv(path, { GIT_COMMON_DIR: join(foreign, '.git') })
  expect(Object.keys(env).filter(key => key.startsWith('GIT_'))).toEqual([
    'GIT_CEILING_DIRECTORIES',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
  ])
  expect(readFileSync(env.GIT_CONFIG_GLOBAL!, 'utf8')).toBe('')
  expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
  expect(env.GIT_CEILING_DIRECTORIES).toBe(realpathSync(tmpdir()))
  expect(env.CEZ_HOME).toBe(join(realpathSync(path), '.cez-home'))
})
// hearsay-tools/cezarion#1104: a Git sandbox made per import, removed only on `exit`, outlived every
// Vitest worker (10,126 of them in /tmp on one host). Fixtures share the shared env's stable file.
it('points every fixture at the shared test env Git config and keeps it empty', () => {
  const config = join(import.meta.dirname, '../../../../.ai/qa/gitconfig')
  const first = fixtureServeEnv(root())
  execFileSync('git', ['config', '--global', 'cez.stray', 'true'], { env: first })
  const second = fixtureServeEnv(root())
  expect([first.GIT_CONFIG_GLOBAL, second.GIT_CONFIG_GLOBAL]).toEqual([config, config])
  expect(readFileSync(config, 'utf8')).toBe('')
})
it('refuses uncertain discovery instead of treating it as a non-Git fixture', () => {
  expect(() => fixtureServeEnv(join(root(), 'missing'))).toThrow()
  expect(() => fixtureServeEnv(root(), { PATH: '' })).toThrow(/verify fixture/)
})
// #358: a hosted parent exports CEZ_REMOTE=1; local fixtures must not inherit it.
it('defaults to local mode when the parent exports CEZ_REMOTE=1', () => {
  vi.stubEnv('CEZ_REMOTE', '1')
  expect(fixtureServeEnv(root()).CEZ_REMOTE).toBe('0')
})
it('allows a fixture to request hosted mode explicitly', () => {
  vi.stubEnv('CEZ_REMOTE', '0')
  expect(fixtureServeEnv(root(), { CEZ_REMOTE: '1' }).CEZ_REMOTE).toBe('1')
})
// hearsay-tools/cezarion#1045: the live cockpit's opt-ins reach an agent's shell; a fixture
// cockpit must boot with every feature off unless the spec asks for it.
it('drops ambient CEZ_* opt-in flags and cockpit plumbing from the fixture environment', () => {
  for (const name of ['CEZ_PREVIEW', 'CEZ_PREVIEW_NO_SANDBOX', 'CEZ_AUTOMATIONS', 'CEZ_FOLLOWUPS', 'CEZ_SINGLE_PROJECT']) vi.stubEnv(name, '1')
  vi.stubEnv('CEZ_TASK_ID', 'ambient-task')
  const env = fixtureServeEnv(root())
  expect(Object.keys(env).filter(key => key.startsWith('CEZ_')).sort())
    .toEqual(['CEZ_DRY_RUN', 'CEZ_HOME', 'CEZ_REMOTE'])
})
it('keeps the CEZ_* flags a spec passes explicitly', () => {
  vi.stubEnv('CEZ_PREVIEW', '1')
  vi.stubEnv('CEZ_AUTOMATIONS', '1')
  const env = fixtureServeEnv(root(), { CEZ_AUTOMATIONS: '1', CEZ_FOLLOWUPS: '1' })
  expect(env.CEZ_AUTOMATIONS).toBe('1')
  expect(env.CEZ_FOLLOWUPS).toBe('1')
  expect(env.CEZ_PREVIEW).toBeUndefined()
})

it('pins a fresh server HOME after caller overrides without changing the invoking HOME', () => {
  const invokingHome = root(), path = gitRoot()
  vi.stubEnv('HOME', invokingHome)
  vi.stubEnv('USERPROFILE', invokingHome)
  const home = join(realpathSync(path), '.server-home')
  mkdirSync(home)
  writeFileSync(join(home, 'stale-skill'), 'from an earlier boot')
  const env = fixtureServeEnv(path, { HOME: invokingHome, USERPROFILE: invokingHome })
  expect(env.HOME).toBe(home)
  expect(env.USERPROFILE).toBe(home)
  expect(execFileSync(process.execPath, ['-p', 'require("node:os").homedir()'], { env, encoding: 'utf8' }).trim()).toBe(home)
  expect(readdirSync(home)).toEqual([])
  expect(process.env.HOME).toBe(invokingHome)
  expect(process.env.USERPROFILE).toBe(invokingHome)
  expect(execFileSync('git', ['-C', path, 'var', 'GIT_AUTHOR_IDENT'], { env, encoding: 'utf8' }))
    .toMatch(/^Cezar Tests <tests@cezar.invalid> /)
})
