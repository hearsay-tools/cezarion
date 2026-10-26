import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { processStartToken } from '../delegation/process-liveness.ts';
import { cdpOverPipe, type CdpConnection } from './cdp.ts';

/**
 * The preview's Chromium: find one, download Chrome for Testing when there is none, launch it
 * headless with a per-task profile (#781, spec 2026-10-02-live-preview-v1). Sandboxing is never
 * relaxed here on its own: `--no-sandbox` is added only for `CEZ_PREVIEW_NO_SANDBOX=1`.
 */

export type ChromiumFs = {
  existsSync(path: string): boolean;
  /** Entry names of a directory; empty when it does not exist. */
  readdirSync(path: string): string[];
  /** Where a path really points; the input when it cannot be resolved. Optional for test fakes. */
  realpathSync?(path: string): string;
};

export const realFs: ChromiumFs = {
  existsSync,
  readdirSync: path => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
  realpathSync: path => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  },
};

/** `~/.cache/cez`: the root the skills cache already uses. */
export function cezCacheDir(home = homedir()): string {
  return join(home, '.cache', 'cez');
}

/** Google Chrome first: a distro `chromium` is often a snap shim (Ubuntu) or a build that never
 *  opened its DevTools port headless (a GitHub runner's /usr/bin/chromium, PR #792). */
const PATH_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
const MAC_APPS = ['Google Chrome', 'Chromium', 'Google Chrome Canary', 'Brave Browser', 'Microsoft Edge'];
const HEADLESS_SHELL = 'chrome-headless-shell';

/** Where a browser binary sits inside one installed revision directory, per platform. */
function revisionLayouts(platform: string): string[] {
  const exe = platform === 'win32' ? '.exe' : '';
  if (platform === 'darwin') {
    const cft = 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
    return [
      `chrome-mac-arm64/${cft}`,
      `chrome-mac-x64/${cft}`,
      cft,
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      `${HEADLESS_SHELL}-mac-arm64/${HEADLESS_SHELL}`,
      `${HEADLESS_SHELL}-mac-x64/${HEADLESS_SHELL}`,
    ];
  }
  if (platform === 'win32') {
    return ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome.exe', `${HEADLESS_SHELL}-win64/${HEADLESS_SHELL}${exe}`];
  }
  return ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome', `${HEADLESS_SHELL}-linux64/${HEADLESS_SHELL}`, 'chrome-linux/headless_shell'];
}

const byRevisionDesc = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true });

function firstBinary(fs: ChromiumFs, revisionDir: string, platform: string): string | undefined {
  return revisionLayouts(platform)
    .map(rel => join(revisionDir, rel))
    .find(p => fs.existsSync(p));
}

function firstInRevisions(fs: ChromiumFs, root: string, pattern: RegExp, platform: string): string | undefined {
  for (const dir of fs.readdirSync(root).filter(d => pattern.test(d)).sort(byRevisionDesc)) {
    const bin = firstBinary(fs, join(root, dir), platform);
    if (bin) return bin;
  }
  return undefined;
}

/** A snap's confinement keeps it out of hidden directories and /tmp, so it can never write the
 *  task profile under `.ai/cezar/preview/` and its DevTools port file never appears. */
function snapConfined(fs: ChromiumFs, path: string): boolean {
  return (fs.realpathSync?.(path) ?? path).startsWith('/snap/');
}

/**
 * The first usable Chromium, most deliberate source first: PATH, macOS app bundles, Playwright's
 * cache, agent-browser's Chrome for Testing cache, then the copy `downloadChromium` keeps.
 */
