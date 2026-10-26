import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agentHomePaths } from './paths.ts';

// hearsay-tools/cezarion#953: a suite run inside a cezar task inherited that task's session.
// The dry-run mocks appended to its real handoff file, and fixtures could reach its
// delegation API and tool socket. Both test entry points drop these before any test runs.
const TASK_KEYS = [
  'CEZ_ARTIFACTS_DIR', 'CEZ_HANDOFF_FILE', 'CEZ_TODOS_FILE', 'CEZ_TASK_ID', 'CEZ_PROJECT_ROOT',
  'CEZ_DELEGATION_URL', 'CEZ_DELEGATION_TOKEN', 'CEZ_TOOL_SOCKET', 'CEZ_TOOL_TOKEN',
];

describe('test runs never inherit a task session (hearsay-tools/cezarion#953)', () => {
  it('vitest.setup.ts clears the host task variables', () => {
    expect(Object.fromEntries(TASK_KEYS.map(key => [key, process.env[key]]))).toEqual(Object.fromEntries(TASK_KEYS.map(key => [key, undefined])));
  });

  it('the node:test preload clears them too', () => {
    const preload = fileURLToPath(new URL('../../../scripts/test-git-env.mjs', import.meta.url));
    const inherited = execFileSync(process.execPath, ['--import', preload, '-e',
      `process.stdout.write(JSON.stringify(${JSON.stringify(TASK_KEYS)}.filter(key => key in process.env)))`], {
      env: { ...process.env, ...Object.fromEntries(TASK_KEYS.map(key => [key, 'from-the-live-task'])) }, encoding: 'utf8',
    });
    expect(JSON.parse(inherited)).toEqual([]);
  });
});

// hearsay-tools/cezarion#1361: the suite resolved the developer's own agent folders. Two tests
// passed locally only because ~/.pi/agent and ~/.omp/agent existed, and failed on a fresh CI
// runner. vitest.setup.ts points HOME at a sandbox and clears every variable that moves an agent home.
const AGENT_HOME_KEYS = [
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'PI_CONFIG_DIR', 'OMP_PROFILE', 'PI_PROFILE',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CURSOR_CONFIG_DIR',
];

describe('test runs never read the host home (hearsay-tools/cezarion#1361)', () => {
  const agentHomeEnv = () => Object.fromEntries(AGENT_HOME_KEYS.map(key => [key, process.env[key]]));
  const unset = Object.fromEntries(AGENT_HOME_KEYS.map(key => [key, undefined]));

  it('vitest.setup.ts points HOME at a sandbox, not the account home', () => {
    const home = process.env.HOME!;
    expect(home).not.toBe(userInfo().homedir);
    expect(basename(home)).toMatch(/^cez-vitest-user-home-/);
    expect(process.env.USERPROFILE).toBe(home);
    expect(homedir()).toBe(home);
  });

  it('vitest.setup.ts clears the host variables that move an agent home', () => {
    expect(agentHomeEnv()).toEqual(unset);
  });

  it('links the sandbox home to one omp natives cache outside every sandbox (hearsay-tools/cezarion#1911)', () => {
    const natives = join(homedir(), '.omp', 'natives');
    expect(lstatSync(natives).isSymbolicLink()).toBe(true);
    const cache = readlinkSync(natives);
    expect(isAbsolute(cache)).toBe(true);
    expect(basename(cache)).toBe('test-omp-natives');
    expect(cache.startsWith(process.env.TMPDIR! + sep)).toBe(false);
  });

  it('every agent home resolves inside the sandbox', () => {
    const home = process.env.HOME!;
    for (const [agent, path] of Object.entries(agentHomePaths())) expect(path.startsWith(home + sep), `${agent}: ${path}`).toBe(true);
  });

  // The next two run in order: the first leaves values behind, the second sees them reset.
  let sandbox: string | undefined;
  it('a test may point HOME and the agent homes anywhere', () => {
    sandbox = process.env.HOME;
    process.env.HOME = process.env.USERPROFILE = '/left/by/a/test';
    for (const key of AGENT_HOME_KEYS) process.env[key] = '/left/by/a/test';
  });

  it('the next test starts from the sandbox again', () => {
    expect(sandbox).toBeDefined();
    expect([process.env.HOME, process.env.USERPROFILE]).toEqual([sandbox, sandbox]);
    expect(agentHomeEnv()).toEqual(unset);
  });
});

