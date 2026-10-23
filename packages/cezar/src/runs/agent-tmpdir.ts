/**
 * Task-scoped temp directory for spawned agents (#785, length-capped by #387).
 *
 * Every agent used to inherit the host's `TMPDIR`/`TEMP`/`TMP` verbatim — they
 * ride in on `buildChildEnv`'s base allowlist — so every run on the machine
 * shared one directory. On a box that runs agents continuously and never
 * reboots, that directory is a tmpfs nobody reaps, and once it hits its quota
 * the failure is *silent*: the Claude Code CLI roots its scratch tree at
 * `os.tmpdir()` and round-trips each `Bash` command's stdout/stderr through a
 * file there. Under `EDQUOT` the inode is still allocated, so the file is
 * created and the write fails — the command runs, its side effects land, and
 * the agent reads back an empty result with a bogus exit status. Nothing in the
 * cockpit says anything is wrong.
 *
 * Three properties fix that, and this module owns all of them:
 *
 *   1. **Isolation** — each run gets its own directory under `<dataDir>`
 *      (`t/<first 8 chars of the run id>` since hearsay-tools/cezarion#1022,
 *      `tmp/<runId>` before it — see `agentShortTmpDir`), on the same disk as
 *      the run's own state rather than a shared tmpfs, reaped when the run
 *      ends. `buildChildEnv` applies the per-run env last, so these values win
 *      over the host's without any allowlist change.
 *   2. **Fail loud** — the directory is write-probed before the backend spawns.
 *      A run that cannot get a working temp directory fails immediately with a
 *      named, actionable error instead of spawning an agent that will run blind.
 *   3. **Short enough to bind** (#387) — tools bind *named* unix sockets under
 *      `TMPDIR` (tsx's IPC server lays down `<tmpdir>/tsx-<uid>/<pid>.pipe`,
 *      Chromium `<tmpdir>/org.chromium.Chromium.XXXXXX/SingletonSocket`), and
 *      the kernel caps a socket path at
 *      `sun_path` — 108 bytes on Linux, 104 on macOS, NUL included. A checkout
 *      deep enough (Cezar's own nested task worktrees land past 100 chars)
 *      pushed every such bind past the cap and broke `npm install` and
 *      typechecking inside the run. A directory that would land too deep
 *      resolves instead to a short digest-named directory under the OS temp
 *      root — still per-run, still probed, still reaped. A repo whose own path
 *      fits keeps its scratch repo-local; the budget leaves room for Chromium's
 *      nested `SingletonSocket` (hearsay-tools/cezarion#1022), and the short
 *      `t/<id8>` name is what keeps ordinary checkouts inside it. When the ambient
 *      `TMPDIR` itself is too deep for that root's candidate (#440 — routine
 *      inside a cezar task session, whose `TMPDIR` is the checkout's own
 *      scratch tree per #785), the next root is the platform's own temp root
 *      (`/tmp`), which `TMPDIR` cannot deepen; only when no root fits does the
 *      spawn refuse.
 *
 * `CEZ_AGENT_TMPDIR=0` opts out of ALL THREE — cezar keeps its hands off the
 * temp directory entirely and the pre-#785 behaviour is back, byte for byte.
 * That is deliberate: an escape hatch that still imposed the preflight would be
 * a hatch you cannot actually escape through, and this repo's
 * graceful-degradation rule says a new check must never become the only way to
 * run.
 */
import { createHash, randomUUID } from 'node:crypto';
import { checkpointFallbackRemoval, fallbackIdentity, readFallbackRemovals, type FallbackRemoval } from './agent-tmpdir-removal.ts';
import { workerEvidenceRunIds } from './worker-execution.ts';
import type { Dirent } from 'node:fs';
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

/** Run ids are uuids; anything else must never reach a recursive `rmSync`.
 *
 *  `.` and `..` are excluded explicitly, not as pedantry: they match the
 *  character class, and `join(dataDir, 'tmp', '..')` resolves to `<dataDir>`
 *  itself — a recursive removal of every run's state. A guard that admits the
 *  one input capable of turning this helper into data loss is not a guard. */
function safeRunId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..';
}

/**
 * The run's CONTROL directory, `<dataDir>/tmp/<runId>`: it holds the recorded
 * fallback location (`.cez-fallback`) and the partial-removal receipts, and its
 * entries are what the startup sweep reads run ids from. Before
 * hearsay-tools/cezarion#1022 it was also the TMPDIR handed to the agent; a
 * directory minted then is still a location every holder scan, reap and sweep
 * covers, and `agentTmpEnv` moves its contents to `agentShortTmpDir` on the
 * run's next spawn.
 */
export function agentTmpDir(dataDir: string, runId: string): string {
  return join(dataDir, 'tmp', runId);
}

/** The root every control directory hangs off (`runs/`, `runs.db` and
 *  `worktrees/` are siblings this module never touches). */
function agentTmpRoot(dataDir: string): string {
  return join(dataDir, 'tmp');
}

const SHORT_TMP_ROOT = 't';
const SHORT_TMP_NAME_LENGTH = 8;
const RUN_FILE = '.cez-run';