export function resolveChromium(
  fs: ChromiumFs = realFs,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  _arch: string = process.arch,
): string | undefined {
  const home = env.HOME || env.USERPROFILE || homedir();

  const exe = platform === 'win32' ? '.exe' : '';
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of PATH_NAMES) {
      const p = join(dir, name + exe);
      if (fs.existsSync(p) && !snapConfined(fs, p)) return p;
    }
  }

  if (platform === 'darwin') {
    for (const root of ['/Applications', join(home, 'Applications')]) {
      for (const app of MAC_APPS) {
        const p = join(root, `${app}.app`, 'Contents', 'MacOS', app);
        if (fs.existsSync(p)) return p;
      }
    }
  }

  const playwright =
    env.PLAYWRIGHT_BROWSERS_PATH ||
    (platform === 'darwin'
      ? join(home, 'Library', 'Caches', 'ms-playwright')
      : platform === 'win32'
        ? join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'ms-playwright')
        : join(home, '.cache', 'ms-playwright'));
  // A full Chromium before a headless shell, the newest revision of each first.
  const found =
    firstInRevisions(fs, playwright, /^chromium-\d+$/, platform) ?? firstInRevisions(fs, playwright, /^chromium_headless_shell-\d+$/, platform);
  if (found) return found;

  // agent-browser keeps its Chrome for Testing under ~/.agent-browser/browsers/<chrome-version>/.
  const agentBrowser = firstInRevisions(fs, join(home, '.agent-browser', 'browsers'), /^chrome-/, platform);
  if (agentBrowser) return agentBrowser;

  const cache = join(cezCacheDir(home), 'chromium');
  for (const dir of fs.readdirSync(cache).filter(d => d.startsWith(`${HEADLESS_SHELL}-`)).sort(byRevisionDesc)) {
    const p = join(cache, dir, HEADLESS_SHELL + exe);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

export type PlatformKey = 'linux64' | 'mac-arm64' | 'mac-x64' | 'win64';

/** The Chrome for Testing build for this machine. Google publishes none for linux-arm64. */
export function downloadTarget(platform: string, arch: string): { platformKey: PlatformKey } | undefined {
  if (platform === 'linux' && arch === 'x64') return { platformKey: 'linux64' };
  if (platform === 'darwin' && arch === 'arm64') return { platformKey: 'mac-arm64' };
  if (platform === 'darwin' && arch === 'x64') return { platformKey: 'mac-x64' };
  if (platform === 'win32' && arch === 'x64') return { platformKey: 'win64' };
  return undefined;
}

/** The command that installs Chromium on this OS, or '' when cezar does not know one. `osRelease` is /etc/os-release. */
export function installCommand(platform: string, osRelease: string): string {
  if (platform === 'darwin') return 'brew install --cask chromium';
  if (platform !== 'linux') return '';
  const field = (key: string) => osRelease.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.replace(/^["']|["']$/g, '') ?? '';
  const ids = [field('ID'), ...field('ID_LIKE').split(/\s+/)].filter(Boolean);
  // Ubuntu (and its derivatives) has no `chromium` deb, only a snap; Debian proper has the package.
  if (ids.includes('ubuntu')) return 'sudo snap install chromium';
  if (ids.includes('debian')) return 'sudo apt-get install -y chromium';
  if (ids.includes('fedora')) return 'sudo dnf install -y chromium';
  return '';
}

const VERSIONS_URL = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
const RETRY_DELAYS_MS = [1_000, 4_000];

const versionsSchema = z.object({
  channels: z.object({
    Stable: z.object({
      downloads: z.record(z.string(), z.array(z.object({ platform: z.string(), url: z.string() }))),
    }),
  }),
});

export type DownloadChromiumOptions = {
  signal: AbortSignal;
  onProgress(received: number, total: number): void;
  fetchImpl?: typeof fetch;
  /** Defaults to `~/.cache/cez`. */
  cacheDir?: string;
  platform?: string;
  arch?: string;
  /** Unpacks `zip` into `dest`. Defaults to `unzip -q` (POSIX) or `tar -xf` (Windows). */
  extract?: (zip: string, dest: string, platform: string, signal?: AbortSignal) => Promise<void>;
  /** Waits out a retry backoff; rejects when the signal aborts. Tests replace it. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

const execFileAsync = promisify(execFile);

async function extractZip(zip: string, dest: string, platform: string, signal?: AbortSignal): Promise<void> {
  if (platform === 'win32') await execFileAsync('tar', ['-xf', zip, '-C', dest], { signal });
  else await execFileAsync('unzip', ['-q', zip, '-d', dest], { signal });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** A failure a retry cannot fix: a bad manifest, a missing extractor, a wrong archive layout. */
class PermanentDownloadError extends Error {}

/**
 * Downloads the Stable `chrome-headless-shell` build into `<cache>/chromium` and returns its binary.
 * Each download stages in its own `.partial-*` directory (two cezar processes in different repos
 * share the cache) and is renamed into place only once unpacked, so an abort or a crash never
 * leaves a half-installed Chromium for `resolveChromium` to find. A copy another process already
 * published wins; ours is discarded. Only the network
 * phase gets three attempts; a failed extraction fails at once, since re-downloading would not help.
 */
export async function downloadChromium(opts: DownloadChromiumOptions): Promise<string> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const target = downloadTarget(platform, arch);
  if (!target) throw new Error(`Chrome for Testing publishes no download for ${platform}-${arch}`);
  const root = join(opts.cacheDir ?? cezCacheDir(), 'chromium');
  await mkdir(root, { recursive: true });
  const partial = await mkdtemp(join(root, '.partial-'));
  const zip = join(partial, 'chromium.zip');

  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await fetchArchive(opts, target.platformKey, partial, zip);
        break;
      } catch (err) {
        await rm(partial, { recursive: true, force: true });
        if (opts.signal.aborted || err instanceof PermanentDownloadError) throw err;
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) throw err;
        await (opts.sleep ?? sleep)(delay, opts.signal);
      }
    }
    return await install(opts, target.platformKey, platform, root, partial, zip);
  } catch (err) {
    await rm(partial, { recursive: true, force: true });
    throw err;
  }
}

