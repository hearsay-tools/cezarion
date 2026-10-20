import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { agentAccountsPath } from '../paths.ts';
import { mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import { registerProject } from '../workspace/projects.ts';
import type { RunManager } from './run.ts';
import { buildChildEnv } from '../core/agent-env.ts';

/**
 * Which agent account a STEP spawns under (spec 2026-07-29-agent-profiles).
 *
 * Exercised at the `agentEnvForStep` seam rather than through a real run: the point under test is
 * the resolution order and the exact variable handed to the child, and a full dry-run would prove
 * neither (the mock CLI does not echo its environment).
 */
describe('RunManager agent-profile resolution', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  /** The private seam — same access pattern the auto-naming tests use. */
  type Seam = {
    agentEnvForStep(
      runId: string,
      backend: 'claude' | 'codex' | 'opencode' | 'pi' | 'omp',
      options?: { generateFollowups?: boolean; recordedProfileId?: string },
    ): Promise<{ env: Record<string, string>; profileId: string }>;
  };
  const seam = () => manager as unknown as Seam;

  beforeEach(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-profile-wiring-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-profile-wiring-repo-'));
    process.env.CEZ_HOME = home;
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
    await registerProject(repoRoot);
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  const addAccount = async (id: string, provider: 'claude' | 'codex' | 'pi' | 'omp', dir: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), '{}', 'utf8');
    await mergeWriteAgentAccounts((store) => {
      store.accounts.push({ id, provider, configDir: dir, label: id, addedAt: '' });
    });
  };

  const selectAccount = async (provider: 'claude' | 'codex' | 'pi' | 'omp', id: string) => {
    await mergeWriteAgentAccounts((store) => {
      const root = realpathSync(repoRoot);
      store.selections[root] = { ...store.selections[root], [provider]: id };
    });
  };

  const newRun = (over: Parameters<RunManager['startRun']>[1] = { task: 't' }) =>
    store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: over.task,
      runner: over.runner,
      agentProfile: over.agentProfile,
      steps: [{ id: 'work', name: 'work', kind: 'agent' }],
    });

  it('adds NOTHING for the default account — the zero-config env is untouched', async () => {
    const run = newRun();
    const { env, profileId } = await seam().agentEnvForStep(run.id, 'claude');
    expect(profileId).toBe('default');
    // The base run env only: the handoff contract (spec 007) plus the task-scoped
    // temp directory (#785). No ACCOUNT variable, which is this test's subject.
    expect(Object.keys(env).sort()).toEqual([
      'CEZ_ARTIFACTS_DIR',
      'CEZ_HANDOFF_FILE',
      'CEZ_TASK_ID',
      'CEZ_TODOS_FILE',
      'TEMP',
      'TMP',
      'TMPDIR',
    ]);
    expect(env.CEZ_ARTIFACTS_DIR).toBe(join(repoRoot, '.ai/cezar/runs', `${run.id}-artifacts`));
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
  });

  it('points the CLI at the project\'s account and reports the id to record', async () => {
    await addAccount('work', 'claude', join(home, 'claude-klaudiusz'));
    await selectAccount('claude', 'work');
    const run = newRun();
    const { env, profileId } = await seam().agentEnvForStep(run.id, 'claude');
    expect(profileId).toBe('work');
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(home, 'claude-klaudiusz'));
    // The handoff plumbing still rides along — the account is additive, not a replacement.
    expect(env.CEZ_TASK_ID).toBe(run.id);
  });

  it('resolves each step of a MIXED-backend workflow against its own provider', async () => {
    await addAccount('work', 'claude', join(home, 'claude-klaudiusz'));
    await addAccount('cx', 'codex', join(home, 'codex-klaudiusz'));
    await selectAccount('claude', 'work');
    await selectAccount('codex', 'cx');
    const run = newRun();

    const claudeStep = await seam().agentEnvForStep(run.id, 'claude');
    const codexStep = await seam().agentEnvForStep(run.id, 'codex');

    expect(claudeStep.env).toMatchObject({ CLAUDE_CONFIG_DIR: join(home, 'claude-klaudiusz') });
    expect(claudeStep.env.CODEX_HOME).toBeUndefined();
    expect(codexStep.env).toMatchObject({ CODEX_HOME: join(home, 'codex-klaudiusz') });
    expect(codexStep.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('lets the composer override the project — but only for the run\'s OWN runner', async () => {
    await addAccount('work', 'claude', join(home, 'claude-klaudiusz'));
    await addAccount('client', 'claude', join(home, 'claude-client'));
    await addAccount('cx', 'codex', join(home, 'codex-klaudiusz'));
    await selectAccount('claude', 'work');
    await selectAccount('codex', 'cx');
    const run = newRun({ task: 't', runner: 'claude', agentProfile: 'client' });

    // The run's runner takes the override…
    expect((await seam().agentEnvForStep(run.id, 'claude')).profileId).toBe('client');
    // …a step on a different backend does not: "use my other Claude login" says nothing about
    // which Codex account a mixed workflow should bill.
    expect((await seam().agentEnvForStep(run.id, 'codex')).profileId).toBe('cx');
  });

  it('a RECORDED step profile wins over everything — resume must not follow a changed default', async () => {
    await addAccount('work', 'claude', join(home, 'claude-klaudiusz'));
    const run = newRun();
    // The project has since been switched to the personal account, but the session this
    // continuation resumes lives in the work account's own `sessions/` folder.
    const resolved = await seam().agentEnvForStep(run.id, 'claude', { recordedProfileId: 'work' });
    expect(resolved.profileId).toBe('work');
    expect(resolved.env.CLAUDE_CONFIG_DIR).toBe(join(home, 'claude-klaudiusz'));
  });

  it('degrades a deleted account to the default rather than failing the run', async () => {
    await addAccount('work', 'claude', join(home, 'claude-klaudiusz'));
    await selectAccount('claude', 'work');
    await mergeWriteAgentAccounts((store) => {
      store.accounts = [];
    });
    const run = newRun();
    const { env, profileId } = await seam().agentEnvForStep(run.id, 'claude');
    expect(profileId).toBe('default');
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('degrades to the default when the accounts file is unreadable', async () => {
    writeFileSync(agentAccountsPath(), '{ not json', 'utf8');
    const run = newRun();
    expect((await seam().agentEnvForStep(run.id, 'claude')).profileId).toBe('default');
  });

  /** pi and omp accounts (hearsay-tools/cezarion#1283): one row per runner, same four rules. */
  const runners = [
    { provider: 'pi' as const, variable: 'PI_CODING_AGENT_DIR', folder: () => join(home, 'pi-work', 'agent'),
      spawnedWith: () => join(home, 'pi-work', 'agent'), hostValue: '/host/pi-agent' },
    // An omp account is an omp profile: the folder sits in `profiles/` and omp gets its NAME.
    { provider: 'omp' as const, variable: 'OMP_PROFILE', folder: () => join(home, '.omp', 'profiles', 'work'),
      spawnedWith: () => 'work', hostValue: 'host-profile' },
  ];
  for (const { provider, variable, folder, spawnedWith, hostValue } of runners) {
    describe(`${provider} accounts`, () => {
      it('adds NOTHING for the default account', async () => {
        const { env, profileId } = await seam().agentEnvForStep(newRun().id, provider);
        expect(profileId).toBe('default');
        expect(env[variable]).toBeUndefined();
      });

      it('spawns the project\'s account under its own variable', async () => {
        await addAccount('work', provider, folder());
        await selectAccount(provider, 'work');
        const { env, profileId } = await seam().agentEnvForStep(newRun().id, provider);
        expect(profileId).toBe('work');
        expect(env[variable]).toBe(spawnedWith());
      });

      it('keeps a Continue on the account the step recorded, whatever the project uses now', async () => {
        // A session only resumes inside the home that created it (pi: "No session found"; omp:
        // "not found" from another profile), so the recorded account must win.
        await addAccount('work', provider, folder());
        const resolved = await seam().agentEnvForStep(newRun().id, provider, { recordedProfileId: 'work' });
        expect(resolved.profileId).toBe('work');
        expect(resolved.env[variable]).toBe(spawnedWith());
      });

      it('lets a host-exported value reach the default account, and a named account replace it', async () => {
        // `agent-env.ts` passes PI_* to pi and OMP_*/PI_* to omp, so a value the cezar process
        // carries reaches every default session; a named account's `extraEnv` is applied after it.
        await addAccount('work', provider, folder());
        const source = { PATH: '/usr/bin', [variable]: hostValue } as NodeJS.ProcessEnv;
        const run = newRun();
        const asDefault = await seam().agentEnvForStep(run.id, provider);
        expect(buildChildEnv({ backend: provider, source, extraEnv: asDefault.env })[variable]).toBe(hostValue);
        const asNamed = await seam().agentEnvForStep(run.id, provider, { recordedProfileId: 'work' });
        expect(buildChildEnv({ backend: provider, source, extraEnv: asNamed.env })[variable]).toBe(spawnedWith());
      });
    });
  }
});
