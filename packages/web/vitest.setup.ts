import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach } from 'vitest'

import { highlighterSettledForTests } from '@/lib/highlighter'

// Web unit tests also create Git fixtures. Keep those Git calls independent of
// the developer's global and system config, just like the server suite.
const osTempRoot = process.platform === 'win32'
  ? (process.env.SystemRoot ? join(process.env.SystemRoot, 'Temp') : 'C:\\Temp')
  : '/tmp'
const gitSandbox = mkdtempSync(join(realpathSync(osTempRoot), 'cez-web-test-git-'))
const gitConfig = join(gitSandbox, 'gitconfig')
writeFileSync(gitConfig, '')
const pinGitEnvironment = () => {
  process.env.GIT_CONFIG_GLOBAL = gitConfig
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_AUTHOR_NAME = 'Cezar Tests'
  process.env.GIT_AUTHOR_EMAIL = 'tests@cezar.invalid'
  process.env.GIT_COMMITTER_NAME = 'Cezar Tests'
  process.env.GIT_COMMITTER_EMAIL = 'tests@cezar.invalid'
}
pinGitEnvironment()
beforeEach(pinGitEnvironment)
afterEach(pinGitEnvironment)
afterAll(() => rmSync(gitSandbox, { recursive: true, force: true }))

// Drain any cold Shiki load a case started so it cannot run into the next case's waitFor
// budget (#601; measured 223ms vs 62ms on the Files-tab snapshot case). Free when nothing
// highlighted: settling an empty list resolves on the next microtask.
afterEach(() => highlighterSettledForTests())
