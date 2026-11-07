import './test-git-env.mjs'
import { join } from 'node:path'
import { createTestSandbox } from './test-sandbox.mjs'
import { ensureTestInstallMarker } from './test-install-marker.mjs'

// Only node:test entry points load this file. Browser workers keep their host
// home so the browser can find its installed runtime and credentials.
const sandbox = createTestSandbox('cez-node-test-home-')
for (const key of Object.keys(process.env)) {
  if (key.startsWith('CEZ_')) delete process.env[key]
}
process.env.CEZ_HOME = join(sandbox, '.cezar')
ensureTestInstallMarker(process.env.CEZ_HOME)
process.env.HOME = sandbox
process.env.USERPROFILE = sandbox
// Match AGENT_HOME_KEYS in packages/cezar/vitest.setup.ts. With these overrides
// removed, vendor defaults resolve below the pinned HOME.
for (const key of [
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'PI_CONFIG_DIR',
  'OMP_PROFILE', 'PI_PROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CURSOR_CONFIG_DIR',
]) delete process.env[key]