/**
 * The repo-local TMPDIR handed to the run's agent (hearsay-tools/cezarion#1022):
 * `<dataDir>/t/<first 8 chars of the run id>`.
 *
 * Why a short name rather than a lower cap alone: the socket budget below
 * leaves 58 bytes for the whole directory, and `<dataDir>/tmp/<36-char uuid>`
 * spends 41 of them on its own suffix — on an ordinary checkout
 * (`/home/<user>/projects/<repo>/.ai/cezar/tmp/<uuid>`, ~77 bytes) every run
 * would leave the repo for the `/tmp/cez-agent-*` fallback, giving up #785's
 * "same disk as the run's state". `t/<id8>` costs 11 bytes, which keeps any
 * checkout whose `.ai/cezar` is at most 47 bytes repo-local — that is
 * `/home/<user>/projects/<repo>` and `/Users/<user>/projects/<repo>` for
 * ordinary user and repo names. Deeper checkouts still fall back, as before.
 *
 * Eight characters are the run id's leading hex group — the same `<id8>` the
 * task's `cez/<id8>` branch carries, so a human can map the directory to its
 * task. Eight characters are not unique by construction (non-uuid ids, or a
 * 32-bit collision), so the directory carries a `.cez-run` marker naming the
 * full run id: a run finding the name claimed by another run resolves to the
 * OS-root fallback instead, and reap and sweep never remove a directory whose
 * marker names a run other than the one being reaped.
 */
export function agentShortTmpDir(dataDir: string, runId: string): string {
  return join(dataDir, SHORT_TMP_ROOT, runId.slice(0, SHORT_TMP_NAME_LENGTH));
}

/** Who the short directory belongs to: nobody yet (`free` — no marker, or no
 *  directory), this run, another run, or nobody can tell (an unreadable
 *  marker). Unknown is never treated as ours: it is not reused, not removed,
 *  and it keeps the directory in holder scans. */
type ShortClaim = 'free' | 'ours' | 'other' | 'unknown';

/** The marker's run id; `null` when there is none, `undefined` when unreadable
 *  or malformed. A marker that is not a run id this directory's name could
 *  belong to (a stray file, or a write cut short before
 *  hearsay-tools/cezarion#1037 made it atomic) is unknown ownership, never a
 *  foreign run, so the sweep keeps the directory.
 *  `ENOTDIR` (a file where `t/` or the directory should be) is "none": the
 *  spawn then tries to mint the directory and fails loudly with
 *  `AgentTempDirError`, rather than quietly leaving the repo. */
function readRunMarker(dir: string): string | null | undefined {
  try {
    const owner = readFileSync(join(dir, RUN_FILE), 'utf8');
    return safeRunId(owner) && owner.slice(0, SHORT_TMP_NAME_LENGTH) === basename(dir) ? owner : undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : undefined;
  }
}

function shortTmpDirClaim(dir: string, runId: string): ShortClaim {
  const owner = readRunMarker(dir);
  if (owner === null) return 'free';
  if (owner === undefined) return 'unknown';
  return owner === runId ? 'ours' : 'other';
}

/** Mint the `.cez-run` marker without ever following an existing name, and
 *  refuse when the name turns out to be another run's — the read in
 *  `resolveAgentTmpDir` already steered away from one, so this only fires on a
 *  race or a replaced marker. The id is written to a private name first and
 *  hard-linked into place: `link` publishes it whole or not at all and, like
 *  `wx`, fails on an existing name, so a crash mid-write can never leave a
 *  partial marker for the sweep to misread (hearsay-tools/cezarion#1037). */
function writeRunMarker(dir: string, runId: string): void {
  const marker = join(dir, RUN_FILE);
  const pending = `${marker}.${process.pid}.${randomUUID()}`;
  writeFileSync(pending, runId, { encoding: 'utf8', flag: 'wx' });
  try {
    linkSync(pending, marker);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    if (readRunMarker(dir) !== runId) {
      throw new AgentTempDirError(dir, new Error('directory belongs to another run'));
    }
  } finally {
    unlinkSync(pending);
  }
}

/**
 * Carry a pre-hearsay-tools/cezarion#1022 run's scratch over to its new
 * directory, so a Continue after the upgrade keeps its files (#515). Only a
 * control directory that was the old TMPDIR qualifies — one holding a fallback
 * pointer or removal receipt is control state and stays where the reap looks
 * for it. Same filesystem (both under dataDir), so the rename is atomic; any
 * failure just leaves a fresh directory, and the old one is still reaped.
 */
function adoptLegacyTmpDir(dataDir: string, runId: string, short: string): void {
  const legacy = agentTmpDir(dataDir, runId);
  try {
    if (existsSync(short) || !lstatSync(legacy).isDirectory()) return;
    if (readdirSync(legacy).some((name) => name.startsWith('.cez-fallback'))) return;
    mkdirSync(dirname(short), { recursive: true });
    renameSync(legacy, short);
  } catch {
    // best-effort: nothing to adopt, or it could not be moved.
  }
}