async function fetchArchive(opts: DownloadChromiumOptions, platformKey: PlatformKey, partial: string, zip: string): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  const { signal } = opts;

  const versionsRes = await doFetch(VERSIONS_URL, { signal });
  if (!versionsRes.ok) throw new Error(`Chrome for Testing version list answered ${versionsRes.status}`);
  const versions = versionsSchema.safeParse(await versionsRes.json());
  if (!versions.success) throw new PermanentDownloadError('Chrome for Testing version list has an unexpected shape');
  const url = versions.data.channels.Stable.downloads[HEADLESS_SHELL]?.find(d => d.platform === platformKey)?.url;
  if (!url) throw new PermanentDownloadError(`Chrome for Testing lists no ${HEADLESS_SHELL} download for ${platformKey}`);

  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true });

  const res = await doFetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`Chromium download answered ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const file = await open(zip, 'w');
  try {
    let received = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await file.write(value);
      received += value.length;
      opts.onProgress(received, total || received);
    }
  } finally {
    await file.close();
  }
  signal.throwIfAborted();
}

/**
 * Renames `staged` to `finalDir` in one step. A directory rename never replaces a non-empty one, so
 * when another process published first, its complete copy stays and ours is discarded with the
 * staging directory. Only a leftover without a binary is cleared and the rename tried again.
 */
async function publish(staged: string, finalDir: string, bin: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(staged, finalDir);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'EPERM') throw err;
      if (existsSync(bin)) return;
      if (attempt >= 2) throw err;
      await rm(finalDir, { recursive: true, force: true });
    }
  }
}

async function install(opts: DownloadChromiumOptions, platformKey: PlatformKey, platform: string, root: string, partial: string, zip: string): Promise<string> {
  const tool = platform === 'win32' ? 'tar' : 'unzip';
  const unpacked = join(partial, 'unpacked');
  await mkdir(unpacked);
  try {
    await (opts.extract ?? extractZip)(zip, unpacked, platform, opts.signal);
  } catch (err) {
    if (opts.signal.aborted) throw err;
    const reason = (err as NodeJS.ErrnoException).code === 'ENOENT' ? `${tool} is not installed` : `${tool} could not unpack the download: ${(err as Error).message}`;
    throw new PermanentDownloadError(`Could not extract Chromium: ${reason}`);
  }
  opts.signal.throwIfAborted();

  const dirName = `${HEADLESS_SHELL}-${platformKey}`;
  const finalDir = join(root, dirName);
  const bin = join(finalDir, HEADLESS_SHELL + (platform === 'win32' ? '.exe' : ''));
  if (!existsSync(join(unpacked, dirName))) throw new PermanentDownloadError(`The Chromium download did not contain ${dirName}`);
  if (!existsSync(join(unpacked, dirName, basename(bin)))) throw new PermanentDownloadError(`The Chromium download did not contain ${HEADLESS_SHELL}`);
  await publish(join(unpacked, dirName), finalDir, bin);
  await rm(partial, { recursive: true, force: true });
  return bin;
}

export class ChromiumError extends Error {
  /** How the process ended, when it ended on its own: its exit code, or the signal that stopped it. */
  readonly exitCode?: number;
  readonly signal?: string;

  constructor(
    readonly kind: 'not-installed' | 'sandbox' | 'timeout' | 'exited',
    readonly stderrTail: string,
    message: string,
    exit: { exitCode?: number; signal?: string } = {},
  ) {
    super(message);
    this.name = 'ChromiumError';
    if (exit.exitCode !== undefined) this.exitCode = exit.exitCode;
    if (exit.signal !== undefined) this.signal = exit.signal;
  }
}

const STDERR_TAIL_BYTES = 4096;
const SANDBOX_FAILURE = /No usable sandbox|zygote_host_impl|setuid sandbox/;
/** A cold start (fresh profile, loaded machine) can take well over 10 s; CI runners did (#781). */
const LAUNCH_TIMEOUT_MS = 30_000;
/** A launch that misses its deadline is killed and tried once more: on a CI runner Chrome stalled
 *  past 30 s before it printed anything, while every launch on a loaded host took 2 s at most
 *  (hearsay-tools/cezarion#1474). Only a timeout is retried; an exit fails at once. */
const LAUNCH_ATTEMPTS = 2;
/** How long a timed-out launch may take to exit after SIGKILL before the retry starts anyway. */
const KILLED_EXIT_WAIT_MS = 5_000;

/** Chromium's argv: the prototype's, without its automatic `--no-sandbox` for root.
 *  `--proxy-server=direct://` so Linux Chrome does not inherit HTTP(S)_PROXY: it will not send
 *  proxy auth the way curl does, and a render-blocking third-party stylesheet then never paints.
 *  `--remote-debugging-pipe` opens no port: only cezar reaches the browser, and an agent drives it
 *  through cezar's CDP proxy alone (hearsay-tools/cezarion#784). */
