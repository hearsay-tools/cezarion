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
 *   1. **Isolation** — each run gets `<dataDir>/tmp/<runId>`, on the same disk
 *      as the run's own state rather than a shared tmpfs, reaped when the run
 *      ends. `buildChildEnv` applies the per-run env last, so these values win
 *      over the host's without any allowlist change.
 *   2. **Fail loud** — the directory is write-probed before the backend spawns.
 *      A run that cannot get a working temp directory fails immediately with a
 *      named, actionable error instead of spawning an agent that will run blind.
 *   3. **Short enough to bind** (#387) — tools bind *named* unix sockets under
 *      `TMPDIR` (tsx's IPC server lays down `<tmpdir>/tsx-<uid>/<pid>.pipe`,
 *      Chrome a `SingletonSocket`), and the kernel caps a socket path at
 *      `sun_path` — 108 bytes on Linux, 104 on macOS, NUL included. A checkout
 *      deep enough (Cezar's own nested task worktrees land past 100 chars)
 *      pushed every such bind past the cap and broke `npm install` and
 *      typechecking inside the run. A directory that would land too deep
 *      resolves instead to a short digest-named directory under the OS temp
 *      root — still per-run, still probed, still reaped. A repo whose own path
 *      already fits keeps today's directory, byte for byte.
 *
 * `CEZ_AGENT_TMPDIR=0` opts out of ALL THREE — cezar keeps its hands off the
 * temp directory entirely and the pre-#785 behaviour is back, byte for byte.
 * That is deliberate: an escape hatch that still imposed the preflight would be
 * a hatch you cannot actually escape through, and this repo's
 * graceful-degradation rule says a new check must never become the only way to
 * run.
 */
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/** Run ids are uuids; anything else must never reach a recursive `rmSync`.
 *
 *  `.` and `..` are excluded explicitly, not as pedantry: they match the
 *  character class, and `join(dataDir, 'tmp', '..')` resolves to `<dataDir>`
 *  itself — a recursive removal of every run's state. A guard that admits the
 *  one input capable of turning this helper into data loss is not a guard. */
function safeRunId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..';
}

/** Where a run's agent-scoped temp directory lives. */
export function agentTmpDir(dataDir: string, runId: string): string {
  return join(dataDir, 'tmp', runId);
}

/** The root every per-run directory hangs off — the ONLY tree this module
 *  removes anything from (`runs/`, `runs.json` and `worktrees/` are siblings). */
function agentTmpRoot(dataDir: string): string {
  return join(dataDir, 'tmp');
}

/**
 * The longest a per-run temp directory may be so that tools binding named
 * unix sockets under it still work (#387), measured in UTF-8 bytes — the
 * kernel bounds the encoded path, not the JavaScript character count.
 * `sockaddr_un.sun_path` holds 108 bytes on Linux and 104 on macOS, NUL
 * included; the longest name a known tool lays down under TMPDIR is tsx's IPC
 * socket, `<tmpdir>/tsx-<uid>/<pid>.pipe`, ~22 bytes (Chrome's
 * `SingletonSocket` is 16). A 78-byte ceiling leaves ≥25 bytes of headroom on
 * the tighter platform — past anything these tools generate — while keeping
 * ordinary checkouts on their repo-local scratch: only a genuinely deep path,
 * like the 100-character directories #387 reports, moves to the fallback.
 */
export const MAX_SOCKET_SAFE_DIR_LENGTH = 78;

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

const FALLBACK_PREFIX = 'cez-agent-';
const FALLBACK_NAME_LENGTH = 12;

/**
 * Where the fallback lives for this dataDir+run pair. The name digests the
 * dataDir in, because the OS temp root is SHARED: a name derived from the run
 * id alone would let one repo's reap or sweep delete another repo's live
 * scratch when two run ids happen to share their leading characters.
 */
function fallbackTmpDir(dataDir: string, runId: string): string {
  const digest = createHash('sha256').update(`${dataDir}:${runId}`).digest('hex');
  return join(osTempRoot(), FALLBACK_PREFIX + digest.slice(0, FALLBACK_NAME_LENGTH));
}

/**
 * The temp directory this run should use: the repo-local per-run directory
 * when it is short enough for unix-socket paths, and a short directory under
 * the OS temp root when it is not (#387). Pure resolution — nothing is
 * created, nothing is probed; `agentTmpEnv` owns the side effects.
 */
export function resolveAgentTmpDir(dataDir: string, runId: string): string {
  const local = agentTmpDir(dataDir, runId);
  if (Buffer.byteLength(local, 'utf8') <= MAX_SOCKET_SAFE_DIR_LENGTH) return local;
  const fallback = fallbackTmpDir(dataDir, runId);
  if (Buffer.byteLength(fallback, 'utf8') <= MAX_SOCKET_SAFE_DIR_LENGTH) return fallback;
  // No candidate fits (a pathological host TMPDIR over a pathological repo
  // path together): keep whichever leaves socket names the most room.
  return Buffer.byteLength(fallback) < Buffer.byteLength(local) ? fallback : local;
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
 *  (`CEZ_AUTONAME=0`, `CEZ_SKILLS_AUTO_UPDATE=0`): only an exact `0` disables. */
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
  const local = agentTmpDir(dataDir, runId);
  const dir = resolveAgentTmpDir(dataDir, runId);
  try {
    mkdirSync(dir, dir === local ? { recursive: true } : { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new AgentTempDirError(dir, err);
  }
  probeWritable(dir);
  return { TMPDIR: dir, TEMP: dir, TMP: dir };
}

/**
 * Reap one run's directory. Scratch, not an artifact: nothing reads it once the
 * agent is gone, and a Continue re-creates it through `agentTmpEnv`. Never
 * throws — reaping must not break a terminal transition.
 *
 * Both locations are tried because the resolution depends on the length of
 * `dataDir`, which a Continue or a re-base can change between mint and reap;
 * removing a name that was never minted is a no-op, so trying both is pure
 * safety.
 */
export function removeAgentTmpDir(dataDir: string, runId: string): void {
  if (!safeRunId(runId)) return;
  for (const dir of [agentTmpDir(dataDir, runId), fallbackTmpDir(dataDir, runId)]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort; the startup sweep picks up whatever survives.
    }
  }
}

/**
 * Remove every per-run directory that is not in `keepRunIds` — the startup
 * sweep, so a crash (which never reaches the terminal-transition reap) cannot
 * accumulate them forever. Two confined roots are swept and nothing else:
 *
 *   - `<dataDir>/tmp`, where entries ARE the run ids (reports the ids reaped);
 *   - the OS temp root's `cez-agent-<12 hex>` directories (#387), where the
 *     name digests the dataDir and is not reversible to a run id (reports the
 *     directory names reaped). The pattern is exact — prefix, lowercase hex,
 *     fixed length, directories only — and a directory is removed only when
 *     THIS dataDir cannot claim it, so another repo's scratch in the shared
 *     root is never touched.
 */
export function sweepAgentTmpDirs(dataDir: string, keepRunIds: Iterable<string>): string[] {
  const keep = new Set(keepRunIds);
  const reaped: string[] = [];
  let entries: string[];
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
        rmSync(join(root, name), { recursive: true, force: true });
        reaped.push(name);
      } catch {
        // best-effort: a locked directory is retried on the next boot.
      }
    }
  }
  // The #387 fallback location, in the shared OS temp root. Kept narrow on
  // purpose: exact prefix, 12 lowercase-hex name, directories only, and only
  // names this dataDir cannot claim.
  const claimed = new Set(
    [...keep].filter(safeRunId).map((id) => basename(fallbackTmpDir(dataDir, id))),
  );
  const osRoot = osTempRoot();
  let fallbackEntries: Dirent[];
  try {
    fallbackEntries = readdirSync(osRoot, { withFileTypes: true });
  } catch {
    return reaped;
  }
  for (const entry of fallbackEntries) {
    if (!entry.isDirectory() || !entry.name.startsWith(FALLBACK_PREFIX)) continue;
    if (!/^[0-9a-f]{12}$/.test(entry.name.slice(FALLBACK_PREFIX.length))) continue;
    if (claimed.has(entry.name)) continue;
    try {
      rmSync(join(osRoot, entry.name), { recursive: true, force: true });
      reaped.push(entry.name);
    } catch {
      // best-effort: a locked directory is retried on the next boot.
    }
  }
  return reaped;
}