/**
 * The bytes Chromium appends to TMPDIR for its singleton socket —
 * `/org.chromium.Chromium.XXXXXX/SingletonSocket`, 45 bytes (Google Chrome's
 * `/com.google.Chrome.XXXXXX/...` is 41). The longest name any known tool lays
 * down under TMPDIR: tsx's `/tsx-<uid>/<pid>.pipe` is ~22.
 *
 * Mirrors `CHROME_SINGLETON_OVERHEAD` in `.ai/scripts/resolve-browser-launch.mjs`,
 * which the e2e seam applies to its own browser launches. The published
 * package cannot import a repo script, so the value is written twice and
 * `packages/cezar/test/unit/resolve-browser-launch.test.ts` asserts they agree.
 */
export const CHROME_SINGLETON_OVERHEAD = '/org.chromium.Chromium.XXXXXX/SingletonSocket'.length;

/** `sockaddr_un.sun_path` on macOS, the tighter platform: 104 bytes, NUL
 *  included (Linux has 108). Mirrors `DARWIN_UNIX_SOCKET_MAX` in
 *  `.ai/scripts/resolve-browser-launch.mjs`, under the same agreement test. */
export const DARWIN_UNIX_SOCKET_MAX = 103;

/**
 * The longest a per-run temp directory may be so that tools binding named
 * unix sockets under it still work (#387), measured in UTF-8 bytes — the
 * kernel bounds the encoded path, not the JavaScript character count. It is
 * the tighter platform's `sun_path` minus Chromium's singleton-socket suffix:
 * 103 − 45 = 58. One value for every platform, so a checkout resolves the
 * same way wherever it runs.
 *
 * It was 78 until hearsay-tools/cezarion#1022, sized for a `SingletonSocket`
 * directly under TMPDIR. Chrome nests it one directory deeper, so a 77-byte
 * task TMPDIR (an ordinary checkout's `.ai/cezar/tmp/<uuid>`) failed every
 * browser launch with `Socket path too long`.
 */
export const MAX_SOCKET_SAFE_DIR_LENGTH = DARWIN_UNIX_SOCKET_MAX - CHROME_SINGLETON_OVERHEAD;

/** The pre-hearsay-tools/cezarion#1022 ceiling. Only reading a recorded fallback
 *  pointer still accepts it: a run that recorded one under the old ceiling must
 *  keep its scratch on Continue and must still be reaped, and the digest
 *  equality check — not the length — is what validates the pointer. Such a
 *  pointer is never handed to an agent again: `migrateLegacyFallback` moves its
 *  scratch to a directory inside the new budget first. */
const LEGACY_MAX_SOCKET_SAFE_DIR_LENGTH = 78;

function fitsSocketBudget(path: string): boolean {
  return Buffer.byteLength(path, 'utf8') <= MAX_SOCKET_SAFE_DIR_LENGTH;
}

/** The OS temp root, symlink-resolved: `bind(2)` bounds the path the kernel
 *  walks, so the check must measure what the path resolves to, not what it
 *  says (macOS hands out `/var/folders/...` through a `/private/var` symlink). */
function osTempRoot(): string {
  try {
    return realpathSync(tmpdir());
  } catch {
    return tmpdir();
  }
}

/** The platform's own temp root — the one `TMPDIR`/`TEMP`/`TMP` cannot move.
 *  POSIX spells it `/tmp` (resolved through symlinks for the same reason
 *  `osTempRoot` resolves them). Windows has no such constant and no named
 *  unix sockets to protect, so it contributes no second root and keeps
 *  today's single-root behaviour. */
function platformTempRoot(): string | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    return realpathSync('/tmp');
  } catch {
    return '/tmp';
  }
}

/** Every root a fallback directory can hang off, most preferred first: the
 *  env-honouring OS temp root, then the platform default (#440). A cezar task
 *  session exports a `TMPDIR` as deep as the checkout it belongs to (#785),
 *  so the first root's candidate can itself cross the socket cap while the
 *  platform default still fits. Resolution picks the first root whose
 *  candidate fits; removal and the sweep walk them all, because the env can
 *  differ between mint and reap. */
function osTempRoots(): string[] {
  const env = osTempRoot();
  const platform = platformTempRoot();
  return platform && platform !== env ? [env, platform] : [env];
}

const FALLBACK_PREFIX = 'cez-agent-';
const FALLBACK_NAME_LENGTH = 12;

/** The marker file inside a fallback directory naming the dataDir that minted
 *  it. The directory name digests `dataDir:runId` and is not reversible, so
 *  without this marker a sweep could not tell its own stale directories from
 *  another project's live ones in the shared root — and would delete them. */
const OWNER_FILE = '.cez-owner';

function dataDirOwner(dataDir: string): string {
  return createHash('sha256').update(`cez-agent-owner:${dataDir}`).digest('hex').slice(0, 16);
}

/**
 * Write the ownership marker. `'wx'` never follows an existing name: an agent
 * that replaced a previous marker with a symlink must not turn this rewrite
 * into an arbitrary-file write. An existing marker is verified by content —
 * a mismatch means the directory's ownership is no longer what the digest
 * name promises, and the spawn refuses rather than guess.
 */
