import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTestSandbox } from './test-sandbox.mjs'

// node:test suites do not load Vitest setup. Pin Git before any test module or
// child process starts, so fixtures never inherit the developer's Git config.
// The sandbox goes when the process exits or ends on a signal: the browser e2e
// config loads this file in Vitest fork workers, which Vitest stops with SIGTERM
// (hearsay-tools/cezarion#1394). A killed process's sandbox goes when the next one starts.
const sandbox = createTestSandbox('cez-test-git-')
const globalConfig = join(sandbox, 'gitconfig')
// No automatic maintenance (hearsay-tools/cezarion#1279). After a commit or fetch,
// Git 2.54+ repacks in a detached process once `objects/17/` holds two loose
// objects, and that repack deletes loose objects while a test still clones,
// copies or removes the repository. packages/cezar/vitest.setup.ts and
// packages/web/vitest.setup.ts write the same two settings.
writeFileSync(globalConfig, '[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n')

process.env.GIT_CONFIG_GLOBAL = globalConfig
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_AUTHOR_NAME = 'Cezar Tests'
process.env.GIT_AUTHOR_EMAIL = 'tests@cezar.invalid'
process.env.GIT_COMMITTER_NAME = 'Cezar Tests'
process.env.GIT_COMMITTER_EMAIL = 'tests@cezar.invalid'

// Nor may they inherit a cezar task session's context: the dry-run mocks append to
// CEZ_HANDOFF_FILE, and a CLI under test would reach the live task's delegation API and
// tool socket (hearsay-tools/cezarion#953). packages/cezar/vitest.setup.ts clears the same keys.
for (const key of [
  'CEZ_ARTIFACTS_DIR', 'CEZ_HANDOFF_FILE', 'CEZ_TODOS_FILE', 'CEZ_TASK_ID', 'CEZ_PROJECT_ROOT',
  'CEZ_DELEGATION_URL', 'CEZ_DELEGATION_TOKEN', 'CEZ_TOOL_SOCKET', 'CEZ_TOOL_TOKEN',
]) delete process.env[key]
