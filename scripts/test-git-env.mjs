import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// node:test suites do not load Vitest setup. Pin Git before any test module or
// child process starts, so fixtures never inherit the developer's Git config.
const osTempRoot = process.platform === 'win32'
  ? (process.env.SystemRoot ? join(process.env.SystemRoot, 'Temp') : 'C:\\Temp')
  : '/tmp'
const sandbox = mkdtempSync(join(realpathSync(osTempRoot), 'cez-test-git-'))
const globalConfig = join(sandbox, 'gitconfig')
writeFileSync(globalConfig, '')

process.env.GIT_CONFIG_GLOBAL = globalConfig
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_AUTHOR_NAME = 'Cezar Tests'
process.env.GIT_AUTHOR_EMAIL = 'tests@cezar.invalid'
process.env.GIT_COMMITTER_NAME = 'Cezar Tests'
process.env.GIT_COMMITTER_EMAIL = 'tests@cezar.invalid'

process.once('exit', () => rmSync(sandbox, { recursive: true, force: true }))
