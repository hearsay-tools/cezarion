import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChromiumError,
  chromiumArgs,
  downloadChromium,
  downloadTarget,
  installCommand,
  launchChromium,
  realFs,
  resolveChromium,
  type ChromiumFs,
} from './chromium.ts';

const HOME = '/home/u';
const fakeFs = (files: string[], dirs: Record<string, string[]> = {}): ChromiumFs => ({
  existsSync: p => files.includes(p) || p in dirs,
  readdirSync: p => dirs[p] ?? [],
});
const env = (extra: Record<string, string> = {}) => ({ HOME, PATH: '/usr/bin' + delimiter + '/opt/bin', ...extra });

describe('resolveChromium (#781)', () => {
  it('prefers PATH over every cache', () => {
    const fs = fakeFs(['/opt/bin/google-chrome', `${HOME}/.cache/cez/chromium/chrome-headless-shell-linux64/chrome-headless-shell`]);
    expect(resolveChromium(fs, env(), 'linux', 'x64')).toBe('/opt/bin/google-chrome');
  });

  it('searches the PATH names in order within one directory', () => {
    const fs = fakeFs(['/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser']);
    expect(resolveChromium(fs, env(), 'linux', 'x64')).toBe('/usr/bin/chromium-browser');
  });

  it('prefers the Playwright cache over the cez cache', () => {
    const pw = `${HOME}/.cache/ms-playwright`;
    const fs = fakeFs(
      [`${pw}/chromium-1200/chrome-linux64/chrome`, `${HOME}/.cache/cez/chromium/chrome-headless-shell-linux64/chrome-headless-shell`],
      { [pw]: ['chromium-1200', 'ffmpeg-1011'] },
    );
    expect(resolveChromium(fs, env(), 'linux', 'x64')).toBe(`${pw}/chromium-1200/chrome-linux64/chrome`);
  });

  it('takes the newest Playwright revision numerically, and honours PLAYWRIGHT_BROWSERS_PATH', () => {
    const pw = '/pw';
    const fs = fakeFs([`${pw}/chromium-999/chrome-linux64/chrome`, `${pw}/chromium-1010/chrome-linux64/chrome`], {
      [pw]: ['chromium-999', 'chromium-1010'],
    });
    expect(resolveChromium(fs, env({ PLAYWRIGHT_BROWSERS_PATH: pw }), 'linux', 'x64')).toBe(`${pw}/chromium-1010/chrome-linux64/chrome`);
  });

  it("finds Playwright's headless shell when no full Chromium is installed", () => {
    const pw = `${HOME}/.cache/ms-playwright`;
    const bin = `${pw}/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell`;
    expect(resolveChromium(fakeFs([bin], { [pw]: ['chromium_headless_shell-1200'] }), env(), 'linux', 'x64')).toBe(bin);
  });

  it("finds agent-browser's Chrome for Testing cache (~/.agent-browser/browsers)", () => {
    const root = `${HOME}/.agent-browser/browsers`;
    const bin = `${root}/chrome-147.0.7727.0/chrome-linux64/chrome`;
    const fs = fakeFs([bin, `${HOME}/.cache/cez/chromium/chrome-headless-shell-linux64/chrome-headless-shell`], { [root]: ['chrome-147.0.7727.0'] });
    expect(resolveChromium(fs, env(), 'linux', 'x64')).toBe(bin);
  });

  it("finds agent-browser's browser when the version directory holds the binary directly, newest first", () => {
    const root = `${HOME}/.agent-browser/browsers`;
    const fs = fakeFs([`${root}/chrome-9.0.0/chrome`, `${root}/chrome-10.0.0/chrome`], { [root]: ['chrome-9.0.0', 'chrome-10.0.0'] });
    expect(resolveChromium(fs, env(), 'linux', 'x64')).toBe(`${root}/chrome-10.0.0/chrome`);
  });

  it('falls back to the cez cache last', () => {
    const bin = `${HOME}/.cache/cez/chromium/chrome-headless-shell-linux64/chrome-headless-shell`;
    expect(resolveChromium(fakeFs([bin], { [`${HOME}/.cache/cez/chromium`]: ['chrome-headless-shell-linux64', '.partial'] }), env(), 'linux', 'x64')).toBe(bin);
  });

  it('finds a macOS app bundle before the caches', () => {
    const app = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const fs = fakeFs([app, `${HOME}/Library/Caches/ms-playwright/chromium-1/chrome-mac/Chromium.app/Contents/MacOS/Chromium`]);
    expect(resolveChromium(fs, env(), 'darwin', 'arm64')).toBe(app);
  });

  it('does not look for macOS bundles on linux', () => {
    expect(resolveChromium(fakeFs(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']), env(), 'linux', 'x64')).toBeUndefined();
  });

  it('returns undefined when nothing is installed', () => {
    expect(resolveChromium(fakeFs([]), env(), 'linux', 'x64')).toBeUndefined();
  });
});

describe('downloadTarget (#781)', () => {
  it('has no linux-arm64 build: Chrome for Testing publishes none', () => {
    expect(downloadTarget('linux', 'arm64')).toBeUndefined();
  });

  it.each([
    ['linux', 'x64', 'linux64'],
    ['darwin', 'arm64', 'mac-arm64'],
    ['darwin', 'x64', 'mac-x64'],
    ['win32', 'x64', 'win64'],
  ] as const)('maps %s/%s to %s', (platform, arch, platformKey) => {
    expect(downloadTarget(platform, arch)).toEqual({ platformKey });
  });

  it('is undefined for anything else', () => {
    expect(downloadTarget('freebsd', 'x64')).toBeUndefined();
    expect(downloadTarget('win32', 'arm64')).toBeUndefined();
  });
});

describe('installCommand (#781)', () => {
  it.each([
    // Ubuntu ships no `chromium` deb, only a snap; Debian proper has the package.
    ['linux', 'ID=ubuntu\nID_LIKE=debian\n', 'sudo snap install chromium'],
    ['linux', 'ID=pop\nID_LIKE="ubuntu debian"\n', 'sudo snap install chromium'],
    ['linux', 'NAME="Debian GNU/Linux"\nID=debian\n', 'sudo apt-get install -y chromium'],
    ['linux', 'ID=raspbian\nID_LIKE=debian\n', 'sudo apt-get install -y chromium'],
    ['linux', 'ID=fedora\n', 'sudo dnf install -y chromium'],
    ['darwin', '', 'brew install --cask chromium'],
    ['linux', 'ID=arch\n', ''],
    ['win32', '', ''],
  ])('%s %j → %j', (platform, osRelease, expected) => {
    expect(installCommand(platform, osRelease)).toBe(expected);
  });
});

describe('downloadChromium (#781)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-chromium-dl-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const manifest = {
    channels: {
      Stable: {
        downloads: {
          chrome: [{ platform: 'linux64', url: 'https://dl.example/chrome-linux64.zip' }],
          'chrome-headless-shell': [
            { platform: 'linux64', url: 'https://dl.example/shell-linux64.zip' },
            { platform: 'mac-arm64', url: 'https://dl.example/shell-mac-arm64.zip' },
          ],
        },
      },
    },
  };
  const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const chunked = (chunks: Uint8Array[], signal?: AbortSignal, stallAfter = Infinity) =>
    new Response(
      new ReadableStream({
        async start(controller) {
          let i = 0;
          for (const chunk of chunks) {
            if (i++ >= stallAfter) {
              await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve()));
              controller.error(new DOMException('aborted', 'AbortError'));
              return;
            }
            controller.enqueue(chunk);
          }
          controller.close();
        },
      }),
      { headers: { 'content-length': String(chunks.reduce((n, c) => n + c.length, 0)) } },
    );
  const noop = () => {};

  it('reads the Stable chrome-headless-shell url for the target, reports progress, extracts and renames into place', async () => {
    const requested: string[] = [];
    const progress: [number, number][] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('last-known-good-versions-with-downloads.json')) return jsonResponse(manifest);
      return chunked([new Uint8Array(10), new Uint8Array(30)]);
    }) as typeof fetch;
    const extractCalls: { zip: string; dest: string; platform: string }[] = [];
    const bin = await downloadChromium({
      signal: new AbortController().signal,
      onProgress: (received, total) => progress.push([received, total]),
      fetchImpl,
      cacheDir: join(dir, 'home', '.cache', 'cez'),
      platform: 'linux',
      arch: 'x64',
      extract: async (zip, dest, platform) => {
        extractCalls.push({ zip, dest, platform });
        expect(zip.startsWith(join(dir, 'home', '.cache', 'cez', 'chromium', '.partial'))).toBe(true);
        mkdirSync(join(dest, 'chrome-headless-shell-linux64'), { recursive: true });
        writeFileSync(join(dest, 'chrome-headless-shell-linux64', 'chrome-headless-shell'), '#!/bin/sh\n');
      },
    });
    expect(requested).toEqual([
      'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json',
      'https://dl.example/shell-linux64.zip',
    ]);
    expect(progress.at(-1)).toEqual([40, 40]);
    expect(progress.map(p => p[0])).toEqual([...progress.map(p => p[0])].sort((a, b) => a - b));
    expect(extractCalls).toHaveLength(1);
    expect(bin).toBe(join(dir, 'home', '.cache', 'cez', 'chromium', 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
    expect(existsSync(bin)).toBe(true);
    expect(existsSync(join(dir, 'home', '.cache', 'cez', 'chromium', '.partial'))).toBe(false);
    // The cache it filled is the one resolveChromium reads last.
    expect(resolveChromium(realFs, { HOME: join(dir, 'home'), PATH: '' }, 'linux', 'x64')).toBe(bin);
  });

  it('removes .partial and rejects when the signal aborts mid-download, without retrying', async () => {
    const controller = new AbortController();
    let downloads = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('.json')) return jsonResponse(manifest);
      downloads++;
      return chunked([new Uint8Array(10), new Uint8Array(10)], init?.signal ?? undefined, 1);
    }) as typeof fetch;
    const done = downloadChromium({
      signal: controller.signal,
      onProgress: (received) => {
        if (received === 10) setTimeout(() => controller.abort(), 0);
      },
      fetchImpl,
      cacheDir: dir,
      platform: 'linux',
      arch: 'x64',
      extract: async () => {
        throw new Error('must not extract');
      },
    });
    await expect(done).rejects.toThrow();
    expect(downloads).toBe(1);
    expect(existsSync(join(dir, 'chromium', '.partial'))).toBe(false);
  });

  it('retries a failed attempt after 1 s, then 4 s, and gives up after three', async () => {
    let attempts = 0;
    const delays: number[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).endsWith('.json')) return jsonResponse(manifest);
      attempts++;
      throw new Error('network down');
    }) as typeof fetch;
    await expect(
      downloadChromium({
        signal: new AbortController().signal,
        onProgress: noop,
        fetchImpl,
        cacheDir: dir,
        platform: 'linux',
        arch: 'x64',
        extract: async () => {},
        sleep: async ms => void delays.push(ms),
      }),
    ).rejects.toThrow(/network down/);
    expect(attempts).toBe(3);
    expect(delays).toEqual([1_000, 4_000]);
    expect(existsSync(join(dir, 'chromium', '.partial'))).toBe(false);
  });

  it('succeeds when a later attempt works', async () => {
    let attempts = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).endsWith('.json')) return jsonResponse(manifest);
      if (++attempts === 1) throw new Error('flaky');
      return chunked([new Uint8Array(5)]);
    }) as typeof fetch;
    const bin = await downloadChromium({
      signal: new AbortController().signal,
      onProgress: noop,
      fetchImpl,
      cacheDir: dir,
      platform: 'linux',
      arch: 'x64',
      sleep: async () => {},
      extract: async (_zip, dest) => {
        mkdirSync(join(dest, 'chrome-headless-shell-linux64'), { recursive: true });
        writeFileSync(join(dest, 'chrome-headless-shell-linux64', 'chrome-headless-shell'), 'x');
      },
    });
    expect(bin).toContain('chrome-headless-shell');
    expect(attempts).toBe(2);
  });


  it('does not re-download when extraction fails: one download, a clear error, .partial removed', async () => {
    let downloads = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).endsWith('.json')) return jsonResponse(manifest);
      downloads++;
      return chunked([new Uint8Array(5)]);
    }) as typeof fetch;
    const delays: number[] = [];
    const enoent = Object.assign(new Error('spawn unzip ENOENT'), { code: 'ENOENT' });
    await expect(
      downloadChromium({
        signal: new AbortController().signal,
        onProgress: noop,
        fetchImpl,
        cacheDir: dir,
        platform: 'linux',
        arch: 'x64',
        sleep: async ms => void delays.push(ms),
        extract: async () => {
          throw enoent;
        },
      }),
    ).rejects.toThrow(/unzip is not installed/i);
    expect(downloads).toBe(1);
    expect(delays).toEqual([]);
    expect(existsSync(join(dir, 'chromium', '.partial'))).toBe(false);
  });

  it('does not re-download when the archive is corrupt or has the wrong layout', async () => {
    let downloads = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).endsWith('.json')) return jsonResponse(manifest);
      downloads++;
      return chunked([new Uint8Array(5)]);
    }) as typeof fetch;
    await expect(
      downloadChromium({ signal: new AbortController().signal, onProgress: noop, fetchImpl, cacheDir: dir, platform: 'linux', arch: 'x64', sleep: async () => {}, extract: async () => {} }),
    ).rejects.toThrow();
    expect(downloads).toBe(1);
    expect(existsSync(join(dir, 'chromium', '.partial'))).toBe(false);
  });

  it('does not retry a manifest with no download for the platform', async () => {
    let manifests = 0;
    const fetchImpl = (async () => {
      manifests++;
      return jsonResponse({ channels: { Stable: { downloads: { 'chrome-headless-shell': [] } } } });
    }) as typeof fetch;
    await expect(
      downloadChromium({ signal: new AbortController().signal, onProgress: noop, fetchImpl, cacheDir: dir, platform: 'linux', arch: 'x64', sleep: async () => {} }),
    ).rejects.toThrow(/no .*download/i);
    expect(manifests).toBe(1);
  });

  it('refuses a target Chrome for Testing does not publish (linux-arm64)', async () => {
    await expect(
      downloadChromium({ signal: new AbortController().signal, onProgress: noop, fetchImpl: (async () => jsonResponse(manifest)) as typeof fetch, cacheDir: dir, platform: 'linux', arch: 'arm64' }),
    ).rejects.toThrow(/linux-arm64|no download/i);
  });

  const hasUnzip = spawnSync('unzip', ['-v']).status === 0 && spawnSync('python3', ['-V']).status === 0;
  it.skipIf(!hasUnzip || process.platform === 'win32')('extracts a real zip with unzip -q by default', async () => {
    const src = join(dir, 'src', 'chrome-headless-shell-linux64');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'chrome-headless-shell'), '#!/bin/sh\n');
    chmodSync(join(src, 'chrome-headless-shell'), 0o755);
    const made = spawnSync('python3', ['-m', 'zipfile', '-c', join(dir, 'shell.zip'), 'chrome-headless-shell-linux64'], { cwd: join(dir, 'src') });
    expect(made.status).toBe(0);
    const zipBytes = readFileSync(join(dir, 'shell.zip'));
    const fetchImpl = (async (input: string | URL | Request) => (String(input).endsWith('.json') ? jsonResponse(manifest) : chunked([new Uint8Array(zipBytes)]))) as typeof fetch;
    const bin = await downloadChromium({ signal: new AbortController().signal, onProgress: noop, fetchImpl, cacheDir: join(dir, 'cache'), platform: 'linux', arch: 'x64' });
    expect(bin).toBe(join(dir, 'cache', 'chromium', 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
    expect(readFileSync(bin, 'utf8')).toBe('#!/bin/sh\n');
  });
});

