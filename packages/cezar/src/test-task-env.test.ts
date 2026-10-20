import { execFileSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { basename, sep } from 'node:path';
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