export function chromiumArgs(profileDir: string, env: NodeJS.ProcessEnv): string[] {
  const args = ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--proxy-server=direct://', 'about:blank'];
  return env.CEZ_PREVIEW_NO_SANDBOX === '1' ? ['--no-sandbox', ...args] : args;
}

/**
 * The task's Chromium pid record, `<runDir>/chromium.pid.json` beside its profile: `{ pid, startToken }`.
 * A crashed cezar leaves the browser running; the boot sweep kills it by this record (#781).
 */
export const CHROMIUM_PID_FILE = 'chromium.pid.json';

/** Chromium's leaked-password dialog is native chrome, so the preview never streams it and mouse
 *  input freezes. Write `profile.password_manager_leak_detection: false` before launch so both a
 *  new profile and an existing one (cookies live in SQLite, not this file) start with it off. */
function disablePasswordManagerLeakDetection(profileDir: string): void {
  const prefsPath = join(profileDir, 'Default', 'Preferences');
  mkdirSync(dirname(prefsPath), { recursive: true });
  let prefs: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(prefsPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) prefs = parsed as Record<string, unknown>;
  } catch {
    /* missing or corrupt: write a file that only turns leak detection off */
  }
  const profile =
    prefs.profile && typeof prefs.profile === 'object' && !Array.isArray(prefs.profile)
      ? { ...(prefs.profile as Record<string, unknown>) }
      : {};
  profile.password_manager_leak_detection = false;
  prefs.profile = profile;
  const tmp = `${prefsPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(prefs)}\n`, { encoding: 'utf8' });
  renameSync(tmp, prefsPath);
}

/**
 * Starts headless Chromium with its DevTools on a pipe and resolves once the browser answers
 * `Browser.getVersion` on it. A launch that misses the deadline is killed and tried once more
 * (`LAUNCH_ATTEMPTS`); any other failure kills the process and says why at once. While it runs,
 * `CHROMIUM_PID_FILE` in the profile's parent names it. Leak detection is turned off in the profile
 * Preferences before spawn so Chrome's leaked-password dialog cannot freeze preview input
 * (hearsay-tools/cezarion#972).
 */
export async function launchChromium(
  bin: string,
  profileDir: string,
  env: NodeJS.ProcessEnv,
  opts: { timeoutMs?: number } = {},
): Promise<{ proc: ChildProcess; browser: CdpConnection }> {
  mkdirSync(profileDir, { recursive: true });
  disablePasswordManagerLeakDetection(profileDir);
  const timeoutMs = opts.timeoutMs ?? LAUNCH_TIMEOUT_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await launchOnce(bin, profileDir, env, timeoutMs);
    } catch (error) {
      if (!(error instanceof ChromiumError) || error.kind !== 'timeout') throw error;
      if (attempt >= LAUNCH_ATTEMPTS) {
        throw new ChromiumError('timeout', error.stderrTail, `Chromium did not answer on its DevTools pipe within ${timeoutMs / 1000} s, twice (${bin})`);
      }
    }
  }
}

