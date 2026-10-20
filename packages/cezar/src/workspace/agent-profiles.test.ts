import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentAccountsPath } from '../paths.ts';
import {
  AgentAccountUnavailableError,
  defaultAgentProfile,
  listAgentProfiles,
  namedAccountUnavailable,
  ompProfileDirError,
  profileDirState,
  profilesForProvider,
  resolveProfileEnvForRoot,
  sameProfileDir,
  selectProfile,
} from './agent-profiles.ts';
import { DEFAULT_AGENT_ACCOUNT_ID, loadAgentAccounts } from './agent-accounts.ts';

/**
 * Resolution rules from spec 2026-07-29-agent-profiles. The pair worth reading closely is the two
 * degradation cases: an UNKNOWN id falls back to the default, a KNOWN id with a MISSING directory
 * does not. They differ on purpose — see the assertions.
 */
describe('agent profile resolution', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-profiles-'));
    process.env.CEZ_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  const env = { HOME: '/home/u' } as NodeJS.ProcessEnv;
  const write = (value: unknown) => writeFileSync(agentAccountsPath(), JSON.stringify(value), 'utf8');
  const klaudiuszProfile = {
    id: 'klaudiusz',
    provider: 'claude' as const,
    configDir: '~/.claude-klaudiusz',
    label: 'Klaudiusz',
    addedAt: '',
  };

  describe('defaultAgentProfile', () => {
    it('is whatever agentHomePaths discovers, per provider', () => {
      expect(defaultAgentProfile('claude', env).path).toBe('/home/u/.claude');
      expect(defaultAgentProfile('codex', env).path).toBe('/home/u/.codex');
      expect(defaultAgentProfile('opencode', env).path).toBe('/home/u/.config/opencode');
    });

    it('follows the vendor env vars, so setting one moves the DEFAULT profile', () => {
      const relocated = { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/opt/claude' } as NodeJS.ProcessEnv;
      expect(defaultAgentProfile('claude', relocated).path).toBe('/opt/claude');
    });

    it('follows a host-exported OMP_PROFILE, so the profile the host selects is the default', () => {
      // The default is spawned with nothing added and inherits the host's OMP_PROFILE through
      // `agent-env.ts`'s `OMP_` prefix; discovery has to name the folder that session really uses.
      expect(defaultAgentProfile('omp', env).path).toBe('/home/u/.omp/agent');
      expect(defaultAgentProfile('omp', { ...env, OMP_PROFILE: 'work' }).path).toBe('/home/u/.omp/profiles/work/agent');
      expect(defaultAgentProfile('pi', { ...env, PI_CODING_AGENT_DIR: '/opt/pi' }).path).toBe('/opt/pi');
    });

    it('is marked default so the UI can refuse to edit or delete it', () => {
      expect(defaultAgentProfile('claude', env)).toMatchObject({ id: 'default', isDefault: true });
    });
  });

  describe('listing', () => {
    it('puts the discovered profile first, then the stored extras in file order', async () => {
      write({ accounts: [klaudiuszProfile, { ...klaudiuszProfile, id: 'client', configDir: '~/.claude-client' }] });
      const store = await loadAgentAccounts();
      expect(profilesForProvider(store, 'claude', env).map((p) => p.id)).toEqual([
        'default',
        'klaudiusz',
        'client',
      ]);
    });

    it('never mixes providers', async () => {
      write({ accounts: [klaudiuszProfile, { ...klaudiuszProfile, id: 'cx', provider: 'codex' }] });
      const store = await loadAgentAccounts();
      expect(profilesForProvider(store, 'codex', env).map((p) => p.id)).toEqual(['default', 'cx']);
      expect(listAgentProfiles(store, ['claude', 'codex'], env)).toHaveLength(4);
    });

    it('expands a stored `~` while keeping what the user typed', async () => {
      write({ accounts: [klaudiuszProfile] });
      const [, stored] = profilesForProvider(await loadAgentAccounts(), 'claude', env);
      expect(stored?.configDir).toBe('~/.claude-klaudiusz');
      expect(stored?.path.endsWith('/.claude-klaudiusz')).toBe(true);
      expect(stored?.path.startsWith('~')).toBe(false);
    });
  });

  describe('selectProfile', () => {
    it('uses the project\'s stored selection', async () => {
      write({
        accounts: [klaudiuszProfile],
        selections: { '/tmp/projects/a': { claude: 'klaudiusz' } },
      });
      const store = await loadAgentAccounts();
      expect(selectProfile(store, { provider: 'claude', repoRoot: '/tmp/projects/a', env }).id).toBe('klaudiusz');
    });

    it('lets an explicit profileId (a run\'s recorded account) win over the project', async () => {
      write({
        accounts: [klaudiuszProfile],
        selections: { '/tmp/projects/a': { claude: 'klaudiusz' } },
      });
      const store = await loadAgentAccounts();
      expect(
        selectProfile(store, { provider: 'claude', repoRoot: '/tmp/projects/a', profileId: 'default', env }).id,
      ).toBe('default');
    });

    it('degrades an UNKNOWN id to the default — a dangling reference names no account', async () => {
      write({ selections: { '/tmp/projects/a': { claude: 'deleted-yesterday' } } });
      const store = await loadAgentAccounts();
      expect(selectProfile(store, { provider: 'claude', repoRoot: '/tmp/projects/a', env }).isDefault).toBe(true);
    });

    it('will not hand one provider another provider\'s profile', async () => {
      write({
        accounts: [klaudiuszProfile],
        selections: { '/tmp/projects/a': { codex: 'klaudiusz' } },
      });
      const store = await loadAgentAccounts();
      expect(selectProfile(store, { provider: 'codex', repoRoot: '/tmp/projects/a', env }).isDefault).toBe(true);
    });

    it('defaults for an unregistered root — headless runs and task worktrees', async () => {
      write({ accounts: [klaudiuszProfile] });
      const store = await loadAgentAccounts();
      expect(selectProfile(store, { provider: 'claude', repoRoot: '/somewhere/else', env }).isDefault).toBe(true);
      expect(selectProfile(store, { provider: 'claude', env }).isDefault).toBe(true);
    });
  });

  describe('resolveProfileEnvForRoot', () => {
    it('adds NOTHING for the default profile', async () => {
      write({});
      const resolved = await resolveProfileEnvForRoot('/tmp/projects/a', 'claude');
      expect(resolved.env).toEqual({});
      expect(resolved.profile.isDefault).toBe(true);
    });

    it('points the CLI at the selected account', async () => {
      write({
        accounts: [{ ...klaudiuszProfile, configDir: '/opt/claude-klaudiusz' }],
        selections: { '/tmp/projects/a': { claude: 'klaudiusz' } },
      });
      const resolved = await resolveProfileEnvForRoot('/tmp/projects/a', 'claude');
      expect(resolved.env).toEqual({ CLAUDE_CONFIG_DIR: '/opt/claude-klaudiusz' });
    });

    it('uses CODEX_HOME for a codex step in the same project', async () => {
      write({
        accounts: [
          { ...klaudiuszProfile, id: 'cx', provider: 'codex', configDir: '/opt/codex-klaudiusz' },
        ],
        selections: { '/tmp/projects/a': { codex: 'cx' } },
      });
      const resolved = await resolveProfileEnvForRoot('/tmp/projects/a', 'codex');
      expect(resolved.env).toEqual({ CODEX_HOME: '/opt/codex-klaudiusz' });
    });

    it('uses PI_CODING_AGENT_DIR for a pi account and OMP_PROFILE for an omp one', async () => {
      write({
        accounts: [
          { ...klaudiuszProfile, id: 'pi-work', provider: 'pi', configDir: '/opt/pi-work/agent' },
          { ...klaudiuszProfile, id: 'omp-work', provider: 'omp', configDir: '/home/u/.omp/profiles/work' },
        ],
        selections: { '/tmp/projects/a': { pi: 'pi-work', omp: 'omp-work' } },
      });
      expect((await resolveProfileEnvForRoot('/tmp/projects/a', 'pi')).env).toEqual({ PI_CODING_AGENT_DIR: '/opt/pi-work/agent' });
      expect((await resolveProfileEnvForRoot('/tmp/projects/a', 'omp', undefined, env)).env).toEqual({ OMP_PROFILE: 'work' });
      // The default account of either still adds nothing.
      expect((await resolveProfileEnvForRoot('/tmp/projects/b', 'pi')).env).toEqual({});
      expect((await resolveProfileEnvForRoot('/tmp/projects/b', 'omp')).env).toEqual({});
    });

    it('degrades to the default when the accounts file is unreadable', async () => {
      writeFileSync(agentAccountsPath(), '{ not json', 'utf8');
      const resolved = await resolveProfileEnvForRoot('/tmp/projects/a', 'claude');
      expect(resolved.env).toEqual({});
    });

    it('refuses an omp account whose root moved, rather than letting OMP_PROFILE open another profile', async () => {
      // Added while omp's root was `~/.omp`; PI_CONFIG_DIR now moves it, and `OMP_PROFILE=work`
      // would open `~/.omp-alt/profiles/work` while Settings still shows the stored folder.
      write({
        accounts: [{ ...klaudiuszProfile, id: 'omp-work', provider: 'omp', configDir: '/home/u/.omp/profiles/work' }],
        selections: { '/tmp/projects/a': { omp: 'omp-work' } },
      });
      const moved = { ...env, PI_CONFIG_DIR: '.omp-alt' } as NodeJS.ProcessEnv;
      const refused = resolveProfileEnvForRoot('/tmp/projects/a', 'omp', undefined, moved);
      await expect(refused).rejects.toBeInstanceOf(AgentAccountUnavailableError);
      await expect(refused).rejects.toThrow('/home/u/.omp-alt/profiles');
      // A recorded profile on Continue is refused the same way; the default is never substituted.
      await expect(resolveProfileEnvForRoot('/tmp/projects/b', 'omp', 'omp-work', moved)).rejects.toThrow(AgentAccountUnavailableError);
    });
  });

  describe('namedAccountUnavailable', () => {
    it('lets an omp account through while omp would open its folder', () => {
      expect(namedAccountUnavailable('omp', '/home/u/.omp/profiles/work', env)).toBeNull();
    });

    it('names the profiles dir omp would read after HOME or PI_CONFIG_DIR changed', () => {
      expect(namedAccountUnavailable('omp', '/home/u/.omp/profiles/work', { ...env, PI_CONFIG_DIR: '.omp-alt' }))
        .toContain('/home/u/.omp-alt/profiles');
      expect(namedAccountUnavailable('omp', '/home/u/.omp/profiles/work', { HOME: '/home/v' }))
        .toContain('/home/v/.omp/profiles');
    });

    it('never refuses a provider that is handed its folder itself', () => {
      for (const provider of ['claude', 'codex', 'pi'] as const) {
        expect(namedAccountUnavailable(provider, '/anywhere/at/all', { ...env, PI_CONFIG_DIR: '.omp-alt' }), provider).toBeNull();
      }
    });
  });

  describe('profileDirState', () => {
    it('reports a real config dir as existing and valid', async () => {
      const dir = join(home, 'claude-klaudiusz');
      mkdirSync(dir);
      writeFileSync(join(dir, 'settings.json'), '{}', 'utf8');
      expect(await profileDirState('claude', dir)).toEqual({ exists: true, looksValid: true });
    });

    it('accepts a dir that is not there YET — Connect creates it on first login', async () => {
      expect(await profileDirState('claude', join(home, 'not-created-yet'))).toEqual({
        exists: false,
        looksValid: false,
      });
    });

    it('reports an existing but unrecognised dir honestly, without refusing it', async () => {
      const dir = join(home, 'random');
      mkdirSync(dir);
      expect(await profileDirState('claude', dir)).toEqual({ exists: true, looksValid: false });
    });
  });

  describe('ompProfileDirError', () => {
    it('accepts a folder in omp\'s profiles dir whose name omp accepts', async () => {
      expect(await ompProfileDirError('/home/u/.omp/profiles/work', env)).toBeNull();
      expect(await ompProfileDirError('/home/u/.omp/profiles/work/', env)).toBeNull();
    });

    it('refuses a folder anywhere else, naming where an omp profile has to live', async () => {
      // OMP_PROFILE takes a NAME: omp would open `~/.omp/profiles/omp-work`, not this folder.
      expect(await ompProfileDirError('/data/profiles/omp-work', env)).toContain('/home/u/.omp/profiles/');
      expect(await ompProfileDirError('/home/u/.omp/agent', env)).toContain('/home/u/.omp/profiles/');
    });

    it('refuses a name omp would refuse, `default` included', async () => {
      for (const name of ['Work', 'default', 'work.', 'con']) {
        expect(await ompProfileDirError(`/home/u/.omp/profiles/${name}`, env), name).toContain('lowercase');
      }
    });

    it('follows a host PI_CONFIG_DIR, which moves omp\'s root', async () => {
      const alt = { ...env, PI_CONFIG_DIR: '.omp-alt' } as NodeJS.ProcessEnv;
      expect(await ompProfileDirError('/home/u/.omp-alt/profiles/work', alt)).toBeNull();
      expect(await ompProfileDirError('/home/u/.omp/profiles/work', alt)).toContain('/home/u/.omp-alt/profiles/');
    });

    it('accepts the real spelling of a profiles dir reached through a symlinked home', async () => {
      const real = realpathSync(home);
      mkdirSync(join(real, 'real-home', '.omp', 'profiles'), { recursive: true });
      symlinkSync(join(real, 'real-home'), join(real, 'linked-home'));
      const linked = { HOME: join(real, 'linked-home') } as NodeJS.ProcessEnv;
      expect(await ompProfileDirError(join(real, 'real-home', '.omp', 'profiles', 'work'), linked)).toBeNull();
    });
  });

  describe('sameProfileDir', () => {
    it('sees through a trailing slash and a symlink spelling of one directory', async () => {
      const dir = join(home, 'claude-klaudiusz');
      mkdirSync(dir);
      expect(await sameProfileDir(dir, `${dir}/`)).toBe(true);
      expect(await sameProfileDir(dir, join(home, 'other'))).toBe(false);
    });
  });

  /**
   * The machine-wide default account (spec 2026-07-29-agent-profiles): what a repo that has chosen
   * nothing uses, so a second login is set up once instead of per checkout.
   */
  describe('the machine-wide default account', () => {
    it('is used by a repo that has chosen nothing', async () => {
      write({ accounts: [klaudiuszProfile], defaults: { claude: 'klaudiusz' } });
      const store = await loadAgentAccounts();
      expect(selectProfile(store, { provider: 'claude', repoRoot: '/tmp/projects/a', env }).id)
        .toBe('klaudiusz');
    });

    it('NEVER overrules a repo that has chosen — that is what makes it a default', async () => {
      // The failure this forbids: changing the machine default silently re-points work someone
      // already configured, onto another subscription.
      write({
        accounts: [klaudiuszProfile, { ...klaudiuszProfile, id: 'client', configDir: '~/.claude-client' }],
        defaults: { claude: 'klaudiusz' },
        selections: { '/tmp/projects/a': { claude: 'client' } },
      });
      const store = await loadAgentAccounts();
      expect(selectProfile(store, { provider: 'claude', repoRoot: '/tmp/projects/a', env }).id)
        .toBe('client');
    });

    it('loses to a per-task override, which is the most specific answer there is', async () => {
      write({ accounts: [klaudiuszProfile], defaults: { claude: 'klaudiusz' } });
      const store = await loadAgentAccounts();
      expect(selectProfile(store, {
        provider: 'claude',
        repoRoot: '/tmp/projects/a',
        profileId: DEFAULT_AGENT_ACCOUNT_ID,
        env,
      }).isDefault).toBe(true);
    });

    it('is per provider — a claude default says nothing about codex', async () => {
      write({ accounts: [klaudiuszProfile], defaults: { claude: 'klaudiusz' } });
      const store = await loadAgentAccounts();
      expect(selectProfile(store, { provider: 'codex', repoRoot: '/tmp/projects/a', env }).isDefault)
        .toBe(true);
    });

    it('degrades to the discovered account when it names an account that is gone', async () => {
      write({ accounts: [], defaults: { claude: 'deleted-account' } });
      const store = await loadAgentAccounts();
      expect(selectProfile(store, { provider: 'claude', repoRoot: '/tmp/projects/a', env }).isDefault)
        .toBe(true);
    });
  });
});
