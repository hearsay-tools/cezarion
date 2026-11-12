import { Home } from '../home/home.ts';
import { useTestHome } from '../home/test-home.testkit.ts';
import { resolveHome } from '../home/resolve.ts'; // test-home-read: import for the annotated sandbox and refusal probes
const testHome = (env: NodeJS.ProcessEnv = process.env) => resolveHome({ purpose: 'cli', env, layout: 'legacy' }); // test-home-read: resolve pinned fixtures or the fake-account refusal target
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir, userInfo } from 'node:os'; // test-home-read: import for the annotated sandbox and refusal probes
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSquawkHomeWriteIsSandboxed, workspaceConfigPath } from '../paths.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from './config.ts';

vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, userInfo: vi.fn(os.userInfo) };
});

/**
 * The registry-clobber regression. A cezar test run used to be able to replace
 * the developer's real `~/.cezar/config.json` with a fixture's projects: the
 * `CEZ_HOME` pin lives in `process.env`, a timing-out test drops it in
 * `afterEach` while a merge-write is still in flight, and the write then
 * resolved a different home than the read. These cases lock in the two
 * defences — one resolved path per merge-write, and a hard refusal to write
 * into the real cezar home from a test process.
 */
describe('cezar home write safety', () => {
  const originalCezHome = process.env.CEZ_HOME;
  const originalHome = process.env.HOME;
  let pinned: string;
  let elsewhere: string;
  let fakeUserHome: string;

  beforeEach(() => {
    const base = realpathSync(tmpdir());
    pinned = mkdtempSync(join(base, 'cez-home-safety-pinned-'));
    elsewhere = mkdtempSync(join(base, 'cez-home-safety-elsewhere-'));
    fakeUserHome = mkdtempSync(join(base, 'cez-home-safety-user-'));
    useTestHome(pinned ? Home.sandbox(pinned, { layout: 'legacy' }) : undefined);
  });

  afterEach(() => {
    if (originalCezHome === undefined) useTestHome(undefined);
    else useTestHome(originalCezHome ? Home.sandbox(originalCezHome, { layout: 'legacy' }) : undefined);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    vi.mocked(userInfo).mockRestore();
    for (const dir of [pinned, elsewhere, fakeUserHome]) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a merge-write inside one file when CEZ_HOME moves mid-flight', async () => {
    await mergeWriteWorkspaceConfig((config) => {
      // Exactly what a test's afterEach does to an orphaned write: the pin is
      // gone by the time the write runs. The write must still land where the
      // read came from.
      useTestHome(elsewhere ? Home.sandbox(elsewhere, { layout: 'legacy' }) : undefined);
      config.projects.push({
        id: 'shop',
        root: '/tmp/shop',
        name: 'shop',
        addedAt: '',
        lastOpenedAt: '',
        source: 'local',
      });
    }, testHome());

    const written: unknown = JSON.parse(readFileSync(join(pinned, 'config.json'), 'utf8'));
    expect(written).toMatchObject({ projects: [{ id: 'shop' }] });
    expect(existsSync(join(elsewhere, 'config.json'))).toBe(false);
  });

  it('reads back what the mid-flight write stored, from the same file', async () => {
    await mergeWriteWorkspaceConfig((config) => {
      config.projects.push({
        id: 'shop',
        root: '/tmp/shop',
        name: 'shop',
        addedAt: '',
        lastOpenedAt: '',
        source: 'local',
      });
    }, testHome());
    useTestHome(pinned ? Home.sandbox(pinned, { layout: 'legacy' }) : undefined);
    expect((await loadWorkspaceConfig(testHome().workspaceConfig)).projects.map((p) => p.id)).toEqual(['shop']);
  });

  it('refuses a write into the real cezar home while running under vitest', async () => {
    // Reload the writer so its guard observes this file's OS-account mock after shared setup.
    vi.resetModules();
    const { atomicWriteJsonSync } = await import('./config.ts');
    // Model the account home without ever writing the host account's files.
    vi.mocked(userInfo).mockReturnValue({ ...userInfo(), homedir: fakeUserHome });
    process.env.HOME = fakeUserHome;
    useTestHome(undefined);
    const target = workspaceConfigPath(undefined, testHome());

    expect(target).toBe(join(fakeUserHome, '.cezar', 'config.json'));
    expect(() => atomicWriteJsonSync(target, { projects: [] })).toThrow(/CEZ_HOME is not pinned/);
    expect(existsSync(join(fakeUserHome, '.cezar'))).toBe(false);
  });

  it('leaves an existing real-home registry byte-for-byte intact when a leaked write is refused', async () => {
    vi.resetModules();
    const { atomicWriteJsonSync } = await import('./config.ts');
    // Model the account home without ever writing the host account's files.
    vi.mocked(userInfo).mockReturnValue({ ...userInfo(), homedir: fakeUserHome });
    process.env.HOME = fakeUserHome;
    useTestHome(undefined);
    const target = workspaceConfigPath(undefined, testHome());
    const existing = '{"projects":[{"id":"real","root":"/repos/real"}]}\n';
    mkdirSync(join(fakeUserHome, '.cezar'), { recursive: true });
    writeFileSync(target, existing);

    expect(() => atomicWriteJsonSync(target, { projects: [] })).toThrow(/refusing to write/);
    expect(readFileSync(target, 'utf8')).toBe(existing);
  });

  it('survives a real, timing-out suite run: the home registry is never created', () => {
    // The reproduction from the bug report, run for real: part of the workspace
    // CLI suite with a timeout short enough that every case is killed mid-write,
    // pointed at a throwaway HOME and started with no CEZ_HOME at all — the way
    // `npm test` runs on a developer's machine. Run against the code as it was
    // before this change, that command wrote `<home>/.cezar/config.json` holding
    // the fixture's projects on 5 runs out of 5; the `remove` cases are the
    // cheapest set that does it (~1s, against ~40s for the whole file).
    //
    // The nested run picks up this package's own vitest config, so it exercises
    // all three defences together (one path per merge-write, the sandbox pin,
    // the write guard) — which is the claim that matters here: `npm test` does
    // not touch the user's registry. The per-layer cases above are what fail if
    // any single defence is removed.
    const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
    const vitestPkg = createRequire(import.meta.url).resolve('vitest/package.json');
    const vitestCli = join(dirname(vitestPkg), 'vitest.mjs');
    const summary = join(pinned, 'github-step-summary.md');
    writeFileSync(summary, 'outer suite report\n');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GITHUB_ACTIONS: 'true',
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_REPOSITORY: 'wjarka/cezar',
      GITHUB_SHA: 'testsha',
      GITHUB_WORKSPACE: packageRoot,
      HOME: fakeUserHome,
    };
    delete env.CEZ_HOME;
    delete env.GITHUB_STEP_SUMMARY;
    delete env.VITEST;

    const run = spawnSync(
      process.execPath,
      [vitestCli, 'run', 'src/workspace/projects-cli.test.ts', '--testTimeout=15', '-t', 'remove'],
      { cwd: packageRoot, env, encoding: 'utf8' },
    );

    // The nested suite is EXPECTED to fail — 15ms cannot finish a `git init`.
    // What matters is what it left behind outside its sandbox.
    expect(run.error).toBeUndefined();
    expect(readFileSync(summary, 'utf8')).toBe('outer suite report\n');
    expect(existsSync(join(fakeUserHome, '.cezar'))).toBe(false);
  }, 180_000);

  it('allows writes outside the OS account cezar home', () => {
    process.env.HOME = fakeUserHome;
    const sandboxed = join(pinned, 'config.json');

    expect(() => assertSquawkHomeWriteIsSandboxed(sandboxed)).not.toThrow();
    expect(() =>
      assertSquawkHomeWriteIsSandboxed(join(homedir(), '.cezar', 'config.json'), { VITEST: undefined }), // test-home-read: probe the write refusal guard without writing
    ).not.toThrow();
  });
});
