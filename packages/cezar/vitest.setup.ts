import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach } from 'vitest'
import { strictRunExits, throwRunExitViolations } from './src/workflows/run-states.ts'
import { installOutboundGuard, throwOutboundRefusals } from './src/test-outbound-guard.testkit.ts'

import { createTestSandbox, linkSharedOmpNatives, removeTestSandboxes } from '../../scripts/test-sandbox.mjs'

// Test files start from shipped defaults, not the parent cockpit's flags or
// task context (hearsay-tools/cezarion#1517). Scrub once before sandbox pins:
// beforeAll and test bodies may then supply their own CEZ_* values. Keep the
// narrower per-test cleanup below so existing file-level fixtures still work.
for (const key of Object.keys(process.env)) {
  if (key.toUpperCase().startsWith('CEZ_')) delete process.env[key]
}

// Cezar task worktrees pin TMPDIR under the repo (`.ai/cezar/tmp/<runId>`). That
// makes `os.tmpdir()` land inside a git worktree, so suites that mkdtemp a
// "non-repo" path still resolve `git rev-parse --show-toplevel` to the host
// project. Pin temp to a real OS temp sandbox first, before anything else that
// calls `tmpdir()`.
// `createTestSandbox` prefers a fixed OS temp root over the inherited TMPDIR
// (which may be inside the repo). The sandbox names this worker, so the next
// worker removes it when this one dies before `afterAll`; a signal removes it
// before the worker ends (hearsay-tools/cezarion#1395). The name keeps its
// length: the agent temp fallback under it must fit the unix socket budget.
const sandboxTemp = createTestSandbox('cez-vitest-tmp-')
const sandboxGitConfig = join(sandboxTemp, 'gitconfig')
// No automatic maintenance (hearsay-tools/cezarion#1279): Git 2.54+ repacks in a
// detached process after a commit or fetch, and that repack deletes loose objects
// while a test still clones, copies or removes the repository. Same settings as
// scripts/test-git-env.mjs.
writeFileSync(sandboxGitConfig, '[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n')
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
// Both homes live inside `sandboxTemp`, so its exit, signal and dead-owner cleanup removes them too.
const sandboxHome = mkdtempSync(join(sandboxTemp, 'cez-vitest-home-'))

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
const sandboxUserHome = mkdtempSync(join(sandboxTemp, 'cez-vitest-user-home-'))
// A test that starts the real omp would unpack its 373 MB native addon into this
// home. Every sandbox home reads it from one shared cache instead
// (hearsay-tools/cezarion#1911); without that cache omp unpacks here, as before.
linkSharedOmpNatives(sandboxUserHome)

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
  'CEZ_VOICE', // Keep voice mode opt-in for each test (hearsay-tools/cezarion#1470).
  'CEZ_SINGLE_PROJECT', // Keep multi-project mode unless the test opts into one project.
  'CEZ_HIDE_TOKEN_METRICS', // Keep token and cost metrics shown unless the test hides them.
  'CEZ_HIDE_TOKEN_USAGE',
  'CEZ_HIDE_COST',
] as const

const clearHostBinAndModeOverrides = (): void => {
  for (const key of HOST_BIN_AND_MODE_KEYS) delete process.env[key]
}

// The other flags `resolveCapabilities` reads. Like the task keys below, these are
// cleared once per test file, not per test: `system-prompt.test.ts` sets both in
// `beforeAll` for the whole file. `TYPESAFE_API_KEY` stays: it turns nothing on
// without CEZ_VOICE, which the list above clears.
const HOST_FILE_MODE_KEYS = [
  'CEZ_FOLLOWUPS', // Keep the follow-up inbox opt-in for each file.
  'CEZ_DRY_RUN', // Run the real runner paths unless the file opts into the mocks.
] as const

for (const key of HOST_FILE_MODE_KEYS) delete process.env[key]

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
// One failed removal no longer skips the next one (hearsay-tools/cezarion#1395);
// the helper keeps the three retries for late child-process writes.
afterAll(() => removeTestSandboxes([sandboxHome, sandboxUserHome, sandboxTemp]))
// A run status write the run state table does not declare throws, and fails the test it happens
// in even when run.ts caught the throw (hearsay-tools/cezarion#1804). Production never checks.
strictRunExits()
afterEach(throwRunExitViolations)
// No test may reach a server it did not start (hearsay-tools/cezarion#2367): a mutant that ran the
// real cockpit discovery instead of the injected one started tasks on the live cockpit. The guard
// refuses the connection before transport, and this hook fails the test that made it.
installOutboundGuard()
afterEach(throwOutboundRefusals)
