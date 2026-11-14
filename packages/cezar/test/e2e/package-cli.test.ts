import { projectPaths } from '../../src/project-paths.ts';
import { productName } from '../../src/home/display.ts';
import { WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { CiProbeScenario } from '../fixtures/installed-ci-probe.ts';
import { emitProbe } from '../fixtures/emit-probe.ts';
import { Home } from '../../src/home/home.ts';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { readPersistedRuns } from '../../src/runs/run-store.testkit.ts';

const execFile = promisify(execFileCallback);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function installTarball(root: string) {
  const packDir = join(root, 'pack');
  await mkdir(packDir);
  const packed = await execFile(
    npm,
    ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir],
    { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
  );
  const records = JSON.parse(packed.stdout) as Array<{
    filename: string;
    files: Array<{ path: string }>;
  }>;
  const record = records[0];
  assert.ok(record, 'npm pack should describe the generated tarball');

  const consumerDir = join(root, 'consumer');
  await mkdir(consumerDir);
  await writeFile(join(consumerDir, 'package.json'), '{"private":true}\n', 'utf8');
  const tarball = join(packDir, record.filename);
  await execFile(
    npm,
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball],
    { cwd: consumerDir, maxBuffer: 10 * 1024 * 1024 },
  );

  const packageRoot = join(consumerDir, 'node_modules', '@wjarka', 'cezarion');
  return { record, consumerDir, packageRoot };
}

