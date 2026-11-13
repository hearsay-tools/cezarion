import { REBRAND_SWITCH } from '../home/switch.ts';
import { Home } from '../home/home.ts';
import { useTestHome } from '../home/test-home.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
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
import { agentEnv, agentEnvForStep } from './run/launch-context.ts';
import { AgentAccountUnavailableError } from '../workspace/agent-profiles.ts';

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

  const resolveStepEnv = (runId: string, backend: Parameters<typeof agentEnvForStep>[3], options?: Parameters<typeof agentEnvForStep>[4]) => {
    const context = { home: testHome(), store, repoRoot, dataDir: join(repoRoot, '.ai/cezar') };
    return agentEnvForStep(context, { agentEnv: id => agentEnv(context, undefined, id), workerStep: () => undefined }, runId, backend, options);
  };

  beforeEach(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-profile-wiring-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-profile-wiring-repo-'));
    useTestHome(home ? Home.sandbox(home) : undefined);
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    createFixtureManager(store, repoRoot);
    await registerProject(repoRoot, undefined, testHome());
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) useTestHome(undefined);
    else useTestHome(savedHome ? Home.sandbox(savedHome) : undefined);
  });

  const addAccount = async (id: string, provider: 'claude' | 'codex' | 'pi' | 'omp', dir: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), '{}', 'utf8');
    await mergeWriteAgentAccounts((store) => {
      store.accounts.push({ id, provider, configDir: dir, label: id, addedAt: '' });
    }, testHome());
  };

  const selectAccount = async (provider: 'claude' | 'codex' | 'pi' | 'omp', id: string) => {
    await mergeWriteAgentAccounts((store) => {
      const root = realpathSync(repoRoot);
      store.selections[root] = { ...store.selections[root], [provider]: id };
    }, testHome());
  };

  const newRun = (over: Parameters<RunManager['startRun']>[1] = { task: 't' }) =>
    store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: over.task,
      runner: over.runner,
      agentProfile: over.agentProfile,
      steps: [{ id: 'work', name: 'work', kind: STEP_KIND.agent }],
    });

  it('adds NOTHING for the default account — the zero-config env is untouched', async () => {
    const run = newRun();
    const { env, profileId } = await resolveStepEnv(run.id, 'claude');
    expect(profileId).toBe('default');
    // The base run env only: the handoff contract (spec 007) plus the task-scoped
    // temp directory (#785). No ACCOUNT variable, which is this test's subject.
    expect(Object.keys(env).sort()).toEqual([
      'CEZ_ARTIFACTS_DIR',
      'CEZ_HANDOFF_FILE',
      'CEZ_TASK_ID',
      'CEZ_TODOS_FILE',
      ...(REBRAND_SWITCH ? ['HSQ_ARTIFACTS_DIR', 'HSQ_HANDOFF_FILE', 'HSQ_TASK_ID', 'HSQ_TODOS_FILE'] : []),
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
    const { env, profileId } = await resolveStepEnv(run.id, 'claude');
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

    const claudeStep = await resolveStepEnv(run.id, 'claude');
    const codexStep = await resolveStepEnv(run.id, 'codex');

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
    expect((await resolveStepEnv(run.id, 'claude')).profileId).toBe('client');
    // …a step on a different backend does not: "use my other Claude login" says nothing about
    // which Codex account a mixed workflow should bill.
    expect((await resolveStepEnv(run.id, 'codex')).profileId).toBe('cx');
  });

  it('a RECORDED step profile wins over everything — resume must not follow a changed default', async () => {
    await addAccount('work', 'claude', join(home, 'claude-klaudiusz'));
    const run = newRun();
    // The project has since been switched to the personal account, but the session this
    // continuation resumes lives in the work account's own `sessions/` folder.
    const resolved = await resolveStepEnv(run.id, 'claude', { recordedProfileId: 'work' });
    expect(resolved.profileId).toBe('work');
    expect(resolved.env.CLAUDE_CONFIG_DIR).toBe(join(home, 'claude-klaudiusz'));
  });

  it('degrades a deleted account to the default rather than failing the run', async () => {
    await addAccount('work', 'claude', join(home, 'claude-klaudiusz'));
    await selectAccount('claude', 'work');
    await mergeWriteAgentAccounts((store) => {
      store.accounts = [];
    }, testHome());
    const run = newRun();
    const { env, profileId } = await resolveStepEnv(run.id, 'claude');
    expect(profileId).toBe('default');
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('degrades to the default when the accounts file is unreadable', async () => {
    Home.seedBytes(testHome(), agentAccountsPath(testHome()), Buffer.from('{ not json'));
    const run = newRun();
    expect((await resolveStepEnv(run.id, 'claude')).profileId).toBe('default');
  });

  /**
   * omp resolves a profile NAME under `$HOME/<PI_CONFIG_DIR or .omp>`, read from the env the child
   * inherits, which is this process's. The pi and omp rows own those variables.
   */
  const agentVars = ['HOME', 'PI_CONFIG_DIR', 'OMP_PROFILE', 'PI_PROFILE', 'PI_CODING_AGENT_DIR'] as const;
  const ownAgentHome = () => {
    const saved = Object.fromEntries(agentVars.map((key) => [key, process.env[key]]));
    beforeEach(() => {
      for (const key of agentVars) delete process.env[key];
      process.env.HOME = home;
    });
    afterEach(() => {
      for (const key of agentVars) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
  };

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
      ownAgentHome();

      it('adds NOTHING for the default account', async () => {
        const { env, profileId } = await resolveStepEnv(newRun().id, provider);
        expect(profileId).toBe('default');
        expect(env[variable]).toBeUndefined();
      });

      it('spawns the project\'s account under its own variable', async () => {
        await addAccount('work', provider, folder());
        await selectAccount(provider, 'work');
        const { env, profileId } = await resolveStepEnv(newRun().id, provider);
        expect(profileId).toBe('work');
        expect(env[variable]).toBe(spawnedWith());
      });

      it('keeps a Continue on the account the step recorded, whatever the project uses now', async () => {
        // A session only resumes inside the home that created it (pi: "No session found"; omp:
        // "not found" from another profile), so the recorded account must win.
        await addAccount('work', provider, folder());
        const resolved = await resolveStepEnv(newRun().id, provider, { recordedProfileId: 'work' });
        expect(resolved.profileId).toBe('work');
        expect(resolved.env[variable]).toBe(spawnedWith());
      });

      it('lets a host-exported value reach the default account, and a named account replace it', async () => {
        // `agent-env.ts` passes PI_* to pi and OMP_*/PI_* to omp, so a value the Squawk process
        // carries reaches every default session; a named account's `extraEnv` is applied after it.
        await addAccount('work', provider, folder());
        const source = { PATH: '/usr/bin', [variable]: hostValue } as NodeJS.ProcessEnv;
        const run = newRun();
        const asDefault = await resolveStepEnv(run.id, provider);
        expect(buildChildEnv({ backend: provider, source, extraEnv: asDefault.env })[variable]).toBe(hostValue);
        const asNamed = await resolveStepEnv(run.id, provider, { recordedProfileId: 'work' });
        expect(buildChildEnv({ backend: provider, source, extraEnv: asNamed.env })[variable]).toBe(spawnedWith());
      });
    });
  }

  describe('an omp account after omp\'s root moved', () => {
    ownAgentHome();

    it('fails the step before spawning rather than letting OMP_PROFILE open another profile', async () => {
      // Added under `~/.omp`. With PI_CONFIG_DIR set now, `OMP_PROFILE=work` would open
      // `~/.omp-alt/profiles/work`: another login, or a fresh empty one, under the name Settings shows.
      await addAccount('work', 'omp', join(home, '.omp', 'profiles', 'work'));
      await selectAccount('omp', 'work');
      process.env.PI_CONFIG_DIR = '.omp-alt';
      const run = newRun();
      await expect(resolveStepEnv(run.id, 'omp')).rejects.toBeInstanceOf(AgentAccountUnavailableError);
      // Continue resolves the step's recorded account and is refused the same way.
      await expect(resolveStepEnv(run.id, 'omp', { recordedProfileId: 'work' }))
        .rejects.toThrow(join(home, '.omp-alt', 'profiles'));
    });
  });
});
