import { describe, expect, it } from 'vitest';
import { PROVIDER_IDS } from './provider-auth.ts';
import {
  PROFILE_CAPABLE_PROVIDERS,
  PROFILE_ENV_VAR,
  looksLikeProfileDir,
  ompProfileName,
  profileAgentDir,
  profileEnv,
  supportsProfiles,
} from './agent-profiles.ts';

describe('PROFILE_ENV_VAR', () => {
  it('names one variable per provider that can carry an account', () => {
    expect(PROFILE_ENV_VAR.claude).toBe('CLAUDE_CONFIG_DIR');
    expect(PROFILE_ENV_VAR.codex).toBe('CODEX_HOME');
    expect(PROFILE_ENV_VAR.pi).toBe('PI_CODING_AGENT_DIR');
    expect(PROFILE_ENV_VAR.omp).toBe('OMP_PROFILE');
  });

  it('leaves OpenCode and Cursor unsupported — no single variable moves their credentials', () => {
    expect(PROFILE_ENV_VAR.opencode).toBeNull();
    expect(supportsProfiles('opencode')).toBe(false);
    expect(supportsProfiles('cursor')).toBe(false);
    expect(PROFILE_CAPABLE_PROVIDERS).toEqual(['claude', 'codex', 'pi', 'omp']);
  });

  it('covers every provider, so adding one forces a decision here', () => {
    expect(Object.keys(PROFILE_ENV_VAR).sort()).toEqual([...PROVIDER_IDS].sort());
  });
});

describe('profileEnv', () => {
  it('points the agent at its profile dir', () => {
    expect(profileEnv('claude', '/home/u/.claude-klaudiusz')).toEqual({
      CLAUDE_CONFIG_DIR: '/home/u/.claude-klaudiusz',
    });
    expect(profileEnv('codex', '/home/u/.codex-klaudiusz')).toEqual({ CODEX_HOME: '/home/u/.codex-klaudiusz' });
    expect(profileEnv('pi', '/home/u/.pi-work/agent')).toEqual({ PI_CODING_AGENT_DIR: '/home/u/.pi-work/agent' });
  });

  it('names the omp PROFILE, not a path — OMP_PROFILE takes a name', () => {
    expect(profileEnv('omp', '/home/u/.omp/profiles/work')).toEqual({ OMP_PROFILE: 'work' });
    expect(profileEnv('omp', '/home/u/.omp/profiles/work/')).toEqual({ OMP_PROFILE: 'work' });
    expect(profileEnv('omp', '~/.omp/profiles/client.a_1')).toEqual({ OMP_PROFILE: 'client.a_1' });
    expect(profileEnv('omp', 'C:\\Users\\u\\.omp\\profiles\\work')).toEqual({ OMP_PROFILE: 'work' });
  });

  it('adds nothing for an omp folder that names no profile — the default agent dir among them', () => {
    // The discovered omp account is an AGENT dir (`~/.omp/agent`, or a profile's `agent/`), and
    // it is spawned bare. A folder outside `profiles/` cannot be expressed as OMP_PROFILE at all,
    // which is why the accounts store refuses one rather than relying on this branch.
    expect(profileEnv('omp', '/home/u/.omp/agent')).toEqual({});
    expect(profileEnv('omp', '/home/u/.omp/profiles/work/agent')).toEqual({});
    expect(profileEnv('omp', '/data/omp-work')).toEqual({});
  });

  it('adds NOTHING for the default profile — the zero-config path must stay untouched', () => {
    expect(profileEnv('claude', null)).toEqual({});
    expect(profileEnv('claude', undefined)).toEqual({});
    expect(profileEnv('claude', '   ')).toEqual({});
  });

  it('adds nothing for a provider with no home variable, even given a dir', () => {
    expect(profileEnv('opencode', '/home/u/.config/opencode-work')).toEqual({});
  });

  it('can never emit another provider\'s variable', () => {
    // `buildChildEnv` applies extraEnv AFTER its allowlist, so this function is the only thing
    // standing between a profile and the child env. A codex step must not be handed
    // CLAUDE_CONFIG_DIR, which would point claude's sibling tooling at the wrong home.
    for (const provider of PROVIDER_IDS) {
      const emitted = Object.keys(profileEnv(provider, '/somewhere'));
      const foreign = Object.values(PROFILE_ENV_VAR).filter(
        (name): name is string => name !== null && name !== PROFILE_ENV_VAR[provider],
      );
      expect(emitted.some((name) => foreign.includes(name))).toBe(false);
    }
  });
});

