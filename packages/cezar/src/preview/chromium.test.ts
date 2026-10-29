import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The launch timeout SIGKILLs its child; the test reads the child from the spawn itself.
// A pid file the fake writes is no proof: under load the timeout can kill the fake before
// its first statement runs, and the file never appears (hearsay-tools/cezarion#953).
// `runningAtSpawn[i]` holds the earlier children still running when child `i` started.
const { spawned, runningAtSpawn } = vi.hoisted(() => ({ spawned: [] as ChildProcess[], runningAtSpawn: [] as ChildProcess[][] }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: ((...args: Parameters<typeof actual.spawn>) => {
    runningAtSpawn.push(spawned.filter(child => child.exitCode === null && child.signalCode === null));
    const child = actual.spawn(...args);
    spawned.push(child);
    return child;
  }) as typeof actual.spawn };
});
import { processStartToken } from '../delegation/process-liveness.ts';
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

  it('prefers Google Chrome over a distro Chromium within one directory', () => {
    // A GitHub runner's /usr/bin/chromium never opened its DevTools port where google-chrome did
    // (PR #792), and Ubuntu's chromium and chromium-browser are snap shims.
    const fs = fakeFs(['/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']);
    expect(resolveChromium(fs, env(), 'linux', 'x64')).toBe('/usr/bin/google-chrome-stable');
    expect(resolveChromium(fakeFs(['/usr/bin/chromium-browser', '/usr/bin/chromium']), env(), 'linux', 'x64')).toBe('/usr/bin/chromium');
  });

  it('skips a snap-confined binary, which cannot write the profile under the hidden .ai directory', () => {
    const fs: ChromiumFs = {
      ...fakeFs(['/usr/bin/chromium', `${HOME}/.cache/cez/chromium/chrome-headless-shell-linux64/chrome-headless-shell`], {
        [`${HOME}/.cache/cez/chromium`]: ['chrome-headless-shell-linux64'],
      }),
      realpathSync: p => (p === '/usr/bin/chromium' ? '/snap/chromium/3000/usr/lib/chromium-browser/chrome' : p),
    };
    expect(resolveChromium(fs, env(), 'linux', 'x64')).toBe(`${HOME}/.cache/cez/chromium/chrome-headless-shell-linux64/chrome-headless-shell`);
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
  /** Staging directories a download left behind in `<cacheDir>/chromium`. */
  const staging = (cacheDir: string) => {
    try {
      return readdirSync(join(cacheDir, 'chromium')).filter(name => name.startsWith('.partial'));
    } catch {
      return [];
    }
  };

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
    expect(staging(join(dir, 'home', '.cache', 'cez'))).toEqual([]);
    // The cache it filled is the one resolveChromium reads last.
    expect(resolveChromium(realFs, { HOME: join(dir, 'home'), PATH: '' }, 'linux', 'x64')).toBe(bin);
  });

  it('two overlapping downloads stage apart, and the second keeps the copy the first published', async () => {
    // Two cezar processes (different repos) share ~/.cache/cez/chromium.
    let downloads = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).endsWith('.json')) return jsonResponse(manifest);
      downloads++;
      return chunked([new Uint8Array([downloads])]);
    }) as typeof fetch;
    const entered: Array<() => void> = [];
    const gates: Array<() => void> = [];
    const extract = async (zip: string, dest: string) => {
      // Like unzip: the archive must still be there when extraction runs.
      const tag = String(readFileSync(zip)[0]);
      await new Promise<void>(resolve => {
        gates.push(resolve);
        entered.shift()?.();
      });
      mkdirSync(join(dest, 'chrome-headless-shell-linux64'), { recursive: true });
      writeFileSync(join(dest, 'chrome-headless-shell-linux64', 'chrome-headless-shell'), tag);
    };
    const inExtract = () => new Promise<void>(resolve => entered.push(resolve));
    const start = () => downloadChromium({ signal: new AbortController().signal, onProgress: noop, fetchImpl, cacheDir: dir, platform: 'linux', arch: 'x64', sleep: async () => {}, extract });

    const firstIn = inExtract();
    const first = start();
    await firstIn;
    const secondIn = inExtract();
    const second = start();
    await secondIn;
    gates[0]!();
    const firstBin = await first;
    gates[1]!();
    const secondBin = await second;

    expect(secondBin).toBe(firstBin);
    expect(readFileSync(firstBin, 'utf8')).toBe('1');
    expect(readdirSync(join(dir, 'chromium'))).toEqual(['chrome-headless-shell-linux64']);
  });

  it('replaces a leftover install directory that holds no binary', async () => {
    mkdirSync(join(dir, 'chromium', 'chrome-headless-shell-linux64'), { recursive: true });
    writeFileSync(join(dir, 'chromium', 'chrome-headless-shell-linux64', 'stray'), 'x');
    const fetchImpl = (async (input: string | URL | Request) =>
      String(input).endsWith('.json') ? jsonResponse(manifest) : chunked([new Uint8Array(3)])) as typeof fetch;
    const bin = await downloadChromium({
      signal: new AbortController().signal, onProgress: noop, fetchImpl, cacheDir: dir, platform: 'linux', arch: 'x64',
      extract: async (_zip, dest) => {
        mkdirSync(join(dest, 'chrome-headless-shell-linux64'), { recursive: true });
        writeFileSync(join(dest, 'chrome-headless-shell-linux64', 'chrome-headless-shell'), 'fresh');
      },
    });
    expect(readFileSync(bin, 'utf8')).toBe('fresh');
    expect(existsSync(join(dir, 'chromium', 'chrome-headless-shell-linux64', 'stray'))).toBe(false);
    expect(staging(dir)).toEqual([]);
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
    expect(staging(dir)).toEqual([]);
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
    expect(staging(dir)).toEqual([]);
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
    expect(staging(dir)).toEqual([]);
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
    expect(staging(dir)).toEqual([]);
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

/** A fake Chromium's DevTools pipe (hearsay-tools/cezarion#784): it reads commands on fd 3 and
 *  answers each on fd 4, NUL-terminated, the way `--remote-debugging-pipe` does. */
const ANSWER_PIPE = `const net=require('net');const into=new net.Socket({fd:3,readable:true,writable:false});const out=new net.Socket({fd:4,readable:false,writable:true});
let buf='';into.on('data',d=>{buf+=d;for(let i=buf.indexOf('\\0');i>=0;i=buf.indexOf('\\0')){const m=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);out.write(JSON.stringify({id:m.id,result:{product:'Fake'}})+'\\0');}});`;

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

  it('requests host graphics, and --no-sandbox only for CEZ_PREVIEW_NO_SANDBOX=1, even as root', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    const base = ['--headless=new', '--enable-gpu', '--remote-debugging-pipe', '--user-data-dir=/p', '--no-first-run', '--no-default-browser-check', '--proxy-server=direct://', 'about:blank'];
    expect(chromiumArgs('/p', {})).toEqual(base);
    expect(chromiumArgs('/p', { CEZ_PREVIEW_NO_SANDBOX: '0' })).toEqual(base);
    expect(chromiumArgs('/p', { CEZ_PREVIEW_NO_SANDBOX: 'true' })).toEqual(base);
    expect(chromiumArgs('/p', { CDP_NO_SANDBOX: '1' })).toEqual(base);
    expect(chromiumArgs('/p', { CEZ_PREVIEW_NO_SANDBOX: '1' })).toEqual(['--no-sandbox', ...base]);
  });

  it('does not pass HTTP(S)_PROXY onto Chromium argv, even when the process has one', () => {
    const args = chromiumArgs('/p', {
      HTTP_PROXY: 'http://proxy.example:3128',
      HTTPS_PROXY: 'http://user:secret@proxy.example:3128',
      NO_PROXY: 'localhost,.example.com',
    });
    expect(args).toContain('--proxy-server=direct://');
    expect(args.join(' ')).not.toMatch(/proxy\.example|user:secret|3128/);
  });

  it.skipIf(!posix)('spawns the binary with those args and resolves once the browser answers on its DevTools pipe (hearsay-tools/cezarion#784)', async () => {
    const argvFile = join(dir, 'argv.json');
    const bin = script(
      'fake-chrome',
      `const fs=require('fs');const path=require('path');
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
${ANSWER_PIPE}
setInterval(()=>{},1000);`,
    );
    const profile = join(dir, 'profile');
    const { proc, browser } = await launchChromium(bin, profile, { CEZ_PREVIEW_NO_SANDBOX: '1' });
    try {
      expect(await browser.call('Browser.getVersion', {}, undefined)).toMatchObject({ result: { product: 'Fake' } });
      expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toEqual(chromiumArgs(profile, { CEZ_PREVIEW_NO_SANDBOX: '1' }));
    } finally {
      proc.kill();
    }
  });

  it.skipIf(!posix)('records the pid with its start token beside the profile, and drops the record when Chromium exits', async () => {
    const bin = script(
      'fake-chrome-pid',
      `const fs=require('fs');const path=require('path');
${ANSWER_PIPE}
setInterval(()=>{},1000);`,
    );
    const record = join(dir, 'chromium.pid.json');
    const { proc } = await launchChromium(bin, join(dir, 'profile'), {});
    const exited = new Promise(resolve => proc.once('exit', resolve));
    try {
      expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({ pid: proc.pid, startToken: processStartToken(proc.pid!) });
    } finally {
      proc.kill();
    }
    await exited;
    expect(existsSync(record)).toBe(false);
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

  it.skipIf(!posix)('records the exit code of a Chromium that exits early, and launches it only once', async () => {
    const runs = join(dir, 'runs');
    const bin = script('exits', `require('fs').appendFileSync(${JSON.stringify(runs)}, 'run\\n');process.exit(3);`);
    const err = await launchChromium(bin, join(dir, 'profile'), {}, { timeoutMs: 5_000 }).catch(e => e);
    expect(err).toBeInstanceOf(ChromiumError);
    expect(err).toMatchObject({ kind: 'exited', exitCode: 3 });
    expect(err.signal).toBeUndefined();
    expect(readFileSync(runs, 'utf8')).toBe('run\n');
  });

  it.skipIf(!posix)('kills a launch that never answers on its pipe and retries once, after the first process exited (#1474)', async () => {
    const runs = join(dir, 'runs');
    // Run 1 stalls, as Chrome did on a CI runner; run 2 answers on its pipe.
    const bin = script(
      'stalls-once',
      `const fs=require('fs');const path=require('path');
fs.appendFileSync(${JSON.stringify(runs)}, 'run\\n');
if (fs.readFileSync(${JSON.stringify(runs)}, 'utf8').split('\\n').length > 2) {
  ${ANSWER_PIPE}
}
setInterval(()=>{},1000);`,
    );
    // The budget covers both attempts, and only the first is meant to stall: the second must start Node and
    // answer on its pipe inside it, which 400 ms does not allow on a loaded host (hearsay-tools/cezarion#1203).
    const { proc, browser } = await launchChromium(bin, join(dir, 'profile'), {}, { timeoutMs: 2_000 });
    try {
      expect(await browser.call('Browser.getVersion', {}, undefined)).toMatchObject({ result: { product: 'Fake' } });
      expect(readFileSync(runs, 'utf8')).toBe('run\nrun\n');
      const attempts = spawned.flatMap((child, index) => (child.spawnfile === bin ? [index] : []));
      expect(attempts).toHaveLength(2);
      // The retry starts only once the killed attempt has let go of the profile.
      expect(spawned[attempts[0]!]!.signalCode).toBe('SIGKILL');
      expect(runningAtSpawn[attempts[1]!]).not.toContain(spawned[attempts[0]!]);
    } finally {
      proc.kill();
    }
  });

  it.skipIf(!posix)('kills both attempts and reports kind timeout when the pipe never answers twice', async () => {
    const bin = script('hang', `setInterval(()=>{},1000);`);
    const err = await launchChromium(bin, join(dir, 'profile'), {}, { timeoutMs: 400 }).catch(e => e);
    expect(err).toBeInstanceOf(ChromiumError);
    expect(err.kind).toBe('timeout');
    // The owner's diagnostics name the binary, the deadline it missed, and that it missed it twice.
    expect(err.message).toBe(`Chromium did not answer on its DevTools pipe within 0.4 s, twice (${bin})`);
    const children = spawned.filter(candidate => candidate.spawnfile === bin);
    expect(children).toHaveLength(2);
    // Reaping the killed child is OS work, the same class as the 1 s vi.waitFor default that
    // timed out in run 38774681222 (hearsay-tools/cezarion#1071). It has not failed in CI; the
    // explicit budget keeps a loaded runner from tripping it.
    await vi.waitFor(
      () => {
        for (const child of children) {
          expect(child.signalCode).toBe('SIGKILL');
          expect(() => process.kill(child.pid!, 0)).toThrow();
        }
      },
      { timeout: 10_000, interval: 50 },
    );
  });
});

const PREFERENCES = join('Default', 'Preferences');
const LEAK_DETECTION_OFF = { profile: { password_manager_leak_detection: false } } as const;

function readPreferences(profile: string): unknown {
  return JSON.parse(readFileSync(join(profile, PREFERENCES), 'utf8'));
}

describe('launchChromium leak-detection Preferences (#972)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-chromium-prefs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const script = (name: string, body: string): string => {
    const path = join(dir, name);
    writeFileSync(path, `#!${process.execPath}\n${body}`);
    chmodSync(path, 0o755);
    return path;
  };
  const posix = process.platform !== 'win32';
  const hangingChrome = (name: string): string =>
    script(
      name,
      `const fs=require('fs');const path=require('path');
${ANSWER_PIPE}
setInterval(()=>{},1000);`,
    );

  it.skipIf(!posix)('writes leak detection off into a new profile before spawn', async () => {
    const bin = hangingChrome('prefs-new');
    const profile = join(dir, 'profile');
    const { proc } = await launchChromium(bin, profile, {});
    try {
      expect(readPreferences(profile)).toEqual(LEAK_DETECTION_OFF);
    } finally {
      proc.kill();
    }
  });

  it.skipIf(!posix)('merges leak detection off into an existing Preferences file without wiping other keys', async () => {
    const bin = hangingChrome('prefs-existing');
    const profile = join(dir, 'profile');
    mkdirSync(join(profile, 'Default'), { recursive: true });
    writeFileSync(
      join(profile, PREFERENCES),
      JSON.stringify({ profile: { name: 'Task', avatar_index: 3 }, session: { restore_on_startup: 4 } }),
    );
    const cookies = join(profile, 'Default', 'Cookies');
    writeFileSync(cookies, 'sqlite-cookies');
    const { proc } = await launchChromium(bin, profile, {});
    try {
      expect(readPreferences(profile)).toEqual({
        profile: { name: 'Task', avatar_index: 3, password_manager_leak_detection: false },
        session: { restore_on_startup: 4 },
      });
      expect(readFileSync(cookies, 'utf8')).toBe('sqlite-cookies');
    } finally {
      proc.kill();
    }
  });

  it.skipIf(!posix)('replaces corrupt Preferences with a file that only turns leak detection off', async () => {
    const bin = hangingChrome('prefs-corrupt');
    const profile = join(dir, 'profile');
    mkdirSync(join(profile, 'Default'), { recursive: true });
    writeFileSync(join(profile, PREFERENCES), '{not-json');
    const { proc } = await launchChromium(bin, profile, {});
    try {
      expect(readPreferences(profile)).toEqual(LEAK_DETECTION_OFF);
    } finally {
      proc.kill();
    }
  });
});