function writeOwnerMarker(dir: string, dataDir: string): void {
  const marker = join(dir, OWNER_FILE);
  const expected = dataDirOwner(dataDir);
  try {
    writeFileSync(marker, expected, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    let actual = '';
    try {
      actual = readFileSync(marker, 'utf8').trim();
    } catch {
      // unreadable marker (symlink to nowhere, wrong type): verify below.
    }
    if (actual !== expected) {
      throw new AgentTempDirError(dir, new Error('ownership marker was replaced — remove the directory to re-mint it'));
    }
  }
}

/**
 * Where the fallback lives for this dataDir+run pair under one root. The name
 * digests the dataDir in, because the OS temp roots are SHARED: a name derived
 * from the run id alone would let one repo's reap delete another repo's live
 * scratch when two run ids happen to share their leading characters. The name
 * alone cannot make the sweep safe — a digest is not reversible, so a sweep
 * could not tell its own stale directories from another project's live ones —
 * which is why every fallback directory also carries the `.cez-owner` marker.
 * The digest does not include the root, so the name is stable across roots:
 * whatever env a later reap or sweep runs under, it can find the directory.
 */
function fallbackTmpDir(root: string, dataDir: string, runId: string): string {
  const digest = createHash('sha256').update(`${dataDir}:${runId}`).digest('hex');
  return join(root, FALLBACK_PREFIX + digest.slice(0, FALLBACK_NAME_LENGTH));
}

/** Persist the selected fallback in the task's local scratch directory. The
 * host temp environment can change between sessions, so recomputing it loses
 * the task's files. Only a digest-named absolute path is accepted on read. */
const LOCATION_FILE = '.cez-fallback';

/** The location a pointer migration is moving scratch AWAY from
 *  (hearsay-tools/cezarion#1037). It exists only between rewriting
 *  `.cez-fallback` and finishing the move, so a crash in that window still
 *  leaves the old directory in every holder scan, reap and sweep — the old root
 *  may be one no later env lists. */
const PREVIOUS_LOCATION_FILE = '.cez-fallback-previous';

function recordedFallback(dataDir: string, runId: string, file = LOCATION_FILE): string | undefined {
  const marker = join(agentTmpDir(dataDir, runId), file);
  let dir: string;
  try {
    dir = readFileSync(marker, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new AgentTempDirError(marker, err);
  }
  if (!isAbsolute(dir) || dir !== fallbackTmpDir(dirname(dir), dataDir, runId)
      || Buffer.byteLength(dir, 'utf8') > LEGACY_MAX_SOCKET_SAFE_DIR_LENGTH) {
    throw new AgentTempDirError(marker, new Error('invalid recorded fallback directory'));
  }
  return dir;
}

/** Replace a location record whole: write a private name, then `rename` over
 *  the record, so a crash leaves the old pointer or the new one, never a torn
 *  one. The private name never follows an existing file (`wx`). */
function rewriteLocation(dataDir: string, runId: string, file: string, dir: string): void {
  const target = join(agentTmpDir(dataDir, runId), file);
  const pending = `${target}.${randomUUID()}.tmp`;
  writeFileSync(pending, dir, { encoding: 'utf8', flag: 'wx' });
  try {
    renameSync(pending, target);
  } finally {
    rmSync(pending, { force: true });
  }
}

/**
 * Move the scratch of a fallback recorded under the pre-hearsay-tools/cezarion#1022
 * ceiling to `dir`, the socket-safe directory resolution now picks
 * (hearsay-tools/cezarion#1037). Handing the old path back would keep a 59–78
 * byte TMPDIR that Chromium's nested singleton socket cannot bind under.
 *
 * Order is what makes a crash safe, and every re-run converges:
 *   1. record the old location in `.cez-fallback-previous`, so it stays in
 *      scans and reaps whatever the env is later;
 *   2. point `.cez-fallback` at `dir`;
 *   3. move the files — `rename` when `dir` does not exist yet, otherwise (or on
 *      `EXDEV`, the usual case across temp roots) copy into `dir` and remove the
 *      old directory under a removal receipt, so a removal cut short after the
 *      owner marker went still proves the directory ours on retry;
 *   4. drop `.cez-fallback-previous`.
 * The old directory is moved only when its `.cez-owner` marker is this
 * dataDir's (or a receipt proves it was); anything else refuses the spawn.
 */
function migrateLegacyFallback(dataDir: string, runId: string, dir: string): void {
  const recorded = recordedFallback(dataDir, runId);
  const from = recordedFallback(dataDir, runId, PREVIOUS_LOCATION_FILE)
    ?? (recorded !== undefined && recorded !== dir ? recorded : undefined);
  if (from === undefined) return;
  const local = agentTmpDir(dataDir, runId);
  if (from !== dir) {
    rewriteLocation(dataDir, runId, PREVIOUS_LOCATION_FILE, from);
    if (recorded !== dir) rewriteLocation(dataDir, runId, LOCATION_FILE, dir);
    const removals = readFallbackRemovals(local);
    if (!fallbackOwnedOrAbsent(dataDir, from, removals)) {
      throw new AgentTempDirError(from, new Error('ownership marker was replaced — remove the directory to re-mint it'));
    }
    if (existsSync(from)) moveFallbackScratch(dataDir, local, from, dir, removals);
  }
  rmSync(join(local, PREVIOUS_LOCATION_FILE), { force: true });
}

function moveFallbackScratch(dataDir: string, local: string, from: string, to: string, removals: FallbackRemoval[]): void {
  if (!existsSync(to)) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    }
  }
  mkdirSync(to, { recursive: true, mode: 0o700 });
  // The destination keeps (or gets) its own marker; the source's is never
  // copied over it, so a foreign marker still refuses instead of being replaced.
  writeOwnerMarker(to, dataDir);
  const marker = join(from, OWNER_FILE);
  cpSync(from, to, { recursive: true, force: true, verbatimSymlinks: true, preserveTimestamps: true, filter: (src) => src !== marker });
  checkpointFallbackRemoval(local, from, removals);
  rmSync(from, { recursive: true, force: true });
}

