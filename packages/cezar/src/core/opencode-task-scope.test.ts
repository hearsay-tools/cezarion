import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPENCODE_TASK_SCOPE_PLUGIN, opencodeTaskScopeEnv } from './opencode-task-scope.ts';
import { CezarTaskScope } from '../../scripts/opencode-task-scope.mjs';

type Sessions = Record<string, string | null>;

/** A client whose `session.get` answers like OpenCode 1.19.4: the session with its parentID, or 404. */
function client(sessions: Sessions, fail?: string) {
  const get = vi.fn(async ({ path: { id } }: { path: { id: string } }) => {
    if (id === fail) return { data: undefined, response: { status: 500 } };
    if (!Object.hasOwn(sessions, id)) return { data: undefined, response: { status: 404 } };
    const parentID = sessions[id];
    return { data: { id, ...(parentID ? { parentID } : {}) }, response: { status: 200 } };
  });
  return { session: { get } };
}

async function hook(sessions: Sessions, fail?: string) {
  return (await CezarTaskScope({ client: client(sessions, fail) }))['tool.execute.before'];
}

const call = (sessionID: string, args: unknown, tool = 'task') => [{ tool, sessionID, callID: 'c1' }, { args }] as const;

// Two cezar tasks: root A with child A1 and grandchild A2, and root B with child B1.
const SESSIONS: Sessions = { A: null, A1: 'A', A2: 'A1', B: null, B1: 'B' };

describe('opencode-task-scope plugin (hearsay-tools/cezarion#2279)', () => {
  describe('local subagent coordination stays allowed', () => {
    it.each([
      ['a new subagent (no task_id)', 'A', { prompt: 'p', subagent_type: 'general' }],
      ['an empty task_id', 'A', { task_id: '' }],
      ['its own child', 'A', { task_id: 'A1' }],
      ['a nested descendant', 'A', { task_id: 'A2' }],
      ['a sibling subagent, from a subagent', 'A2', { task_id: 'A1' }],
      ['an unknown task_id, which OpenCode starts fresh', 'A', { task_id: 'ses_missing' }],
    ])('%s', async (_name, sessionID, args) => {
      await expect((await hook(SESSIONS))(...call(sessionID, args))).resolves.toBeUndefined();
    });

    it('ignores every tool but task', async () => {
      await expect((await hook(SESSIONS))(...call('A', { task_id: 'B' }, 'bash'))).resolves.toBeUndefined();
    });
  });

  describe('a native call into another cezar task is refused', () => {
    it.each([
      ['another task\'s root session', 'A', 'B'],
      ['another task\'s subagent', 'A1', 'B1'],
    ])('%s', async (_name, sessionID, target) => {
      await expect((await hook(SESSIONS))(...call(sessionID, { task_id: target }))).rejects.toThrow(/cez message/);
    });

    it('refuses when a lookup fails rather than letting the call through', async () => {
      await expect((await hook(SESSIONS, 'A'))(...call('A1', { task_id: 'A1' }))).rejects.toThrow(/cez message/);
    });
  });
});

describe('opencodeTaskScopeEnv', () => {
  const entry = pathToFileURL(OPENCODE_TASK_SCOPE_PLUGIN).href;
  afterEach(() => { vi.unstubAllEnvs(); });

  it('leaves an ungoverned session\'s env untouched', () => {
    const env = { A: '1' };
    expect(opencodeTaskScopeEnv(env, undefined)).toBe(env);
    expect(opencodeTaskScopeEnv(undefined, false)).toBeUndefined();
  });

  it('adds the plugin to an empty runtime config', () => {
    vi.stubEnv('OPENCODE_CONFIG_CONTENT', '');
    const env = opencodeTaskScopeEnv({ A: '1' }, true)!;
    expect(env.A).toBe('1');
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({ plugin: [entry] });
  });

  it('appends after supplied plugins and keeps every other key, from the session env first', () => {
    vi.stubEnv('OPENCODE_CONFIG_CONTENT', JSON.stringify({ plugin: ['ignored'] }));
    const supplied = JSON.stringify({ plugin: ['user-plugin'], mcp: { x: { type: 'remote', url: 'https://example.org' } } });
    const env = opencodeTaskScopeEnv({ OPENCODE_CONFIG_CONTENT: supplied }, true)!;
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      plugin: ['user-plugin', entry], mcp: { x: { type: 'remote', url: 'https://example.org' } },
    });
  });

  it('reads a supplied runtime config from the process env', () => {
    vi.stubEnv('OPENCODE_CONFIG_CONTENT', '{ "plugin": ["user-plugin"] // jsonc\n}');
    expect(JSON.parse(opencodeTaskScopeEnv(undefined, true)!.OPENCODE_CONFIG_CONTENT!)).toEqual({ plugin: ['user-plugin', entry] });
  });

  it.each(['not json', '[]', '{"plugin":"one"}'])('fails closed on an invalid supplied config: %s', supplied => {
    expect(() => opencodeTaskScopeEnv({ OPENCODE_CONFIG_CONTENT: supplied }, true)).toThrow(/Cross-task control unavailable/);
  });
});