// Run the real setup in a new Vitest process: values set in this worker would
// already be too late to exercise inherited-environment cleanup.
it('scrubs inherited CEZ flags but preserves test-owned flags (hearsay-tools/cezarion#1517)', () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  mkdirSync(join(repo, '.ai/qa'), { recursive: true });
  const scratch = mkdtempSync(join(repo, '.ai/qa/unit-env-'));
  try {
    const fixture = join(scratch, 'environment.test.ts');
    writeFileSync(fixture, `
import { beforeAll, expect, it } from 'vitest';
import { basename } from 'node:path';
const inheritedKeys = ['CEZ_TEST_INHERITED_SENTINEL', 'CEZ_VOICE', 'CEZ_PROJECT_WARMUP'];
for (const key of inheritedKeys) expect(process.env[key], key).toBeUndefined();
expect(basename(process.env.CEZ_HOME!)).toMatch(/^cez-vitest-home-/);
expect(process.env.UNIT_ENV_SENTINEL).toBe('preserved');
beforeAll(() => { process.env.CEZ_DRY_RUN = 'from-beforeAll'; });
it('permits a test-owned flag', () => {
  expect(process.env.CEZ_DRY_RUN).toBe('from-beforeAll');
  process.env.CEZ_VOICE = '1';
  expect(process.env.CEZ_VOICE).toBe('1');
});
it('keeps the file flag and existing per-test cleanup', () => {
  expect(process.env.CEZ_DRY_RUN).toBe('from-beforeAll');
  expect(process.env.CEZ_VOICE).toBeUndefined();
});
`);
    const config = join(scratch, 'vitest.config.mjs');
    writeFileSync(config, `export default ${JSON.stringify({ test: {
      environment: 'node', include: [fixture],
      setupFiles: [join(repo, 'packages/cezar/vitest.setup.ts')],
      passWithNoTests: false, maxWorkers: 1,
    } })}`);
    // Pass only the minimal process environment and synthetic values, never
    // the parent's task controller or credentials.
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT']
      .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    const output = execFileSync(process.execPath, [join(repo, 'node_modules/vitest/vitest.mjs'),
      'run', '--config', config], {
      cwd: repo, encoding: 'utf8', timeout: 60_000,
      env: { ...env, CEZ_TEST_INHERITED_SENTINEL: 'inherited', CEZ_VOICE: '1',
        CEZ_PROJECT_WARMUP: '0', CEZ_HOME: scratch, UNIT_ENV_SENTINEL: 'preserved' },
    });
    expect(output).toContain('2 passed');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 90_000);

// hearsay-tools/cezarion#1395: a worker that dies before `afterAll` used to leave its whole
// sandbox in the OS temp root. The first run kills its own worker mid-file; the second run's
// setup must remove what the first left.
it('a run stopped mid-file leaves no sandbox once the next run starts (hearsay-tools/cezarion#1395)', () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  mkdirSync(join(repo, '.ai/qa'), { recursive: true });
  const scratch = mkdtempSync(join(repo, '.ai/qa/unit-env-'));
  try {
    const log = join(scratch, 'sandboxes.log');
    const fixture = join(scratch, 'sandbox.test.ts');
    writeFileSync(fixture, `
import { appendFileSync } from 'node:fs';
import { it } from 'vitest';
it('records its sandbox', () => {
  appendFileSync(process.env.SANDBOX_LOG!, process.env.TMPDIR + '\\n');
  if (process.env.KILL_WORKER === '1') process.kill(process.pid, 'SIGKILL');
});
`);
    const config = join(scratch, 'vitest.config.mjs');
    writeFileSync(config, `export default ${JSON.stringify({ test: {
      environment: 'node', include: [fixture],
      setupFiles: [join(repo, 'packages/cezar/vitest.setup.ts')],
      passWithNoTests: false, maxWorkers: 1,
    } })}`);
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT']
      .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    const run = (kill: '0' | '1') => spawnSync(process.execPath, [join(repo, 'node_modules/vitest/vitest.mjs'),
      'run', '--config', config], {
      // bound: a hang guard for one nested Vitest run, as in the test above.
      cwd: repo, encoding: 'utf8', timeout: 60_000,
      env: { ...env, CEZ_HOME: scratch, SANDBOX_LOG: log, KILL_WORKER: kill },
    });

    const stopped = run('1');
    expect(stopped.status, stopped.stdout + stopped.stderr).not.toBe(0);
    const [left] = readFileSync(log, 'utf8').trim().split('\n');
    expect(basename(left!)).toMatch(/^cez-vitest-tmp-/);
    expect(existsSync(left!), 'SIGKILL runs no cleanup').toBe(true);

    const next = run('0');
    expect(next.status, next.stdout + next.stderr).toBe(0);
    const [, own] = readFileSync(log, 'utf8').trim().split('\n');
    expect(existsSync(left!)).toBe(false);
    expect(existsSync(own!)).toBe(false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 150_000);