describe('launchChromium leak-detection Chromium regression (#972)', () => {
  const LAUNCH_BUDGET_MS = 120_000;
  const PAGE_STEPS_BUDGET_MS = 120_000;
  const bin = resolveChromium();
  const posix = process.platform !== 'win32';
  let dir: string;
  let server: Server | undefined;
  const procs: Array<{ kill: (signal?: NodeJS.Signals) => boolean }> = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-chromium-real-'));
  });
  afterEach(async () => {
    for (const proc of procs.splice(0)) proc.kill('SIGKILL');
    await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const listen = async (handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> => {
    server = createServer(handler);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('test server has no port');
    return `http://127.0.0.1:${addr.port}`;
  };

  it.skipIf(!posix || !bin)(
    'keeps leak detection off after a login and a navigation to another URL',
    async () => {
      const origin = await listen((req, res) => {
        const html =
          req.url === '/app'
            ? '<!doctype html><title>app</title><button id="go">go</button>'
            : `<!doctype html><title>login</title>
<form method="post" action="/app">
<label>user <input name="user" autocomplete="username"></label>
<label>pass <input name="pass" type="password" autocomplete="current-password"></label>
<button type="submit">sign in</button>
</form>`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
      });
      const profile = join(dir, 'profile');
      // bound: a cold Chrome start on a loaded CI runner took over the product's 30 s
      // (job 119853707395, hearsay-tools/cezarion#1467). The wait still ends on the pipe's first answer.
      const { proc, browser } = await launchChromium(bin!, profile, { CEZ_PREVIEW_NO_SANDBOX: '1' }, { timeoutMs: LAUNCH_BUDGET_MS });
      procs.push(proc);
      const root = browser.session(undefined);
      const { targetInfos } = await root.send<{ targetInfos: Array<{ type: string; targetId: string }> }>('Target.getTargets');
      const page = targetInfos.find(target => target.type === 'page');
      if (!page) throw new Error('Chromium opened no page');
      const { sessionId } = await root.send<{ sessionId: string }>('Target.attachToTarget', { targetId: page.targetId, flatten: true });
      const cdp = browser.session(sessionId);
      try {
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        const loaded = new Promise<void>(resolve => {
          const off = cdp.on('Page.loadEventFired', () => {
            off();
            resolve();
          });
        });
        await cdp.send('Page.navigate', { url: `${origin}/login` });
        await loaded;
        // Wait on the load the submit causes, not on a poll of location.pathname. The poll ran
        // under vi.waitFor's 1 s default and timed out in CI when the POST took longer on a
        // loaded runner (run 38774681222, hearsay-tools/cezarion#1071). Subscribe before the
        // submit so the event cannot fire first; the test's budget bounds the wait.
        const submitted = new Promise<void>(resolve => {
          const off = cdp.on('Page.loadEventFired', () => {
            off();
            resolve();
          });
        });
        await cdp.send('Runtime.evaluate', {
          expression: `(() => {
            const user = document.querySelector('input[name="user"]');
            const pass = document.querySelector('input[name="pass"]');
            user.value = 'preview-user';
            pass.value = 'preview-password-1';
            user.dispatchEvent(new Event('input', { bubbles: true }));
            pass.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('form').requestSubmit();
          })()`,
        });
        await submitted;
        const { result: landed } = await cdp.send<{ result: { value?: string } }>('Runtime.evaluate', {
          expression: 'location.pathname',
          returnByValue: true,
        });
        expect(landed.value).toBe('/app');
        const next = new Promise<void>(resolve => {
          const off = cdp.on('Page.loadEventFired', () => {
            off();
            resolve();
          });
        });
        await cdp.send('Page.navigate', { url: `${origin}/app` });
        await next;
        const { result } = await cdp.send<{ result: { value?: boolean } }>('Runtime.evaluate', {
          expression: `(() => {
            const el = document.elementFromPoint(8, 8);
            if (!el) return false;
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 8, clientY: 8 }));
            return true;
          })()`,
          returnByValue: true,
        });
        expect(result.value).toBe(true);
        const prefs = JSON.parse(readFileSync(join(profile, PREFERENCES), 'utf8')) as {
          profile?: { password_manager_leak_detection?: unknown };
        };
        expect(prefs.profile?.password_manager_leak_detection).toBe(false);
      } finally {
        cdp.close();
        proc.kill();
      }
    },
    // bound: the launch budget plus PAGE_STEPS_BUDGET_MS for the three page loads. Under 48 busy
    // loops on one CPU those took about 38 s and the old 45 s budget failed (#978, #1467).
    LAUNCH_BUDGET_MS + PAGE_STEPS_BUDGET_MS,
  );
});
