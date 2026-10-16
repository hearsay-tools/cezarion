import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Mirrored by CHROME_SINGLETON_OVERHEAD and DARWIN_UNIX_SOCKET_MAX in
// packages/cezar/src/runs/agent-tmpdir.ts, which size every task's TMPDIR
// (hearsay-tools/cezarion#1022); the published package cannot import this
// script, so packages/cezar/test/unit/resolve-browser-launch.test.ts asserts
// the two agree. Change both together.
export const CHROME_SINGLETON_OVERHEAD = '/org.chromium.Chromium.XXXXXX/SingletonSocket'.length;
export const UNIX_SOCKET_MAX = 107;
export const DARWIN_UNIX_SOCKET_MAX = 103;

const CONTAINER_CGROUP = /docker|lxc|kubepods|containerd|podman|libpod|nspawn/i;

function readOptional(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

export function readHostSignals() {
  return {
    dockerenv: existsSync('/.dockerenv'),
    containerenv: existsSync('/run/.containerenv'),
    containerEnv: process.env.container || '',
    kubernetesServiceHost: process.env.KUBERNETES_SERVICE_HOST || '',
    cgroup: readOptional('/proc/1/cgroup'),
  };
}

export function isContainerHost(host = {}) {
  if (host.dockerenv || host.containerenv) return true;
  if (host.containerEnv) return true;
  if (host.kubernetesServiceHost) return true;
  if (host.cgroup && CONTAINER_CGROUP.test(host.cgroup)) return true;
  return false;
}

// Whether Chrome's SingletonSocket under this env's temp dir would overflow
// sun_path. Each process that launches Chrome asks it about its OWN env: the
// answer test-env-up.sh saved belongs to whoever booted the shared env
// (hearsay-tools/cezarion#1090).
export function tmpdirExceedsSocketBudget(env = process.env, platform = process.platform, unixSocketMax) {
  if (platform === 'win32') return false;
  const tmp = env.TMPDIR || env.TMP || env.TEMP || '';
  if (!tmp) return false;
  const max = unixSocketMax ?? (platform === 'darwin' ? DARWIN_UNIX_SOCKET_MAX : UNIX_SOCKET_MAX);
  return Buffer.byteLength(tmp) + CHROME_SINGLETON_OVERHEAD > max;
}

export function resolveBrowserLaunch(input = {}) {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const host = input.host ?? readHostSignals();
  const fallbackTmp = input.fallbackTmp ?? (
    platform === 'win32' ? (env.TEMP || env.TMP || env.TMPDIR || 'C:\\Windows\\Temp') : '/tmp'
  );
  const inContainer = isContainerHost(host);
  const launchArgs = inContainer ? ['--no-sandbox'] : [];
  const runtimeEnv = {};
  if (tmpdirExceedsSocketBudget(env, platform, input.unixSocketMax)) {
    runtimeEnv.TMPDIR = fallbackTmp;
    runtimeEnv.TMP = fallbackTmp;
    runtimeEnv.TEMP = fallbackTmp;
  }
  return {
    inContainer,
    launchArgs,
    runtimeEnv,
    namespace: env.E2E_BROWSER_NAMESPACE || 'cez-e2e',
  };
}

export function buildAgentBrowserArgv({ namespace, launchArgs = [], session, command = [] } = {}) {
  const argv = [];
  if (namespace) argv.push('--namespace', namespace);
  if (launchArgs.length) argv.push('--args', launchArgs.join(','));
  if (session) argv.push('--session', session);
  argv.push(...command);
  return argv;
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    // ESM resolves symlinks, including macOS /var → /private/var, before setting
    // import.meta.url. Compare the entry on the same basis.
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMain()) {
  process.stdout.write(`${JSON.stringify(resolveBrowserLaunch())}\n`);
}