function recordFallback(dataDir: string, runId: string, dir: string): void {
  const local = agentTmpDir(dataDir, runId);
  mkdirSync(local, { recursive: true });
  try {
    writeFileSync(join(local, LOCATION_FILE), dir, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    if (recordedFallback(dataDir, runId) !== dir) {
      throw new AgentTempDirError(local, new Error('recorded fallback directory changed'));
    }
  }
}

/** The first path whose UTF-8 byte length fits the socket budget, or
 *  `undefined` when none does. Pure on purpose (#440): resolution calls it
 *  with the real candidates, tests with synthetic ones, so the nothing-fits
 *  branch stays exercised even though a real platform root is always short. */
export function firstSocketSafeDir(paths: readonly string[]): string | undefined {
  return paths.find(fitsSocketBudget);
}

/**
 * The temp directory this run should use: the repo-local `agentShortTmpDir`
 * when it is short enough for unix-socket paths and no other run's marker
 * claims it, and otherwise a short
 * digest-named directory under the first OS temp root whose candidate fits —
 * the env-honouring root first, the platform default when `TMPDIR` itself is
 * too deep (#387, #440). A recorded location wins across host-env changes
 * while it fits the budget; one recorded under the pre-#1022 ceiling resolves
 * to the fallback that fits now, where `agentTmpEnv` moves its scratch.
 * Read-only resolution — nothing is created, nothing is
 * probed; `agentTmpEnv` owns the side effects.
 */
export function resolveAgentTmpDir(dataDir: string, runId: string): string {
  const recorded = recordedFallback(dataDir, runId);
  // A pointer recorded under the pre-#1022 ceiling is not reused: resolution
  // picks a fallback that fits, and `agentTmpEnv` moves the scratch there.
  if (recorded && fitsSocketBudget(recorded)) return recorded;
  // An id that is not a plain identifier never names a repo-local directory;
  // the digest-named fallback is safe for any input.
  const local = safeRunId(runId) ? agentShortTmpDir(dataDir, runId) : agentTmpDir(dataDir, runId);
  // A legacy pointer's scratch moves to another fallback, never into the
  // repo-local directory: the control directory keeps owning its location.
  if (!recorded && safeRunId(runId) && fitsSocketBudget(local)) {
    const claim = shortTmpDirClaim(local, runId);
    if (claim === 'free' || claim === 'ours') return local;
  }
  const candidates = osTempRoots().map((root) => fallbackTmpDir(root, dataDir, runId));
  const fallback = firstSocketSafeDir(candidates);
  if (fallback) return fallback;
  if (recorded) {
    throw new AgentTempDirError(recorded, new Error(
      `recorded fallback is past the ${MAX_SOCKET_SAFE_DIR_LENGTH}-byte unix socket budget and no OS temp root has a candidate that fits`,
    ));
  }
  // Nothing fits — every root, the platform default included, has a candidate
  // past the cap. Minting any would hand the agent a temp directory that
  // cannot serve unix sockets: the silent failure #387 is about. Fail the
  // spawn with the named error instead; the remedy names the escape.
  const shortest = candidates.reduce((a, b) =>
    Buffer.byteLength(a, 'utf8') < Buffer.byteLength(b, 'utf8') ? a : b);
  throw new AgentTempDirError(
    Buffer.byteLength(shortest) < Buffer.byteLength(local) ? shortest : local,
    new Error(
      `no socket-safe temp directory exists — repo-local path is `
        + `${Buffer.byteLength(local)} bytes and every OS temp root candidate is past the `
        + `${MAX_SOCKET_SAFE_DIR_LENGTH}-byte unix socket budget (tried: `
        + candidates.map((c) => `${c} (${Buffer.byteLength(c)} bytes)`).join(', ') + ')',
    ),
  );
}

/** `errno` → the phrasing a human recognises from their shell. */
const REASONS: Readonly<Record<string, string>> = {
  EDQUOT: 'Disk quota exceeded',
  ENOSPC: 'No space left on device',
  EACCES: 'Permission denied',
  EPERM: 'Operation not permitted',
  EROFS: 'Read-only file system',
};

/**
 * The preflight's failure. Named so the spawn path can tell it apart from an
 * ordinary crash and turn it into the run's `error` — the same treatment
 * `ModelIdentityError` gets, and the same channel the thread footer renders.
 */
export class AgentTempDirError extends Error {
  readonly path: string;

  constructor(path: string, reason: unknown) {
    const code = (reason as NodeJS.ErrnoException | undefined)?.code;
    const why = (code && REASONS[code])
      ?? code
      ?? (reason instanceof Error ? reason.message : String(reason));
    super(
      `agent temp directory is not writable: ${path} (${why}) — free disk space, `
        + 'or set CEZ_AGENT_TMPDIR=0 to fall back to the host TMPDIR',
    );
    this.name = 'AgentTempDirError';
    this.path = path;
  }
}

/** Opt-out spelling matches the house style for default-on behaviour
 *  (`CEZ_AUTONAME=0`): only an exact `0` disables. */
export function agentTmpDirEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_AGENT_TMPDIR !== '0';
}

