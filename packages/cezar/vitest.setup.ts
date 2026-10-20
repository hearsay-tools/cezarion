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

// Nor may a test resolve the developer's own agent folders (hearsay-tools/cezarion#1361).
// `agentHomePaths()` and the default agent account read `HOME` and each agent's own
// variable, so two tests passed locally only because `~/.pi/agent` and `~/.omp/agent`
// existed, and failed on a fresh CI runner. Every worker gets an empty user home, the
// variables that move an agent home are cleared, and both are restored around every test.
// A test that needs a populated home sets its own in its `beforeEach` (see the omp block
// in `src/server/agent-profiles-api.test.ts`): this hook runs before theirs.
const sandboxUserHome = mkdtempSync(join(realpathSync(tmpdir()), 'cez-vitest-user-home-'))

const AGENT_HOME_KEYS = [
  'CLAUDE_CONFIG_DIR', // Claude Code's home.
  'CODEX_HOME', // Codex's home.
  'PI_CODING_AGENT_DIR', // Pi's agent folder, and omp's when no profile is selected.
  'PI_CONFIG_DIR', // omp's root folder under HOME.
  'OMP_PROFILE', // Selects an omp profile, which moves the default omp account.
  'PI_PROFILE', // omp reads it when OMP_PROFILE is unset.
  'XDG_CONFIG_HOME', // OpenCode's config, and Cursor's on Linux.
  'XDG_DATA_HOME', // OpenCode's credentials.
  'CURSOR_CONFIG_DIR', // Cursor's config.
] as const

const pinSandboxUserHome = (): void => {
  process.env.HOME = sandboxUserHome
  process.env.USERPROFILE = sandboxUserHome // `os.homedir()` reads this one on Windows.
  for (const key of AGENT_HOME_KEYS) delete process.env[key]
}

// Cezar tasks inherit host wrappers, deployment mode and feature flags. Suites
// assume default executables, local mode and opt-in features off — clear the
// host values so a suite run inside a task worktree matches CI. Cases that set
// an override themselves still win: this hook runs before theirs.
const HOST_BIN_AND_MODE_KEYS = [
  'CEZ_CLAUDE_BIN', // Use the default Claude executable, not the host wrapper.
  'CEZ_CODEX_BIN', // Use the default Codex executable, not the host wrapper.
  'CEZ_OPENCODE_BIN', // Use the default OpenCode executable, not the host wrapper.
  'CEZ_PI_BIN', // Use the default Pi executable, not the host wrapper.
  'CEZ_OMP_BIN', // Use the default OMP executable, not the host wrapper.
  'CEZ_REMOTE', // Keep local-mode capabilities unless the test opts into hosted mode.
  'CEZ_AUTOMATIONS', // Keep automation routes and scheduling opt-in for each test.
  'CEZ_PREVIEW', // Keep preview capabilities and tool registration opt-in for each test.
] as const

const clearHostBinAndModeOverrides = (): void => {
  for (const key of HOST_BIN_AND_MODE_KEYS) delete process.env[key]
}

// A task session's own context (hearsay-tools/cezarion#953). Inherited, it pointed the
// suite at the LIVE task: the mocks appended to its handoff file, and fixtures could reach
// its delegation API and tool socket. Unlike the keys above, these are cleared once per
// test file, not per test, so a suite that simulates a nested cezar in `beforeAll`
// (`system-prompt.test.ts` sets CEZ_TODOS_FILE) keeps its value.
const HOST_TASK_KEYS = [
  'CEZ_ARTIFACTS_DIR',
  'CEZ_HANDOFF_FILE',
  'CEZ_TODOS_FILE',
  'CEZ_TASK_ID',
  'CEZ_PROJECT_ROOT', // Set for worktree setup commands.
  'CEZ_DELEGATION_URL',
  'CEZ_DELEGATION_TOKEN',
  'CEZ_TOOL_SOCKET',
  'CEZ_TOOL_TOKEN',
] as const

for (const key of HOST_TASK_KEYS) delete process.env[key]

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
pinSandboxUserHome()
pinGitEnvironment()
clearHostBinAndModeOverrides()
beforeEach(() => {
  pinSandboxTemp()
  pinSandboxHome()
  pinSandboxUserHome()
  pinGitEnvironment()
  clearHostBinAndModeOverrides()
})
// Registered before any suite's own hooks, so vitest runs it last on the way out —
// after a case's `afterEach` has deleted the pin / restored a host override.
afterEach(() => {
  pinSandboxTemp()
  pinSandboxHome()
  pinSandboxUserHome()
  pinGitEnvironment()
  clearHostBinAndModeOverrides()
})
afterAll(() => {
  rmSync(sandboxHome, { recursive: true, force: true })
  rmSync(sandboxUserHome, { recursive: true, force: true })
  rmSync(sandboxTemp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})
