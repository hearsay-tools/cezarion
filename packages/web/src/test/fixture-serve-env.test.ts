// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
it('removes inherited and caller-supplied Git redirection from both discovery and child environment', () => {
  const foreign = gitRoot(), path = root()
  vi.stubEnv('GIT_DIR', join(foreign, '.git'))
  vi.stubEnv('GIT_WORK_TREE', foreign)
  vi.stubEnv('GIT_CONFIG_COUNT', '1')
  vi.stubEnv('GIT_CONFIG_KEY_0', 'core.worktree')
  vi.stubEnv('GIT_CONFIG_VALUE_0', foreign)
  const env = fixtureServeEnv(path, { GIT_COMMON_DIR: join(foreign, '.git') })
  expect(Object.keys(env).filter(key => key.startsWith('GIT_'))).toEqual([])
  expect(env.CEZ_HOME).toBe(join(realpathSync(path), '.cez-home'))
})
it('refuses uncertain discovery instead of treating it as a non-Git fixture', () => {
  expect(() => fixtureServeEnv(join(root(), 'missing'))).toThrow()
  expect(() => fixtureServeEnv(root(), { PATH: '' })).toThrow(/verify fixture/)
})