/** Distinguishes concurrent probes from one process; the pid alone would let two
 *  spawns racing on the same directory delete each other's file mid-probe. */
let probeSeq = 0;

/**
 * Write-probe `dir`. Creating the file is not enough to prove the directory
 * works — a quota-exhausted tmpfs still allocates the inode and only fails the
 * `write(2)` — so the probe writes real bytes and removes them again. A
 * directory that is merely *full but writable* passes, by design.
 */
function probeWritable(dir: string): void {
  const probe = join(dir, `.cez-tmp-probe-${process.pid}-${(probeSeq += 1)}`);
  try {
    writeFileSync(probe, 'cez');
  } catch (err) {
    throw new AgentTempDirError(dir, err);
  } finally {
    try {
      rmSync(probe, { force: true });
    } catch {
      // best-effort: a probe we could not remove is not a reason to fail a run.
    }
  }
}

/**
 * The `TMPDIR`/`TEMP`/`TMP` overrides for this run, after proving the resolved
 * directory actually accepts writes. Throws `AgentTempDirError` when it does
 * not — callers turn that into the run's error rather than spawning.
 *
 * The directory is `resolveAgentTmpDir`'s call: repo-local when that path is
 * short enough for unix-socket paths, a digest-named directory under the OS
 * temp root when the checkout is too deep for one (#387). In the shared OS
 * root the directory is created private to this user (0700); repo-local
 * scratch already sits inside the user's own tree and keeps the default mode
 * it always had.
 *
 * All three spellings are set, on every platform: a tool that reads `TMP` (or
 * `TEMP`) would otherwise keep following the host value straight back to the
 * exhausted directory this exists to escape.
 *
 * Returns `{}` under the opt-out, without probing anything: the hatch turns
 * the whole feature off, preflight included, so it stays an escape someone can
 * actually take.
 */
export function agentTmpEnv(
  dataDir: string,
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!agentTmpDirEnabled(env)) return {};
  const dir = resolveAgentTmpDir(dataDir, runId);
  const repoLocal = safeRunId(runId) && dir === agentShortTmpDir(dataDir, runId);
  try {
    if (repoLocal) {
      adoptLegacyTmpDir(dataDir, runId, dir);
      mkdirSync(dir, { recursive: true });
      writeRunMarker(dir, runId);
    } else {
      // In the shared OS root the directory carries its ownership marker, so a
      // startup sweep from another project can tell it apart from stale
      // scratch (the sweep skips anything whose marker is missing or foreign).
      migrateLegacyFallback(dataDir, runId, dir);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeOwnerMarker(dir, dataDir);
      recordFallback(dataDir, runId, dir);
    }
  } catch (err) {
    if (err instanceof AgentTempDirError) throw err;
    throw new AgentTempDirError(dir, err);
  }
  probeWritable(dir);
  return { TMPDIR: dir, TEMP: dir, TMP: dir };
}

/** Reading a persisted location is not deletion authority. Keep it in holder scans even
 * when its ownership marker is unreadable, so evidence cannot disappear from the proof. */
function fallbackLocations(dataDir: string, runId: string): { paths: string[]; removals: FallbackRemoval[]; complete: boolean } {
  const paths = new Set(osTempRoots().map(root => fallbackTmpDir(root, dataDir, runId)));
  let complete = true, removals: FallbackRemoval[] = [];
  for (const file of [LOCATION_FILE, PREVIOUS_LOCATION_FILE]) {
    try {
      const recorded = recordedFallback(dataDir, runId, file);
      if (recorded) paths.add(recorded);
    } catch { complete = false; }
  }
  // Independent evidence: a damaged receipt must never discard a readable pointer (#738).
  try {
    removals = readFallbackRemovals(agentTmpDir(dataDir, runId));
    for (const { path } of removals) {
      if (!isAbsolute(path) || path !== fallbackTmpDir(dirname(path), dataDir, runId)) { complete = false; continue; }
      paths.add(path);
    }
  } catch { complete = false; }
  return { paths: [...paths], removals, complete };
}

