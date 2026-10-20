import { describe, expect, it } from 'vitest';
import { permissionRequestedSchema } from '@open-mercato/cezar-contract/permissions';
import {
  isOpencodeDefaultAsk,
  opencodePermissionAskSchema,
  opencodePermissionBridge,
  opencodeUserPermissionRules,
  opencodeWildcardMatch,
  type OpencodePermissionAsk,
} from './opencode-permissions.ts';

/** OpenCode 1.18.35 `permission.asked` properties, as the SSE bus carries them (hearsay-tools/cezarion#1266). */
const ask = (permission: string, patterns: string[] = ['*']): OpencodePermissionAsk =>
  opencodePermissionAskSchema.parse({ id: 'per_1', sessionID: 'ses_1', permission, patterns, metadata: {}, always: patterns });
const externalAsk = ask('external_directory', ['/outside/*']);

describe('OpenCode default permission asks (hearsay-tools/cezarion#1266)', () => {
  it('treats the three built-in asks as defaults under an empty user config', () => {
    const rules = opencodeUserPermissionRules({});
    expect(rules).toEqual([]);
    expect(isOpencodeDefaultAsk(externalAsk, rules)).toBe(true);
    expect(isOpencodeDefaultAsk(ask('doom_loop'), rules)).toBe(true);
    expect(isOpencodeDefaultAsk(ask('read', ['/repo/.env']), rules)).toBe(true);
    for (const permission of ['skill', 'bash', 'edit']) expect(isOpencodeDefaultAsk(ask(permission), rules)).toBe(false);
  });

  it('defers to a user rule for the asked permission', () => {
    for (const config of [
      { permission: { external_directory: 'ask' } },
      { permission: { external_directory: { '/secret/*': 'deny' } } },
      { permission: 'ask' },
      { permission: { '*': 'ask' } },
      { permission: { 'external_*': 'ask' } },
      { agent: { build: { permission: { external_directory: 'ask' } } } },
      { mode: { plan: { permission: { external_directory: 'ask' } } } },
    ]) {
      expect(isOpencodeDefaultAsk(externalAsk, opencodeUserPermissionRules(config)), JSON.stringify(config)).toBe(false);
    }
  });

  it('keeps other defaults when the user configures an unrelated permission', () => {
    const rules = opencodeUserPermissionRules({ permission: { skill: 'ask' } });
    expect(isOpencodeDefaultAsk(ask('skill'), rules)).toBe(false);
    expect(isOpencodeDefaultAsk(externalAsk, rules)).toBe(true);
  });

  it('treats an unreadable config as unknown provenance', () => {
    for (const config of ['oops', null, []]) expect(opencodeUserPermissionRules(config)).toBeUndefined();
    expect(isOpencodeDefaultAsk(externalAsk, undefined)).toBe(false);
  });

  it('builds a cockpit request with opaque ids and the three OpenCode replies', () => {
    const bridge = opencodePermissionBridge(opencodePermissionAskSchema.parse({
      id: 'per_1', sessionID: 'ses_1', permission: 'skill', patterns: ['brainstorming'], always: ['brainstorming'], metadata: {},
    }));
    expect(bridge.nativeId).toBe('per_1');
    expect(bridge.event.requestId).not.toBe('per_1');
    expect(bridge.event.options.map(option => [option.label, option.kind])).toEqual([
      ['Allow once', 'allow_once'], ['Allow always', 'allow_always'], ['Reject', 'reject_once'],
    ]);
    expect(bridge.event.options.map(option => bridge.replies.get(option.id))).toEqual(['once', 'always', 'reject']);
    expect(() => permissionRequestedSchema.parse(bridge.event)).not.toThrow();
    expect(JSON.parse(bridge.event.details!)).toEqual({
      permission: 'skill', patterns: ['brainstorming'], always: ['brainstorming'], metadata: {},
    });
  });

  it('rejects malformed asks', () => {
    const valid = { id: 'per_1', sessionID: 'ses_1', permission: 'skill', patterns: ['x'] };
    const { id: _id, ...missingId } = valid;
    expect(opencodePermissionAskSchema.safeParse(valid).success).toBe(true);
    expect(opencodePermissionAskSchema.safeParse(missingId).success).toBe(false);
    expect(opencodePermissionAskSchema.safeParse({ ...valid, patterns: 'x' }).success).toBe(false);
    expect(opencodePermissionAskSchema.safeParse({ ...valid, permission: '' }).success).toBe(false);
  });

  it('matches OpenCode wildcards', () => {
    expect(opencodeWildcardMatch('external_directory', 'external_*')).toBe(true);
    expect(opencodeWildcardMatch('doom_loop', '*')).toBe(true);
    expect(opencodeWildcardMatch('read', 're?d')).toBe(true);
    expect(opencodeWildcardMatch('read', 'rea')).toBe(false);
    expect(opencodeWildcardMatch('xread', 'read')).toBe(false);
  });
});
