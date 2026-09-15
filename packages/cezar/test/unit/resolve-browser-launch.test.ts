import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const resolverPath = resolve(import.meta.dirname, '../../../../.ai/scripts/resolve-browser-launch.mjs');
const {
  isContainerHost,
  resolveBrowserLaunch,
  buildAgentBrowserArgv,
  CHROME_SINGLETON_OVERHEAD,
} = await import(pathToFileURL(resolverPath).href);

const desktopHost = {
  dockerenv: false,
  containerenv: false,
  containerEnv: '',
  kubernetesServiceHost: '',
  cgroup: '0::/init.scope',
};

test('desktop Linux keeps sandboxed defaults and leaves a short TMPDIR alone', () => {
  const resolved = resolveBrowserLaunch({
    env: { TMPDIR: '/tmp' },
    host: desktopHost,
    platform: 'linux',
  });
  assert.equal(resolved.inContainer, false);
  assert.deepEqual(resolved.launchArgs, []);
  assert.deepEqual(resolved.runtimeEnv, {});
  assert.equal(resolved.namespace, 'cez-e2e');
});

test('Docker, Podman, Kubernetes and cgroup containers resolve --no-sandbox', () => {
  const cases = [
    { dockerenv: true },
    { containerenv: true },
    { containerEnv: 'oci' },
    { kubernetesServiceHost: '10.0.0.1' },
    { cgroup: '1:name=systemd:/docker/abcdef' },
    { cgroup: '0::/kubepods.slice/kubepods-burstable.slice' },
    { cgroup: '0::/lxc.payload/qa' },
    { cgroup: '0::/system.slice/containerd.service' },
    { cgroup: '0::/podman/libpod-123' },
  ];
  for (const extra of cases) {
    const host = { ...desktopHost, ...extra };
    assert.equal(isContainerHost(host), true, JSON.stringify(extra));
    const resolved = resolveBrowserLaunch({ env: { TMPDIR: '/tmp' }, host, platform: 'linux' });
    assert.equal(resolved.inContainer, true);
    assert.deepEqual(resolved.launchArgs, ['--no-sandbox']);
  }
});

test('a Cezar worktree TMPDIR is rewritten so Chrome’s SingletonSocket stays under the platform limit', () => {
  const tmpdir = '/home/agent/projects/cezar/.ai/cezar/tmp/f132a645-1b38-454c-8b7e-23ac7e7142b0';
  assert.ok(tmpdir.length + CHROME_SINGLETON_OVERHEAD > 107);
  const resolved = resolveBrowserLaunch({
    env: { TMPDIR: tmpdir, TMP: tmpdir, TEMP: tmpdir },
    host: desktopHost,
    platform: 'linux',
    unixSocketMax: 107,
    fallbackTmp: '/tmp',
  });
  assert.deepEqual(resolved.launchArgs, []);
  assert.deepEqual(resolved.runtimeEnv, { TMPDIR: '/tmp', TMP: '/tmp', TEMP: '/tmp' });
  assert.ok(resolved.runtimeEnv.TMPDIR.length + CHROME_SINGLETON_OVERHEAD <= 107);
});

test('doctor and test invocations share namespace, session and launch args', () => {
  assert.deepEqual(
    buildAgentBrowserArgv({
      namespace: 'cez-e2e',
      launchArgs: ['--no-sandbox'],
      command: ['doctor', '--json', '--offline'],
    }),
    ['--namespace', 'cez-e2e', '--args', '--no-sandbox', 'doctor', '--json', '--offline'],
  );
  assert.deepEqual(
    buildAgentBrowserArgv({
      namespace: 'cez-e2e',
      launchArgs: ['--no-sandbox'],
      session: 'smoke',
      command: ['open', 'about:blank', '--json'],
    }),
    ['--namespace', 'cez-e2e', '--args', '--no-sandbox', '--session', 'smoke', 'open', 'about:blank', '--json'],
  );
  assert.deepEqual(
    buildAgentBrowserArgv({ namespace: 'cez-e2e', command: ['doctor', '--json'] }),
    ['--namespace', 'cez-e2e', 'doctor', '--json'],
  );
});

test('Darwin rewrites a TMPDIR whose SingletonSocket would fill sun_path including NUL', () => {
  const socketPathLen = 104;
  const tmpdir = 'x'.repeat(socketPathLen - CHROME_SINGLETON_OVERHEAD);
  assert.equal(tmpdir.length + CHROME_SINGLETON_OVERHEAD, 104);
  const over = resolveBrowserLaunch({
    env: { TMPDIR: tmpdir, TMP: tmpdir, TEMP: tmpdir },
    host: desktopHost,
    platform: 'darwin',
    fallbackTmp: '/tmp',
  });
  assert.deepEqual(over.runtimeEnv, { TMPDIR: '/tmp', TMP: '/tmp', TEMP: '/tmp' });
  const safe = 'x'.repeat(103 - CHROME_SINGLETON_OVERHEAD);
  assert.equal(safe.length + CHROME_SINGLETON_OVERHEAD, 103);
  const under = resolveBrowserLaunch({
    env: { TMPDIR: safe },
    host: desktopHost,
    platform: 'darwin',
    fallbackTmp: '/tmp',
  });
  assert.deepEqual(under.runtimeEnv, {});
});

test('Windows and already-short POSIX paths are not rewritten', () => {
  const win = resolveBrowserLaunch({
    env: { TMP: 'C:\\Users\\me\\AppData\\Local\\Temp' },
    host: desktopHost,
    platform: 'win32',
    unixSocketMax: 107,
  });
  assert.deepEqual(win.runtimeEnv, {});
  const short = resolveBrowserLaunch({
    env: { TMPDIR: '/tmp/cez-ab' },
    host: desktopHost,
    platform: 'linux',
    unixSocketMax: 107,
  });
  assert.deepEqual(short.runtimeEnv, {});
});