function fallbackOwnedOrAbsent(dataDir: string, path: string, removals: FallbackRemoval[]): boolean {
  let identity: FallbackRemoval;
  try { identity = fallbackIdentity(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
  try { return readFileSync(join(path, OWNER_FILE), 'utf8').trim() === dataDirOwner(dataDir); }
  catch (error) {
    // Only a missing marker during an already-checkpointed removal can use the receipt.
    // Unreadable or foreign ownership remains uncertainty, even after a previous attempt.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return removals.some(record => record.path === path && record.dev === identity.dev &&
      record.ino === identity.ino && record.birthtimeMs === identity.birthtimeMs);
  }
}

/** False includes malformed/unreadable pointers and foreign ownership, never just a missing
 * path in a best-effort list. Call before resource reuse/deletion and preserve the evidence. */
export function agentTmpDirOwnershipProven(dataDir: string, runId: string): boolean {
  if (!safeRunId(runId)) return false;
  try {
    const { paths, removals, complete } = fallbackLocations(dataDir, runId);
    return complete && shortTmpDirClaim(agentShortTmpDir(dataDir, runId), runId) !== 'unknown'
      && paths.every(path => fallbackOwnedOrAbsent(dataDir, path, removals));
  } catch { return false; }
}

/** Every candidate path, including readable pointers whose ownership is still uncertain. */
export function agentTmpDirLocations(dataDir: string, runId: string): string[] {
  return agentTmpDirLocationEvidence(dataDir, runId).paths;
}

/** A clear scan of a partial list cannot settle legacy execution. Completeness is distinct
 * from ownership: neither this list nor a known reboot authorizes resource deletion/reuse. */
export function agentTmpDirLocationEvidence(dataDir: string, runId: string): { paths: string[]; complete: boolean } {
  if (!safeRunId(runId)) return { paths: [], complete: false };
  const { paths, complete } = fallbackLocations(dataDir, runId);
  // The short directory is listed unless its marker positively names another
  // run: an unreadable marker is uncertainty, and uncertainty stays in scans.
  const short = agentShortTmpDir(dataDir, runId);
  const shorts = shortTmpDirClaim(short, runId) === 'other' ? [] : [short];
  return { paths: [agentTmpDir(dataDir, runId), ...shorts, ...paths], complete };
}

/** Only ENOENT proves cleanup finished. Permission/read errors retain the durable intent. */
export function agentTmpDirMayExist(dataDir: string, runId: string): boolean {
  if (!agentTmpDirOwnershipProven(dataDir, runId)) return true;
  return agentTmpDirLocations(dataDir, runId).some(path => {
    try { lstatSync(path); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
  });
}

/**
 * Reap one task's directory after terminal completion or history deletion.
 * Session close alone is not completion: a live task's Continue must retain
 * its files. Never throws — reaping must not break a terminal transition.
 *
 * The repo-local directories (the short one unless its marker names another
 * run, and the control directory) and the digest name under EVERY root are
 * tried,
 * because the resolution depends on the lengths of `dataDir` and the ambient
 * `TMPDIR`, either of which a Continue, a re-base or a changed env can move
 * between mint and reap; removing a name that was never minted is a no-op, so
 * trying them all is pure safety.
 */
export function removeAgentTmpDir(dataDir: string, runId: string): void {
  reapAgentTmpDir(dataDir, runId, false);
}

/** `spareUnclaimedShort` keeps a markerless short directory: the startup sweep
 *  sets it when a kept run's `agentShortTmpDir` lands on the same name, because
 *  that run may have created or adopted the directory and crashed before
 *  publishing its marker (hearsay-tools/cezarion#1037) — it is that run's
 *  Continue scratch, not this orphan's. */
function reapAgentTmpDir(dataDir: string, runId: string, spareUnclaimedShort: boolean): void {
  if (!safeRunId(runId)) return;
  const local = agentTmpDir(dataDir, runId);
  try {
    const { paths, removals, complete } = fallbackLocations(dataDir, runId);
    if (!complete || !paths.every(path => fallbackOwnedOrAbsent(dataDir, path, removals))) return;
    for (const path of paths) {
      try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      // Commit verified directory ownership before recursive rm can remove its marker.
      checkpointFallbackRemoval(local, path, readFallbackRemovals(local));
      rmSync(path, { recursive: true, force: true });
      try { lstatSync(path); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    // The short directory goes only when it is this run's (or unclaimed): a
    // colliding name may be another run's live scratch.
    const short = agentShortTmpDir(dataDir, runId);
    const claim = shortTmpDirClaim(short, runId);
    if (claim === 'unknown') return;
    if (claim === 'ours' || (claim === 'free' && !spareUnclaimedShort)) rmSync(short, { recursive: true, force: true });
    // The durable location and partial-removal receipts are last, never before a fallback.
    rmSync(local, { recursive: true, force: true });
  } catch {
    // Any failed read/removal preserves the local pointer and independently retried intent.
  }
}

/**
 * Remove every per-run directory that is not in `keepRunIds` — the startup
 * sweep, so a crash (which never reaches the terminal-transition reap) cannot
 * accumulate them forever. Four confined sets are swept and nothing else:
 *
 *   - `<dataDir>/tmp`, where entries ARE the run ids (reports the ids reaped);
 *   - `<dataDir>/t` (hearsay-tools/cezarion#1022), where an entry is removed
 *     when its `.cez-run` marker names a run that is not kept, or when it has
 *     no marker and no kept run's `agentShortTmpDir` lands on it (reports the
 *     marker's run id, else the name); an unreadable marker is never ours to
 *     remove;
 *   - the `cez-agent-<12 hex>` directories under EVERY OS temp root — the
 *     env-honouring root and the platform default (#440) — where the name
 *     digests the dataDir and is not reversible to a run id (reports the
 *     directory names reaped). The pattern is exact — prefix, lowercase hex,
 *     fixed length, directories only — and a directory is removed only when
 *     its `.cez-owner` marker names THIS dataDir and none of this dataDir's
 *     kept runs claims it, so another project's scratch in a shared root is
 *     never touched.
 */
export function sweepAgentTmpDirs(dataDir: string, keepRunIds: Iterable<string>): string[] {
  // Private worker evidence outlives corrupt/missing/quarantined index rows. Both local
  // and digest-named fallback scratch belong to deferred cleanup, not this orphan sweep.
  const workers = workerEvidenceRunIds(dataDir);
  if (!workers) return []; // unreadable evidence directory is not proof of absence
  const keep = new Set([...keepRunIds, ...workers]);
  const reaped: string[] = [];
  let entries: string[];
  // Short names a kept run resolves to. Computed before the legacy loop, which
  // must spare them too: a markerless one is a kept run's, mid-mint.
  const claimedShort = new Set([...keep].filter(safeRunId).map((id) => basename(agentShortTmpDir(dataDir, id))));
  const root = agentTmpRoot(dataDir);
  if (existsSync(root)) {
    try {
      entries = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (keep.has(name) || !safeRunId(name)) continue;
      try {
        const locations = agentTmpDirLocations(dataDir, name).filter(dir => existsSync(dir));
        reapAgentTmpDir(dataDir, name, claimedShort.has(basename(agentShortTmpDir(dataDir, name))));
        reaped.push(...locations.filter(dir => !existsSync(dir)).map(dir => basename(dir)));
      } catch {
        // best-effort: a locked directory is retried on the next boot.
      }
    }
  }
  // The hearsay-tools/cezarion#1022 short directories. Every entry here is this
  // dataDir's own, so no ownership marker is needed — only the claim check
  // that keeps a kept run's directory, and a colliding name's, alive.
  const shortRoot = join(dataDir, SHORT_TMP_ROOT);
  if (existsSync(shortRoot)) {
    let shortEntries: string[];
    try {
      shortEntries = readdirSync(shortRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      shortEntries = [];
    }
    for (const name of shortEntries) {
      if (!safeRunId(name)) continue;
      const owner = readRunMarker(join(shortRoot, name));
      if (owner === undefined) continue; // unreadable marker: unknown ownership is never ours to remove.
      // A marker that is a proper prefix of a kept run's id is that run's, cut short.
      if (owner === null ? claimedShort.has(name) : [...keep].some((id) => id.startsWith(owner))) continue;
      try {
        rmSync(join(shortRoot, name), { recursive: true, force: true });
        reaped.push(owner ?? name);
      } catch {
        // best-effort: a locked directory is retried on the next boot.
      }
    }
  }
  // The #387 fallback locations, in every shared OS temp root. Kept narrow on
  // purpose: exact prefix, 12 lowercase-hex name, directories only, and
  // ownership — a directory is removed only when its `.cez-owner` marker
  // names THIS dataDir (a marker that is missing or foreign is another
  // project's, or unknown, and is never ours to remove) and none of this
  // dataDir's kept runs claims it.
  const owner = dataDirOwner(dataDir);
  const claimed = new Set(
    [...keep].filter(safeRunId).map((id) => basename(fallbackTmpDir(osTempRoot(), dataDir, id))),
  );
  for (const osRoot of osTempRoots()) {
    let fallbackEntries: Dirent[];
    try {
      fallbackEntries = readdirSync(osRoot, { withFileTypes: true });
    } catch {
      continue; // an unreadable root is skipped, not fatal: others remain.
    }
    for (const entry of fallbackEntries) {
      if (!entry.isDirectory() || !entry.name.startsWith(FALLBACK_PREFIX)) continue;
      if (!/^[0-9a-f]{12}$/.test(entry.name.slice(FALLBACK_PREFIX.length))) continue;
      let entryOwner: string;
      try {
        entryOwner = readFileSync(join(osRoot, entry.name, OWNER_FILE), 'utf8').trim();
      } catch {
        continue; // no readable marker: unknown ownership is never ours to remove.
      }
      if (entryOwner !== owner) continue;
      if (claimed.has(entry.name)) continue;
      try {
        rmSync(join(osRoot, entry.name), { recursive: true, force: true });
        reaped.push(entry.name);
      } catch {
        // best-effort: a locked directory is retried on the next boot.
      }
    }
  }
  return reaped;
}
