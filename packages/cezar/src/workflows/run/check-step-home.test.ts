import { resolveHome } from '../../home/resolve.ts'; // test-home-read: import for the annotated sandbox and refusal probes
import { useTestHome } from '../../home/test-home.testkit.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { StepLoop } from './step-loop.ts';
import { runGroupedCommand } from '../grouped-command.ts';

vi.mock('../grouped-command.ts', () => ({ runGroupedCommand: vi.fn(async () => ({ exitCode: 0, output: 'ok' })) }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it.each(['0', '1'])('check steps remove only cockpit home locators with full-env=%s', async (full) => {
  useTestHome(resolveHome({ purpose: 'cli', env: { CEZ_HOME: '/live/home' } })); // test-home-read: resolve an env fixture; command execution is mocked
  vi.stubEnv('cez_home', '/live/lower');
  vi.stubEnv('hsq_home', '/live/split-lower');
  vi.stubEnv('CEZ_AGENT_ENV_FULL', full);
  vi.stubEnv('CEZ_ENV_PASSTHROUGH', 'CEZ_HOME,HSQ_HOME');
  vi.stubEnv('CHECK_SECRET', 'preserved');
  const before = { ...process.env };
  const state = { liveSession: { cwd: '/worktree', installInterrupt: vi.fn() } };
  const result = await StepLoop.prototype.runCheckStep.call({} as StepLoop,
    state as unknown as Parameters<StepLoop['runCheckStep']>[0],
    { id: 'check', command: 'check' } as Parameters<StepLoop['runCheckStep']>[1], vi.fn());
  const options = vi.mocked(runGroupedCommand).mock.calls[0]![0];
  delete before.CEZ_HOME;
  delete before.cez_home;
  delete before.HSQ_HOME;
  delete before.hsq_home;
  expect(options.env).toEqual(before);
  expect(result).toEqual({ ok: true, output: 'ok' });
  expect(process.env.CEZ_HOME).toBe('/live/home');
  expect(process.env.HSQ_HOME).toBe('/live/home');
});
