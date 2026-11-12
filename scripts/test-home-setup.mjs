import { join } from 'node:path'
import { ensureTestInstallMarker } from './test-install-marker.mjs'

const AGENT_HOME_KEYS = [
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'PI_CONFIG_DIR',
  'OMP_PROFILE', 'PI_PROFILE', 'CURSOR_CONFIG_DIR',
]

/** Script-only setup: never import product modules before test-file mocks. */
export function configureTestHome({ userHome, squawkHome = join(userHome, '.cezar'), keepHostHome = false }, env = process.env) {
  // Scrub once per file/process. Tests may set their own flags in beforeAll.
  for (const key of Object.keys(env)) {
    if (/^(?:CEZ|HSQ)_/.test(key.toUpperCase())) delete env[key]
  }
  const select = root => {
    if (root === undefined) { delete env.CEZ_HOME; delete env.HSQ_HOME }
    else env.CEZ_HOME = env.HSQ_HOME = root
  }
  const pinHome = () => {
    if (!env.CEZ_HOME) {
      ensureTestInstallMarker(squawkHome)
      select(squawkHome)
    }
  }
  const pinUserHome = () => {
    // Browser workers need host HOME/USERPROFILE for their installed runtime.
    // Every other home override still points into their private sandbox.
    if (!keepHostHome) env.HOME = env.USERPROFILE = userHome
    for (const key of AGENT_HOME_KEYS) delete env[key]
    env.HSQ_HOME = env.CEZ_HOME || squawkHome
    env.APPDATA = join(userHome, 'AppData', 'Roaming')
    env.LOCALAPPDATA = join(userHome, 'AppData', 'Local')
    env.XDG_CONFIG_HOME = join(userHome, '.config')
    env.XDG_DATA_HOME = join(userHome, '.local', 'share')
    env.XDG_STATE_HOME = join(userHome, '.local', 'state')
    env.XDG_CACHE_HOME = join(userHome, '.cache')
    delete env.XDG_RUNTIME_DIR
  }
  pinHome()
  pinUserHome()
  return { select, pinHome, pinUserHome }
}
