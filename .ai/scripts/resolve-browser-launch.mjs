import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function resolveBrowserLaunch(input = {}) {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const host = input.host ?? readHostSignals();
  const unixSocketMax = input.unixSocketMax ?? (platform === 'darwin' ? DARWIN_UNIX_SOCKET_MAX : UNIX_SOCKET_MAX);
  const fallbackTmp = input.fallbackTmp ?? (
    platform === 'win32' ? (env.TEMP || env.TMP || env.TMPDIR || 'C:\\Windows\\Temp') : '/tmp'
  );
  const inContainer = isContainerHost(host);
  const launchArgs = inContainer ? ['--no-sandbox'] : [];
  const currentTmp = env.TMPDIR || env.TMP || env.TEMP || '';
  const runtimeEnv = {};
  if (platform !== 'win32' && currentTmp && currentTmp.length + CHROME_SINGLETON_OVERHEAD > unixSocketMax) {
    runtimeEnv.TMPDIR = fallbackTmp;
    runtimeEnv.TMP = fallbackTmp;
    runtimeEnv.TEMP = fallbackTmp;
  }
  return {
    inContainer,
    launchArgs,
    runtimeEnv,
    namespace: 'cez-e2e',
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
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
}

if (isMain()) {
  process.stdout.write(`${JSON.stringify(resolveBrowserLaunch())}\n`);
}
