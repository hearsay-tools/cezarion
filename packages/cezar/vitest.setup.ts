import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach } from 'vitest'

// Cezar task worktrees pin TMPDIR under the repo (`.ai/cezar/tmp/<runId>`). That
// makes `os.tmpdir()` land inside a git worktree, so suites that mkdtemp a
// "non-repo" path still resolve `git rev-parse --show-toplevel` to the host
// project. Pin temp to a real OS temp sandbox first, before anything else that
// calls `tmpdir()`.
// Prefer a fixed OS temp root over the inherited TMPDIR (which may be inside
// the repo). On Windows fall back through the usual TEMP/TMP spellings.
const osTempRoot = process.platform === 'win32'
  ? (process.env.SystemRoot ? join(process.env.SystemRoot, 'Temp') : 'C:\\Temp')
  : '/tmp'
const sandboxTemp = mkdtempSync(join(realpathSync(osTempRoot), 'cez-vitest-tmp-'))
const sandboxGitConfig = join(sandboxTemp, 'gitconfig')
writeFileSync(sandboxGitConfig, '')
process.env.TMPDIR = sandboxTemp
process.env.TMP = sandboxTemp
process.env.TEMP = sandboxTemp

// Nothing in this suite may write to the developer's own `~/.cezar`. Most cases pin
// `CEZ_HOME` themselves, but the pin is one global for the whole worker and their
// `afterEach` deletes it — so a write that outlives its test (a timeout is enough)
// used to resolve the real home and replace the project registry with the fixture's.
//
// This file removes the unpinned state entirely: every worker gets a sandbox home,
// and the pin is restored around every test, so a case that drops it can only leave
// the NEXT write pointed at the sandbox. A test that wants the unpinned default
// deletes the variable inside its own body (see `src/paths.test.ts`) — that still
// works, because this hook runs after the test, not during it. The write guard in
// `assertCezarHomeWriteIsSandboxed` catches whatever still slips through.
const sandboxHome = mkdtempSync(join(realpathSync(tmpdir()), 'cez-vitest-home-'))

const pinSandboxHome = (): void => {
  if (!process.env.CEZ_HOME) process.env.CEZ_HOME = sandboxHome
}

// Cezar task runners inject host wrappers (`CEZ_CLAUDE_BIN=…/cezar-claude`,
// `CEZ_PI_BIN=…/cezar-pi`, `CEZ_REMOTE=1`). Provider/status suites assume bare
// `claude`/`pi` executables and local mode unless a case opts in — clear the
// host values so a suite run inside a task worktree matches CI. Cases that set
// an override themselves still win: this hook runs before theirs.
const HOST_BIN_AND_MODE_KEYS = [
  'CEZ_CLAUDE_BIN',
  'CEZ_CODEX_BIN',
  'CEZ_OPENCODE_BIN',
  'CEZ_PI_BIN',
  'CEZ_REMOTE',
] as const

const clearHostBinAndModeOverrides = (): void => {
  for (const key of HOST_BIN_AND_MODE_KEYS) delete process.env[key]
}

const pinSandboxTemp = (): void => {
  process.env.TMPDIR = sandboxTemp
  process.env.TMP = sandboxTemp
  process.env.TEMP = sandboxTemp
}

const pinGitEnvironment = (): void => {
  process.env.GIT_CONFIG_GLOBAL = sandboxGitConfig
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_AUTHOR_NAME = 'Cezar Tests'
  process.env.GIT_AUTHOR_EMAIL = 'tests@cezar.invalid'
  process.env.GIT_COMMITTER_NAME = 'Cezar Tests'
  process.env.GIT_COMMITTER_EMAIL = 'tests@cezar.invalid'
}

pinSandboxTemp()
pinSandboxHome()
pinGitEnvironment()
clearHostBinAndModeOverrides()
beforeEach(() => {
  pinSandboxTemp()
  pinSandboxHome()
  pinGitEnvironment()
  clearHostBinAndModeOverrides()
})
// Registered before any suite's own hooks, so vitest runs it last on the way out —
// after a case's `afterEach` has deleted the pin / restored a host override.
afterEach(() => {
  pinSandboxTemp()
  pinSandboxHome()
  pinGitEnvironment()
  clearHostBinAndModeOverrides()
})
afterAll(() => {
  rmSync(sandboxHome, { recursive: true, force: true })
  rmSync(sandboxTemp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})
