import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configure } from '@testing-library/react'
import { afterAll, afterEach, beforeEach } from 'vitest'

import { highlighterSettledForTests } from '@/lib/highlighter'

import { createTestSandbox, removeTestSandboxes } from '../../scripts/test-sandbox.mjs'

// Web unit tests also create Git fixtures. Keep those Git calls independent of
// the developer's global and system config, just like the server suite. The
// sandbox names this worker, so the next worker removes it when this one dies
// before `afterAll`; a signal removes it before the worker ends
// (hearsay-tools/cezarion#1395).
const gitSandbox = createTestSandbox('cez-web-test-git-')
const gitConfig = join(gitSandbox, 'gitconfig')
// No automatic maintenance (hearsay-tools/cezarion#1279): Git 2.54+ repacks in a
// detached process after a commit or fetch, and that repack deletes loose objects
// while a test still clones, copies or removes the repository. Same settings as
// scripts/test-git-env.mjs.
writeFileSync(gitConfig, '[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n')
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
afterAll(() => removeTestSandboxes([gitSandbox]))

// Drain any cold Shiki load a case started so it cannot run into the next case's waitFor
// budget (#601; measured 223ms vs 62ms on the Files-tab snapshot case). Free when nothing
// highlighted: settling an empty list resolves on the next microtask.
afterEach(() => highlighterSettledForTests())

// Testing Library's async utilities (waitFor, findBy*) give up after 1000 ms by default, which a
// loaded host overruns with no product change (hearsay-tools/cezarion#1055: two waits failed at
// load ~120 after 1.25 s and 1.7 s). Measured on the 24-core dev host: the label-colours wait
// in task-github-item.test.tsx took ~1.0 s at a 1-min load of ~135, and 0.8-2.6 s with the host
// oversubscribed to a load of ~235. 3000 ms covers that, and still ends 2 s before Vitest's
// 5000 ms per-test timeout so a genuine miss reports its assertion, not "Test timed out". A wait
// that asserts something does NOT happen within a window keeps its own short explicit timeout.
configure({ asyncUtilTimeout: 3_000 })