/** One launch attempt. A timed-out attempt is killed and has exited (or had `KILLED_EXIT_WAIT_MS`
 *  to) before it rejects, so a retry does not share the profile with it. */
async function launchOnce(bin: string, profileDir: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ proc: ChildProcess; browser: CdpConnection }> {
  // fd 3 carries commands into Chromium, fd 4 carries its replies and events out.
  const proc = spawn(bin, chromiumArgs(profileDir, env), { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const pid = proc.pid;
  if (pid !== undefined) {
    const record = join(dirname(profileDir), CHROMIUM_PID_FILE);
    writeFileSync(record, JSON.stringify({ pid, startToken: processStartToken(pid) }), { mode: 0o600 });
    proc.once('exit', () => {
      try {
        if ((JSON.parse(readFileSync(record, 'utf8')) as { pid?: unknown }).pid !== pid) return;
      } catch { /* gone or unreadable: nothing of ours to keep */ }
      rmSync(record, { force: true });
    });
  }
  let tail = Buffer.alloc(0);
  proc.stderr?.on('data', (chunk: Buffer) => {
    tail = Buffer.concat([tail, chunk]).subarray(-STDERR_TAIL_BYTES);
  });
  let exit: string | undefined;
  let ended: { exitCode?: number; signal?: string } = {};
  let missing = false;
  let wake!: () => void;
  const changed = new Promise<void>(resolve => (wake = resolve));
  const closed = new Promise<void>(resolve => proc.once('close', () => resolve()));
  proc.once('close', (code, signal) => {
    exit ??= `Chromium exited (${signal ?? code})`;
    ended = signal ? { signal } : code === null ? {} : { exitCode: code };
    wake();
  });
  proc.on('error', err => {
    exit ??= `Chromium could not start: ${err.message}`;
    missing ||= (err as NodeJS.ErrnoException).code === 'ENOENT';
    tail = Buffer.from(err.message);
    wake();
  });

  const fail = (kind: 'timeout' | 'exited', message: string): ChromiumError => {
    browser?.close();
    proc.kill('SIGKILL');
    const stderrTail = tail.toString('utf8');
    if (missing) return new ChromiumError('not-installed', stderrTail, message);
    return new ChromiumError(SANDBOX_FAILURE.test(stderrTail) ? 'sandbox' : kind, stderrTail, message, kind === 'exited' ? ended : {});
  };

  const toBrowser = proc.stdio[3] as Writable | null | undefined;
  const fromBrowser = proc.stdio[4] as Readable | null | undefined;
  const browser = toBrowser && fromBrowser ? cdpOverPipe(toBrowser, fromBrowser) : undefined;
  // The first answer on the pipe is the ready signal; a closed pipe answers with an error.
  let ready = false;
  let pipeClosed = !browser;
  if (browser) void browser.call('Browser.getVersion', {}, undefined).then(reply => {
    ready = !reply.error;
    pipeClosed = !ready;
    wake();
  });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>(resolve => (timer = setTimeout(resolve, timeoutMs)));
  await Promise.race([changed, deadline]);
  clearTimeout(timer);
  // A browser that dies closes the pipe before `close` reports its exit code: wait for that
  // report, bounded, so the failure says how Chromium ended.
  if (!exit && pipeClosed) {
    let closeTimer: NodeJS.Timeout | undefined;
    await Promise.race([closed, new Promise<void>(resolve => (closeTimer = setTimeout(resolve, KILLED_EXIT_WAIT_MS)))]);
    clearTimeout(closeTimer);
    exit ??= 'Chromium closed its DevTools pipe';
  }
  if (exit) throw fail('exited', exit);
  if (ready && browser) return { proc, browser };
  const error = fail('timeout', `Chromium did not answer on its DevTools pipe within ${timeoutMs / 1000} s (${bin})`);
  let killedTimer: NodeJS.Timeout | undefined;
  await Promise.race([closed, new Promise<void>(resolve => (killedTimer = setTimeout(resolve, KILLED_EXIT_WAIT_MS)))]);
  clearTimeout(killedTimer);
  throw error;
}
