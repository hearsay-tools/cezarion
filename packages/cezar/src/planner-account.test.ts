import { Home } from './home/home.ts';
import { useTestHome } from './home/test-home.testkit.ts';
import { testHome } from './home/test-home.testkit.ts';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeWriteAgentAccounts } from './workspace/agent-accounts.ts';
import type { AgentRunner } from './core/agent-runner.ts';
import { planChain } from './planner.ts';

const run = vi.fn(async () => ({ text: '' }));
function runners(): AgentRunner {
  return { run } as unknown as AgentRunner;
}

/**
 * The planner bills the project's agent account like any task (spec 2026-07-29-agent-profiles), so
 * an account Squawk refuses to spawn must not fail the plan route or fall back to the default login.
 */
describe('planChain under an account Squawk refuses to spawn (#1283)', () => {
  let home: string;
  let repoRoot: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'cez-planner-account-home-')));
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cez-planner-account-repo-')));
    useTestHome(home ? Home.sandbox(home) : undefined);
    for (const key of ['OMP_PROFILE', 'PI_PROFILE', 'PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR']) vi.stubEnv(key, undefined);
    // omp resolves a profile name under `$HOME/<PI_CONFIG_DIR or .omp>`.
    vi.stubEnv('HOME', join(home, 'user'));
    mkdirSync(join(repoRoot, '.ai', 'cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'cezar', 'config.json'), JSON.stringify({ defaultRunner: 'omp' }), 'utf8');
    run.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
  });

  it('takes the one-step fallback without a model call when omp\'s root moved away from the profile', async () => {
    const profile = join(home, 'user', '.omp', 'profiles', 'work');
    mkdirSync(profile, { recursive: true });
    await mergeWriteAgentAccounts((store) => {
      store.accounts.push({ id: 'work', provider: 'omp', configDir: profile, label: 'work', addedAt: '' });
      store.selections[repoRoot] = { omp: 'work' };
    }, testHome());
    // `OMP_PROFILE=work` would now open `~/.omp-alt/profiles/work`.
    vi.stubEnv('PI_CONFIG_DIR', '.omp-alt');

    const plan = await planChain(repoRoot, 'do it', undefined, testHome(), runners);

    expect(plan.fallback).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it('still plans under the account while omp would open its profile', async () => {
    const profile = join(home, 'user', '.omp', 'profiles', 'work');
    mkdirSync(profile, { recursive: true });
    await mergeWriteAgentAccounts((store) => {
      store.accounts.push({ id: 'work', provider: 'omp', configDir: profile, label: 'work', addedAt: '' });
      store.selections[repoRoot] = { omp: 'work' };
    }, testHome());

    await planChain(repoRoot, 'do it', undefined, testHome(), runners);

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ env: { OMP_PROFILE: 'work' } }));
  });
});