describe('launchChromium (#781)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-chromium-launch-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const script = (name: string, body: string): string => {
    const path = join(dir, name);
    writeFileSync(path, `#!${process.execPath}\n${body}`);
    chmodSync(path, 0o755);
    return path;
  };
  const posix = process.platform !== 'win32';

  it('passes the prototype args, and --no-sandbox only for CEZ_PREVIEW_NO_SANDBOX=1, even as root', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    const base = ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=/p', '--no-first-run', '--no-default-browser-check', 'about:blank'];
    expect(chromiumArgs('/p', {})).toEqual(base);
    expect(chromiumArgs('/p', { CEZ_PREVIEW_NO_SANDBOX: '0' })).toEqual(base);
    expect(chromiumArgs('/p', { CEZ_PREVIEW_NO_SANDBOX: 'true' })).toEqual(base);
    expect(chromiumArgs('/p', { CDP_NO_SANDBOX: '1' })).toEqual(base);
    expect(chromiumArgs('/p', { CEZ_PREVIEW_NO_SANDBOX: '1' })).toEqual(['--no-sandbox', ...base]);
  });

  it.skipIf(!posix)('spawns the binary with those args, reads DevToolsActivePort and resolves with the port', async () => {
    const argvFile = join(dir, 'argv.json');
    const bin = script(
      'fake-chrome',
      `const fs=require('fs');const path=require('path');
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
const arg=process.argv.find(a=>a.startsWith('--user-data-dir='));
fs.writeFileSync(path.join(arg.split('=')[1],'DevToolsActivePort'),'41234\\n/devtools/browser/abc\\n');
setInterval(()=>{},1000);`,
    );
    const profile = join(dir, 'profile');
    const { proc, port } = await launchChromium(bin, profile, { CEZ_PREVIEW_NO_SANDBOX: '1' });
    try {
      expect(port).toBe(41234);
      expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toEqual(chromiumArgs(profile, { CEZ_PREVIEW_NO_SANDBOX: '1' }));
    } finally {
      proc.kill();
    }
  });

  it.skipIf(!posix)('does not trust a DevToolsActivePort left by an earlier launch', async () => {
    const profile = join(dir, 'profile');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'DevToolsActivePort'), '11111\n/devtools/browser/old\n');
    const bin = script('dies', `process.stderr.write('boom');process.exit(3);`);
    await expect(launchChromium(bin, profile, {})).rejects.toMatchObject({ kind: 'exited' });
  });

  it.skipIf(!posix)('classifies "No usable sandbox" stderr as kind sandbox and keeps the tail', async () => {
    const bin = script(
      'sandbox-fail',
      `process.stderr.write('[1:1:FATAL:zygote_host_impl_linux.cc(132)] No usable sandbox! Update your kernel\\n');process.exit(1);`,
    );
    const err = await launchChromium(bin, join(dir, 'profile'), {}).catch(e => e);
    expect(err).toBeInstanceOf(ChromiumError);
    expect(err.kind).toBe('sandbox');
    expect(err.stderrTail).toContain('No usable sandbox!');
  });

  it('reports kind not-installed when the binary does not exist', async () => {
    const err = await launchChromium(join(dir, 'no-such-chrome'), join(dir, 'profile'), {}).catch(e => e);
    expect(err).toBeInstanceOf(ChromiumError);
    expect(err.kind).toBe('not-installed');
  });

  it.skipIf(!posix)('reports kind exited with the stderr tail capped at 4 KiB', async () => {
    const bin = script('crash', `process.stderr.write('x'.repeat(10000)+'END');process.exit(7);`);
    const err = await launchChromium(bin, join(dir, 'profile'), {}).catch(e => e);
    expect(err).toBeInstanceOf(ChromiumError);
    expect(err.kind).toBe('exited');
    expect(err.stderrTail.length).toBeLessThanOrEqual(4096);
    expect(err.stderrTail.endsWith('END')).toBe(true);
  });

  it.skipIf(!posix)('kills the process and reports kind timeout when the port never appears', async () => {
    const pidFile = join(dir, 'pid');
    const bin = script('hang', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(()=>{},1000);`);
    const err = await launchChromium(bin, join(dir, 'profile'), {}, { timeoutMs: 400 }).catch(e => e);
    expect(err).toBeInstanceOf(ChromiumError);
    expect(err.kind).toBe('timeout');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await vi.waitFor(() => {
      expect(() => process.kill(pid, 0)).toThrow();
    });
  });
});