describe('ompProfileName', () => {
  it('takes the folder name when its parent is `profiles`', () => {
    expect(ompProfileName('/home/u/.omp/profiles/work')).toBe('work');
    expect(ompProfileName('/home/u/.omp-alt/profiles/a.b-c_d')).toBe('a.b-c_d');
  });

  it('refuses every name omp itself refuses, so cezar never hands omp a profile it rejects', () => {
    // omp 18.8.0 `packages/utils/src/dirs.ts`: `^[a-z0-9][a-z0-9._-]{0,63}$`, not ending in `.`,
    // not a Windows device name, and `default` meaning NO profile.
    for (const name of ['Work', '-work', '.work', 'work.', 'default', 'con', 'NUL.txt', 'com1', 'a'.repeat(65), 'wo rk', '']) {
      expect(ompProfileName(`/home/u/.omp/profiles/${name}`), name).toBeNull();
    }
    expect(ompProfileName(`/home/u/.omp/profiles/${'a'.repeat(64)}`)).toBe('a'.repeat(64));
  });

  it('refuses a folder whose parent is not `profiles`', () => {
    expect(ompProfileName('/home/u/.omp/agent')).toBeNull();
    expect(ompProfileName('/home/u/work')).toBeNull();
    expect(ompProfileName('work')).toBeNull();
  });
});

describe('profileAgentDir', () => {
  it('is the account folder itself, except omp, whose profile keeps its config in `agent/`', () => {
    expect(profileAgentDir('claude', '/home/u/.claude-work')).toBe('/home/u/.claude-work');
    expect(profileAgentDir('pi', '/home/u/.pi-work/agent')).toBe('/home/u/.pi-work/agent');
    expect(profileAgentDir('omp', '/home/u/.omp/profiles/work')).toBe('/home/u/.omp/profiles/work/agent');
  });
});

describe('looksLikeProfileDir', () => {
  it('recognises a real Claude config dir by any one marker', () => {
    expect(looksLikeProfileDir('claude', ['.claude.json', 'projects', 'sessions'])).toBe(true);
    expect(looksLikeProfileDir('claude', ['settings.json'])).toBe(true);
  });

  it('recognises a Codex home', () => {
    expect(looksLikeProfileDir('codex', ['auth.json', 'history.jsonl'])).toBe(true);
    expect(looksLikeProfileDir('codex', ['config.toml'])).toBe(true);
  });

  it('recognises a pi agent dir', () => {
    expect(looksLikeProfileDir('pi', ['auth.json', 'sessions'])).toBe(true);
    expect(looksLikeProfileDir('pi', ['settings.json'])).toBe(true);
  });

  it('recognises an omp profile folder and the discovered omp agent dir', () => {
    // A named account is the profile folder (`agent/`, `logs/`, …); the default is an agent dir.
    expect(looksLikeProfileDir('omp', ['agent', 'logs', 'run', 'cache'])).toBe(true);
    expect(looksLikeProfileDir('omp', ['agent.db', 'config.yml', 'sessions'])).toBe(true);
  });

  it('says no for an unrelated directory — advisory, so the caller still accepts it', () => {
    expect(looksLikeProfileDir('claude', ['README.md'])).toBe(false);
    expect(looksLikeProfileDir('claude', [])).toBe(false);
  });
});
