import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