test('the release tarball installs and runs the dry-run CLI workflow', { timeout: 120_000 }, async () => {
  // Squawk may set TMPDIR inside the checkout; installed resolution must have no
  // repository node_modules anywhere in its parent chain.
  const root = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'cezar-package-e2e-'));
  assert.ok(!root.startsWith(resolve(repoRoot, '../..') + '/'));

  try {
    const { record, consumerDir, packageRoot } = await installTarball(root);
    const packagedPaths = new Set(record.files.map((file) => file.path));
    for (const requiredPath of ['dist/index.js', 'dist/runs/transcript-facts-worker.js', 'web/dist/index.html', 'scripts/mock-claude.mjs', 'scripts/mock-codex-app-server.mjs', 'scripts/mock-opencode-serve.mjs', 'dist/ci-wait/controller.js', 'dist/ci-wait/client.js', 'dist/ci-wait/mcp.js', 'dist/ci-wait/tools.js', 'scripts/pi-ci-wait.mjs', 'scripts/omp-ci-wait.mjs', 'scripts/opencode-task-scope.mjs', 'scripts/mock-omp-rpc.mjs', 'README.md']) {
      assert.ok(packagedPaths.has(requiredPath), `release tarball should contain ${requiredPath}`);
    }
    assert.equal(packagedPaths.has('src/index.ts'), false, 'release tarball should not contain TypeScript sources');
    assert.equal(packagedPaths.has('test/e2e/package-cli.test.ts'), false, 'release tarball should not contain tests');

    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      bin: { cezarion: string; cez: string };
    };
    assert.equal(manifest.bin.cezarion, 'dist/index.js');
    assert.equal(manifest.bin.cez, 'dist/index.js');
    const cliPath = join(packageRoot, manifest.bin.cezarion);

    // Installed adapters must resolve their SDK and inlined contract without
    // workspace symlinks, tsx, npx, GitHub credentials, or TypeScript sources.
    const smoke = join(consumerDir, 'ci-smoke.mjs');
    await emitProbe(new URL('../fixtures/installed-ci-probe.ts', import.meta.url), join(consumerDir, 'ci-probe.mjs'));
    await writeFile(smoke, `
import { probe } from './ci-probe.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CiToolController } from ${JSON.stringify(pathToFileURL(join(packageRoot, 'dist/ci-wait/controller.js')).href)};
import { createRunner } from ${JSON.stringify(pathToFileURL(join(packageRoot, 'dist/core/runner-factory.js')).href)};
import piExtension from ${JSON.stringify(pathToFileURL(join(packageRoot, 'scripts/pi-ci-wait.mjs')).href)};
import ompExtension from ${JSON.stringify(pathToFileURL(join(packageRoot, 'scripts/omp-ci-wait.mjs')).href)};
await probe({ Client, StdioClientTransport, CiToolController, createRunner, piExtension, ompExtension }, JSON.parse(process.argv[2]));
`);
    const scenario: CiProbeScenario = { kind: WAIT_KIND.pr, phase: WAIT_PHASE.open, source: WAIT_SOURCE.agent, via: WAIT_VIA.cezar_wait };
    const ciSmoke = await execFile(process.execPath, [smoke, JSON.stringify(scenario)], { cwd: consumerDir, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, timeout: 20_000 });
    assert.match(ciSmoke.stdout, /installed CI adapters passed/);


    const help = await execFile(process.execPath, [cliPath, '--help'], {
      cwd: consumerDir,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.ok(help.stdout.includes(`${productName('cezar')} — local cockpit`));
    assert.match(help.stdout, /cez run "<task>"/);
    assert.match(help.stdout, /projects remove\|rm <id>/);
    assert.match(help.stdout, /projects tag <id> \[<tag>…\]/);
    assert.match(help.stdout, /cez worker/);
    for (const args of [['worker', '--help'], ['worker', 'spawn', '--help']]) {
      const workerHelp = await execFile(process.execPath, [cliPath, ...args], {
        cwd: consumerDir,
        env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:CEZ|HSQ)_/.test(name))),
      });
      assert.match(workerHelp.stdout, /Usage:/);
      assert.match(workerHelp.stdout, /cez worker/);
      assert.match(workerHelp.stdout, /--baseline/);
      assert.equal(workerHelp.stderr, "[cez] 'cez' is deprecated; use 'hsq' instead.\n");
    }


    const fixtureRepo = join(root, 'fixture-repo');
    await mkdir(fixtureRepo);
    const expectedDataDir = projectPaths(fixtureRepo).write;
    await execFile('git', ['init', '--initial-branch=main'], { cwd: fixtureRepo });
    await writeFile(join(fixtureRepo, 'README.md'), '# E2E fixture\n', 'utf8');
    await execFile('git', ['add', 'README.md'], { cwd: fixtureRepo });
    await execFile(
      'git',
      ['-c', 'user.name=Cezar CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'test fixture'],
      { cwd: fixtureRepo },
    );

    // CEZ_HOME pins every workspace write (migrations, project registry,
    // server.json) to a temp dir — booting the real CLI must never touch the
    // developer's real ~/.cezar.
    const cezHome = join(root, 'cez-home');
    const run = await execFile(process.execPath, [cliPath, 'run', 'mock:cezar-done', '--repo', fixtureRepo], {
      cwd: consumerDir,
      env: { ...process.env, CEZ_DRY_RUN: '1', HSQ_DRY_RUN: '1', CEZ_HOME: cezHome, HSQ_HOME: cezHome },
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.match(run.stdout, /run (done|review)/);

    const runs = readPersistedRuns(expectedDataDir);
    assert.equal(runs.length, 1);
    assert.ok(['done', 'review'].includes(runs[0]?.status ?? ''), 'the dry-run workflow should finish successfully');
    // The run database and its sidecars stay out of the user's repository history.
    const dataIgnore = (await readFile(join(expectedDataDir, '.gitignore'), 'utf8')).split('\n');
    for (const entry of ['runs.db', 'runs.db-wal', 'runs.db-shm', 'runs.json.pre-sqlite.bak', 'runs.json.pre-sqlite.*']) {
      assert.ok(dataIgnore.includes(entry), `${expectedDataDir}/.gitignore should list ${entry}`);
    }

    // Boot wiring (spec 2026-07-20-multi-project-workspace, step 1.5): the
    // headless run migrated ~/.cezar and registered the boot repo.
    const workspace = JSON.parse(await readFile(Home.sandbox(cezHome).workspaceConfig, 'utf8')) as {
      schemaVersion: number;
      disabledProviders?: string[];
      projects: Array<{ name: string; root: string }>;
    };
    assert.ok(workspace.schemaVersion >= 1, 'boot runs the workspace migrations');
    assert.ok(
      workspace.projects.some((p) => p.name === 'fixture-repo'),
      'a headless run registers the boot repo in the workspace registry',
    );

    workspace.disabledProviders = ['claude'];
    Home.seed(Home.sandbox(cezHome), Home.sandbox(cezHome).workspaceConfig, workspace);
    await assert.rejects(
      execFile(process.execPath, [cliPath, 'run', 'mock:cezar-done must stay blocked', '--repo', fixtureRepo], {
        cwd: consumerDir,
        env: { ...process.env, CEZ_DRY_RUN: '1', HSQ_DRY_RUN: '1', CEZ_HOME: cezHome, HSQ_HOME: cezHome },
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
      }),
      (error: unknown) => {
        const result = error as { stderr?: string };
        assert.match(result.stderr ?? '', /Claude Code is disabled/);
        return true;
      },
      'headless run must honor the global provider preference',
    );
    const runsAfterDisabledAttempt = readPersistedRuns(expectedDataDir);
    assert.equal(runsAfterDisabledAttempt.length, 1, 'a disabled provider must not create a run');
    workspace.disabledProviders = [];
    Home.seed(Home.sandbox(cezHome), Home.sandbox(cezHome).workspaceConfig, workspace);

    const claudeShim = join(root, 'claude-shim.mjs');
    await writeFile(
      claudeShim,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.join(' ') === 'auth status --json') {
  process.stdout.write('{"loggedIn":true}\\n');
} else {
  process.stdout.write('{"type":"system","subtype":"init","session_id":"auth-failure-session"}\\n');
  process.stdout.write('{"type":"result","subtype":"success","is_error":true,"result":"Failed to authenticate. API Error: 401 OAuth access token has been revoked.","usage":{"input_tokens":0,"output_tokens":0},"total_cost_usd":0}\\n');
}
`,
      { mode: 0o755 },
    );
    await execFile(
      process.execPath,
      [cliPath, 'run', 'exercise runtime auth rejection', '--repo', fixtureRepo],
      {
        cwd: consumerDir,
        env: {
          ...process.env,
          CEZ_CLAUDE_BIN: claudeShim, HSQ_CLAUDE_BIN: claudeShim,
          CEZ_HOME: cezHome, HSQ_HOME: cezHome,
        },
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    ).catch(() => undefined);
    const runsAfterAuthFailure = readPersistedRuns(expectedDataDir);
    assert.equal(runsAfterAuthFailure.length, 2, 'the runtime-auth fixture creates exactly one run');
    const authFailureRun = runsAfterAuthFailure.at(0);
    assert.ok(authFailureRun, 'the auth-failure fixture creates a run');
    const authFailureEvents = (await readFile(
      join(expectedDataDir, 'runs', `${authFailureRun.id}.ndjson`),
      'utf8',
    )).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(
      authFailureEvents.some((event) =>
        event.type === 'provider-auth-required'
        && event.provider === 'claude'
        && typeof event.authFailureId === 'string'),
      'headless runtime rejection must persist provider recovery guidance',
    );

    // `cez projects` (step 5.2) reads the same registry with no server
    // running — the ssh-into-the-box view of Settings → Projects.
    const projects = await execFile(process.execPath, [cliPath, 'projects'], {
      cwd: consumerDir,
      env: { ...process.env, CEZ_HOME: cezHome, HSQ_HOME: cezHome },
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.match(projects.stdout, /fixture-repo/);
    assert.match(projects.stdout, /1 project\(s\)/);

    // server-install / server-uninstall dry-run round-trip. A separate CEZ_HOME
    // isolates ~/.cezar/server.json from the project-registry fixture above;
    // CEZ_DRY_RUN performs no real sudo.
    assert.match(help.stdout, /cez server-install/);
    const serverHome = join(root, 'server-home');
    const serverEnv = { ...process.env, CEZ_DRY_RUN: '1', HSQ_DRY_RUN: '1', CEZ_HOME: serverHome, HSQ_HOME: serverHome };
    const serverExec = { cwd: consumerDir, env: serverEnv, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 } as const;

    await execFile(
      process.execPath,
      [cliPath, 'server-install', '--platform', 'ubuntu-vps', '--yes', '--repo', fixtureRepo],
      serverExec,
    );
    const state = JSON.parse(await readFile(Home.sandbox(serverHome).serverState(), 'utf8')) as {
      platform: string;
      installed: boolean;
      steps: Record<string, unknown>;
    };
    assert.equal(state.platform, 'ubuntu-vps', 'server-install records the platform');
    assert.equal(state.installed, true, 'server-install flips installed=true when all required steps are done');
    assert.ok(state.steps['nginx-proxy'], 'server-install ran the nginx-proxy step');

    await execFile(
      process.execPath,
      [cliPath, 'server-uninstall', '--platform', 'ubuntu-vps', '--yes'],
      serverExec,
    );
    const reversed = JSON.parse(await readFile(Home.sandbox(serverHome).serverState(), 'utf8')) as {
      installed: boolean;
      steps: Record<string, unknown>;
    };
    assert.deepEqual(reversed.steps, {}, 'server-uninstall reverses every step');
    assert.equal(reversed.installed, false, 'server-uninstall clears installed');

    await execFile(
      process.execPath,
      [cliPath, 'server-install', '--platform', 'ubuntu-vps', '--external-proxy', '--yes', '--repo', fixtureRepo],
      serverExec,
    );
    await execFile(
      process.execPath,
      [cliPath, 'server-install', '--platform', 'ubuntu-vps', '--yes', '--repo', fixtureRepo],
      serverExec,
    );
    const resumedExternal = JSON.parse(await readFile(Home.sandbox(serverHome).serverState(), 'utf8')) as {
      externalProxy?: boolean;
      steps: Record<string, unknown>;
    };
    assert.equal(resumedExternal.externalProxy, true, 'a flag-less resume preserves external-proxy mode');
    assert.ok(!resumedExternal.steps['nginx-proxy'], 'a flag-less resume does not add cezar-managed nginx');

    // Unknown platform exits non-zero.
    await assert.rejects(
      execFile(process.execPath, [cliPath, 'server-install', '--platform', 'nope'], serverExec),
      'unknown platform should exit 1',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('the installed tarball warms cold histories through its emitted worker', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'cezar-facts-package-'));
  assert.ok(!root.startsWith(resolve(repoRoot, '../..') + '/'));
  try {
    const { record, consumerDir, packageRoot } = await installTarball(root);
    assert.ok(record.files.some(file => file.path === 'dist/runs/transcript-facts-worker.js'));
    // Same installed-package boundary as the CLI: outside the repository, no loader,
    // no workspace resolutions, and an observed real .js worker (not sync fallback).
    const factsSmoke = join(consumerDir, 'facts-smoke.mjs');
    await writeFile(factsSmoke, `
import assert from 'node:assert/strict';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import threads from 'node:worker_threads';
assert.deepEqual(process.execArgv, []);
assert.equal(process.env.NODE_OPTIONS, '');
const packageRoot = realpathSync(${JSON.stringify(packageRoot)});
const installedModules = realpathSync(${JSON.stringify(join(consumerDir, 'node_modules'))}) + sep;
assert.ok(packageRoot.startsWith(installedModules));
const resolutions = [];
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  if (result.url.startsWith('file:')) {
    const path = realpathSync(fileURLToPath(result.url));
    assert.ok(path.startsWith(installedModules), 'outside installed node_modules: ' + path);
    assert.ok(!path.includes(sep + 'tsx' + sep), 'tsx must not participate');
    resolutions.push(path);
  }
  return result;
} });
let workers = 0;
const NativeWorker = threads.Worker;
threads.Worker = class extends NativeWorker {
  constructor(entry, options) {
    assert.equal(fileURLToPath(entry), join(packageRoot, 'dist/runs/transcript-facts-worker.js'));
    assert.deepEqual(options.execArgv, []);
    workers++;
    super(entry, options);
  }
};
syncBuiltinESMExports();
const runtime = { url: pathToFileURL(packageRoot + '/dist/'), ext: 'js' };
const { seedColdHistories, verifyFacts } = await import(pathToFileURL(packageRoot + '/scripts/transcript-facts-fixture.mjs'));
const { RunStore } = await import(new URL('runs/store.js', runtime.url));
const dataDir = ${JSON.stringify(join(root, 'installed-facts'))};
const fixtures = await seedColdHistories(dataDir, runtime);
const store = RunStore.open(dataDir);
try {
  await store.factsWarmIdle();
  const stats = verifyFacts(dataDir, fixtures, store);
  assert.equal(workers, 1);
  assert.ok(resolutions.some(path => path.includes(sep + 'dist' + sep + 'contract' + sep)));
  console.log(JSON.stringify({ kind: 'installed-transcript-facts', ...stats, workers,
    execArgv: process.execArgv, packageRoot, resolvedModules: resolutions.length }));
} finally { store.close(); }
`);
    const factsResult = await execFile(process.execPath, [factsSmoke], {
      cwd: consumerDir, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', CEZ_HOME: join(root, 'facts-home'), HSQ_HOME: join(root, 'facts-home') },
      timeout: 30_000,
    });
    assert.match(factsResult.stdout, /"workers":1/);
    console.log(factsResult.stdout.trim());
  } finally { await rm(root, { recursive: true, force: true }); }
});
