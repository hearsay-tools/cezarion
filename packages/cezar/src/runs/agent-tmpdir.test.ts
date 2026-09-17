import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentTempDirError,
  MAX_SOCKET_SAFE_DIR_LENGTH,
  agentTmpDir,
  agentTmpDirEnabled,
  agentTmpEnv,
  removeAgentTmpDir,
  resolveAgentTmpDir,
  sweepAgentTmpDirs,
} from './agent-tmpdir.ts';

/**
 * #785: every agent shared the host's temp directory, and when that directory
 * stopped accepting writes the Claude backend's output capture silently
 * truncated to nothing. These cover the two properties that fix it — a per-run
 * directory, and a preflight that fails loudly instead of spawning blind — plus
 * the reaping that keeps the first one from becoming its own leak.
 */
describe('agentTmpEnv — per-run temp directory (#785)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(realpathSync(tmpdir()), 'cez-agent-tmpdir-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('gives the run its own directory and creates it before the backend spawns', () => {
    const env = agentTmpEnv(dataDir, 'run-a', {});
    expect(env.TMPDIR).toBe(agentTmpDir(dataDir, 'run-a'));
    expect(env.TMPDIR).toBe(join(dataDir, 'tmp', 'run-a'));
    expect(existsSync(env.TMPDIR as string)).toBe(true);
  });

  // A tool that reads TMP (or TEMP) would otherwise follow the host value straight
  // back to the exhausted directory this whole change exists to escape.
  it('sets all three spellings, so nothing falls back to the host value', () => {
    const env = agentTmpEnv(dataDir, 'run-b', {});
    expect(env.TEMP).toBe(env.TMPDIR);
    expect(env.TMP).toBe(env.TMPDIR);
  });

  it('keeps runs out of each other’s scratch', () => {
    expect(agentTmpEnv(dataDir, 'run-a', {}).TMPDIR)
      .not.toBe(agentTmpEnv(dataDir, 'run-b', {}).TMPDIR);
  });

  it('fails with a named, actionable error when the directory cannot be created', () => {
    // `<dataDir>/tmp` occupied by a FILE — mkdir cannot make the run's directory
    // under it. Deterministic and portable, unlike simulating a quota.
    writeFileSync(join(dataDir, 'tmp'), 'not a directory', 'utf8');
    let thrown: unknown;
    try {
      agentTmpEnv(dataDir, 'run-c', {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AgentTempDirError);
    expect((thrown as Error).message).toContain('agent temp directory is not writable');
    expect((thrown as Error).message).toContain(join(dataDir, 'tmp', 'run-c'));
    // The remedy names the opt-out, so the message alone is enough to act on.
    expect((thrown as Error).message).toContain('CEZ_AGENT_TMPDIR=0');
  });

  // The failure this exists for is a directory that exists and accepts an inode but
  // rejects the write (`EDQUOT`). A read-only directory is the portable stand-in —
  // skipped under root, which ignores the mode bits.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails when the directory exists but rejects writes',
    () => {
      const dir = agentTmpDir(dataDir, 'run-d');
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o500);
      try {
        expect(() => agentTmpEnv(dataDir, 'run-d', {})).toThrow(AgentTempDirError);
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );

  it('a writable directory passes, and the probe leaves nothing behind', () => {
    const env = agentTmpEnv(dataDir, 'run-e', {});
    expect(readdirSync(env.TMPDIR as string)).toEqual([]);
  });

  describe('CEZ_AGENT_TMPDIR=0 opt-out', () => {
    it('leaves the host TMPDIR in force and mints no directory', () => {
      const host = mkdtempSync(join(realpathSync(tmpdir()), 'cez-host-tmp-'));
      try {
        const env = agentTmpEnv(dataDir, 'run-f', { CEZ_AGENT_TMPDIR: '0', TMPDIR: host });
        expect(env).toEqual({});
        expect(existsSync(agentTmpDir(dataDir, 'run-f'))).toBe(false);
      } finally {
        rmSync(host, { recursive: true, force: true });
      }
    });

    // The hatch turns the whole feature off, preflight included. An escape hatch
    // that still imposed the new check would be one you cannot escape through,
    // and a run that used to start must still start with it set.
    it('does not preflight anything either, however broken the host TMPDIR is', () => {
      expect(() =>
        agentTmpEnv(dataDir, 'run-g', {
          CEZ_AGENT_TMPDIR: '0',
          TMPDIR: join(dataDir, 'does-not-exist'),
        }),
      ).not.toThrow();
    });

    it('is not fooled by an unusable directory it would otherwise have minted', () => {
      writeFileSync(join(dataDir, 'tmp'), 'not a directory', 'utf8');
      expect(agentTmpEnv(dataDir, 'run-h', { CEZ_AGENT_TMPDIR: '0' })).toEqual({});
    });

    it('only an exact "0" disables it', () => {
      expect(agentTmpDirEnabled({})).toBe(true);
      expect(agentTmpDirEnabled({ CEZ_AGENT_TMPDIR: '1' })).toBe(true);
      expect(agentTmpDirEnabled({ CEZ_AGENT_TMPDIR: 'false' })).toBe(true);
      expect(agentTmpDirEnabled({ CEZ_AGENT_TMPDIR: '0' })).toBe(false);
    });
  });
});

describe('reaping the per-run temp directories (#785)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(realpathSync(tmpdir()), 'cez-agent-tmpdir-reap-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('removes one run’s directory and everything in it', () => {
    const dir = agentTmpEnv(dataDir, 'run-a', {}).TMPDIR as string;
    writeFileSync(join(dir, 'scratch.txt'), 'x', 'utf8');
    removeAgentTmpDir(dataDir, 'run-a');
    expect(existsSync(dir)).toBe(false);
  });

  it('is idempotent and never throws on a directory that is already gone', () => {
    expect(() => removeAgentTmpDir(dataDir, 'never-existed')).not.toThrow();
  });

  // Path-traversal guard: a run id is a uuid, and nothing that is not one may ever
  // reach a recursive rmSync.
  it('refuses a run id that is not a plain identifier', () => {
    const sibling = join(dataDir, 'runs');
    mkdirSync(sibling, { recursive: true });
    removeAgentTmpDir(dataDir, '../runs');
    expect(existsSync(sibling)).toBe(true);
  });

  // The one input that turns this helper into data loss: `join(dataDir, 'tmp', '..')`
  // is `<dataDir>` itself, so a guard that admits it would recursively remove every
  // run's state — runs.json included.
  it.each(['.', '..'])('refuses the relative id %j, which would resolve onto dataDir', (id) => {
    writeFileSync(join(dataDir, 'runs.json'), '[]', 'utf8');
    agentTmpEnv(dataDir, 'live', {});
    removeAgentTmpDir(dataDir, id);
    expect(existsSync(join(dataDir, 'runs.json'))).toBe(true);
    expect(existsSync(agentTmpDir(dataDir, 'live'))).toBe(true);
  });

  it('sweeps orphans left by a crash while keeping the live runs', () => {
    agentTmpEnv(dataDir, 'live', {});
    agentTmpEnv(dataDir, 'orphan-1', {});
    agentTmpEnv(dataDir, 'orphan-2', {});
    const reaped = sweepAgentTmpDirs(dataDir, ['live']);
    expect(reaped.sort()).toEqual(['orphan-1', 'orphan-2']);
    expect(existsSync(agentTmpDir(dataDir, 'live'))).toBe(true);
    expect(existsSync(agentTmpDir(dataDir, 'orphan-1'))).toBe(false);
  });

  // BACKWARD_COMPATIBILITY §3: `.ai/cezar/` is a protected surface. The sweep is
  // confined to its own `tmp/` subtree and must never see a sibling.
  it('never touches sibling run state', () => {
    agentTmpEnv(dataDir, 'orphan', {});
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    writeFileSync(join(dataDir, 'runs.json'), '[]', 'utf8');
    writeFileSync(join(dataDir, 'runs', 'a.ndjson'), '{}', 'utf8');
    sweepAgentTmpDirs(dataDir, []);
    expect(existsSync(join(dataDir, 'runs.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'runs', 'a.ndjson'))).toBe(true);
  });

  it('is a no-op before any run has minted a directory', () => {
    expect(sweepAgentTmpDirs(dataDir, [])).toEqual([]);
  });
});

/**
 * #387: tools bind NAMED unix sockets under TMPDIR, and the kernel caps a
 * socket path at `sun_path` — 108 bytes on Linux, 104 on macOS, NUL included.
 * tsx alone builds `<tmpdir>/tsx-<uid>/<pid>.pipe` (~23 extra bytes) for its
 * IPC server, so a per-run directory from a deep checkout (Cezar's own task
 * worktrees land well past 100) pushed every such bind past the cap and broke
 * `npm install`/typechecking inside the run. The directory must stay short
 * enough that those names still fit.
 */
describe('socket-safe temp directory length (#387)', () => {
  let deepPrefix: string;
  const minted: string[] = [];

  const osRoot = (): string => realpathSync(tmpdir());

  /** A dataDir whose `<dataDir>/tmp/<runId>` lands far past the socket cap. */
  const deepDataDir = (): string => {
    deepPrefix = join(osRoot(), `cez-deep-${'d'.repeat(80)}`);
    return join(deepPrefix, 'repo', '.ai', 'cezar');
  };

  const mint = (dir: string, runId: string): string => {
    const tmp = agentTmpEnv(dir, runId, {}).TMPDIR as string;
    minted.push(tmp);
    return tmp;
  };

  afterEach(() => {
    for (const dir of minted) rmSync(dir, { recursive: true, force: true });
    minted.length = 0;
    if (deepPrefix) rmSync(deepPrefix, { recursive: true, force: true });
  });

  it('resolves a per-run directory short enough for tsx’s named IPC socket', async () => {
    const runId = '0f1e2d3c-4b5a-49f8-8a11-aabbccddeeff';
    const dir = mint(deepDataDir(), runId);
    expect(dir.length).toBeLessThanOrEqual(MAX_SOCKET_SAFE_DIR_LENGTH);
    // The exact name tsx binds (`tsx/dist` get-pipe-path + temporary-directory:
    // join(tmpdir(), `tsx-${uid}`, `${pid}.pipe`), served by net.createServer).
    const ipcDir = join(dir, `tsx-${process.getuid?.() ?? 1000}`);
    mkdirSync(ipcDir, { recursive: true });
    const server = createServer();
    const bound = new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    server.listen(join(ipcDir, `${process.pid}.pipe`));
    await bound;
    server.close();
  });

  it('moves a too-long directory under the OS temp root, still one per run', () => {
    const root = osRoot();
    const a = mint(deepDataDir(), '11111111-2222-4333-8444-555566667777');
    const b = mint(deepDataDir(), '99999999-8888-4777-8666-555566667777');
    for (const dir of [a, b]) {
      expect(dir.startsWith(root)).toBe(true);
      expect(basename(dir).startsWith('cez-agent-')).toBe(true);
    }
    expect(a).not.toBe(b);
  });

  it('stays repo-local up to the cap and falls back one byte past it', () => {
    const root = osRoot();
    // `join(dataDir, 'tmp', 'run-a')` = root + '/' + pad + '/' + 'tmp/run-a'.
    const padFor = (target: number): string =>
      'p'.repeat(target - root.length - 'tmp/run-a'.length - 2);
    const at = join(root, padFor(78));
    const over = join(root, 'q'.repeat(79 - root.length - 'tmp/run-a'.length - 2));
    expect(join(at, 'tmp', 'run-a').length).toBe(78);
    expect(join(over, 'tmp', 'run-a').length).toBe(79);
    try {
      expect(agentTmpEnv(at, 'run-a', {}).TMPDIR).toBe(join(at, 'tmp', 'run-a'));
      const fell = agentTmpEnv(over, 'run-a', {}).TMPDIR as string;
      minted.push(fell);
      expect(fell).not.toBe(join(over, 'tmp', 'run-a'));
      expect(fell.length).toBeLessThanOrEqual(MAX_SOCKET_SAFE_DIR_LENGTH);
    } finally {
      rmSync(at, { recursive: true, force: true });
      rmSync(over, { recursive: true, force: true });
    }
  });

  it('resolveAgentTmpDir answers without minting anything', () => {
    const dir = resolveAgentTmpDir(deepDataDir(), '22222222-3333-4444-8555-666677778888');
    expect(dir.length).toBeLessThanOrEqual(MAX_SOCKET_SAFE_DIR_LENGTH);
    expect(existsSync(dir)).toBe(false);
  });

  it('measures the cap in bytes, so a multibyte path cannot hide past it', () => {
    const root = osRoot();
    // 'é' is one JS character but two UTF-8 bytes: the kernel bounds the byte
    // length, so a directory whose string length fits while its byte length
    // crosses the cap must still fall back.
    const pad = 'é'.repeat(Math.max(1, Math.floor((90 - Buffer.byteLength(root)) / 2)));
    const dir = join(root, pad);
    const local = join(dir, 'tmp', 'run-a');
    expect(local.length).toBeLessThanOrEqual(MAX_SOCKET_SAFE_DIR_LENGTH);
    expect(Buffer.byteLength(local)).toBeGreaterThan(MAX_SOCKET_SAFE_DIR_LENGTH);
    const resolved = resolveAgentTmpDir(dir, 'run-a');
    expect(resolved).not.toBe(local);
    expect(Buffer.byteLength(resolved)).toBeLessThanOrEqual(MAX_SOCKET_SAFE_DIR_LENGTH);
  });

  it('reaps the fallback when the run ends', () => {
    const dir = deepDataDir();
    const runId = 'aaaa2222-bbbb-4ccc-8ddd-eeeeffff0001';
    expect(existsSync(mint(dir, runId))).toBe(true);
    removeAgentTmpDir(dir, runId);
    expect(existsSync(resolveAgentTmpDir(dir, runId))).toBe(false);
  });

  it('sweeps orphaned fallback directories and keeps the live ones', () => {
    const dir = deepDataDir();
    const liveId = 'aaaa2222-0000-4000-8000-000000000001';
    const orphanId = 'aaaa2222-0000-4000-8000-000000000002';
    const live = mint(dir, liveId);
    const orphan = mint(dir, orphanId);
    // Both runs resolved past the cap, so both live in the OS temp root under
    // digest names — not in the checkout, where the old sweep would find them.
    expect(basename(live)).toMatch(/^cez-agent-/);
    expect(basename(orphan)).toMatch(/^cez-agent-/);
    const reaped = sweepAgentTmpDirs(dir, [liveId]);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    // The fallback name digests the dataDir, so it is not reversible to a run
    // id — the sweep reports the directory names it removed instead.
    expect(reaped).toContain(basename(orphan));
  });

  it('never sweeps a foreign name in the shared OS temp root', () => {
    // The mkdtemp shape every other suite in this repo uses — prefix only.
    const sharedPrefix = join(osRoot(), 'cez-agent-tmpdir-fixture');
    const unrelated = join(osRoot(), 'cez-other-abcdefghijkl');
    const notADir = join(osRoot(), 'cez-agent-abcdefghijkl');
    // Pattern-perfect but carrying no ownership marker: never ours to remove.
    const ownerless = join(osRoot(), 'cez-agent-000000000001');
    mkdirSync(sharedPrefix, { recursive: true });
    mkdirSync(unrelated, { recursive: true });
    mkdirSync(ownerless, { recursive: true });
    writeFileSync(notADir, 'x', 'utf8');
    try {
      sweepAgentTmpDirs(deepDataDir(), []);
      expect(existsSync(sharedPrefix)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
      expect(existsSync(notADir)).toBe(true);
      expect(existsSync(ownerless)).toBe(true);
    } finally {
      rmSync(sharedPrefix, { recursive: true, force: true });
      rmSync(unrelated, { recursive: true, force: true });
      rmSync(notADir, { force: true });
      rmSync(ownerless, { recursive: true, force: true });
    }
  });

  it('never sweeps another dataDir’s fallback directory', () => {
    // A second checkout is a second cezar project with live runs of its own;
    // its fallback directories sit in the SAME shared root and must survive
    // this dataDir's startup sweep untouched.
    const mine = deepDataDir();
    const theirsRoot = join(osRoot(), `cez-deep-${'o'.repeat(80)}`);
    const theirs = join(theirsRoot, 'other', '.ai', 'cezar');
    const theirDir = mint(theirs, '33333333-4444-4555-8666-777788889999');
    try {
      const reaped = sweepAgentTmpDirs(mine, []);
      expect(existsSync(theirDir)).toBe(true);
      expect(reaped).not.toContain(basename(theirDir));
    } finally {
      rmSync(theirsRoot, { recursive: true, force: true });
    }
  });
});
