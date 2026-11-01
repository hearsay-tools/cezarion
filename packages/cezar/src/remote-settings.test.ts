import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disableRemoteSettings, enableRemoteSettings, isGranted, readRemoteSettings, remoteSettingsPath } from './remote-settings.ts';

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'cez-remote-settings-'));
  env = { CEZ_HOME: home };
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('remote settings grants', () => {
  it('grant nothing when the host file does not exist', () => {
    expect(readRemoteSettings(env)).toEqual({ grants: [], path: join(home, 'remote-settings.json') });
  });

  it('grant one cockpit port at a time, and each read sees the change', async () => {
    await enableRemoteSettings(4322, env, new Date('2026-11-01T10:00:00Z'));
    const both = await enableRemoteSettings(4321, env, new Date('2026-11-01T11:00:00Z'));
    expect(both.grants).toEqual([
      { port: 4321, enabledAt: '2026-11-01T11:00:00.000Z' },
      { port: 4322, enabledAt: '2026-11-01T10:00:00.000Z' },
    ]);
    expect(isGranted(readRemoteSettings(env), 4321)).toBe(true);
    expect(isGranted(readRemoteSettings(env), 4323)).toBe(false);
    expect(isGranted(readRemoteSettings(env), undefined)).toBe(false);

    const one = await disableRemoteSettings(env, 4321);
    expect(one.grants.map((grant) => grant.port)).toEqual([4322]);
    expect(isGranted(readRemoteSettings(env), 4321)).toBe(false);
  });

  it('disable without a port withdraws every grant', async () => {
    await enableRemoteSettings(4321, env);
    await enableRemoteSettings(4322, env);
    expect((await disableRemoteSettings(env)).grants).toEqual([]);
    expect(readRemoteSettings(env).grants).toEqual([]);
  });

  it('withdrawing the last grant removes the file', async () => {
    await enableRemoteSettings(4321, env);
    await disableRemoteSettings(env, 4321);
    expect(readRemoteSettings(env)).toEqual({ grants: [], path: remoteSettingsPath(env) });
  });

  it('fails closed on a file that names no valid cockpit port', async () => {
    for (const content of ['not json', '{"enabled": true}', '{"cockpits": {"0": {}}}', '{"cockpits": {"70000": {}}}', '{"cockpits": []}']) {
      await writeFile(remoteSettingsPath(env), content);
      const state = readRemoteSettings(env);
      expect(state.grants, content).toEqual([]);
      expect(state.issue, content).toBeDefined();
    }
  });

  it('disable succeeds when nothing is granted', async () => {
    expect((await disableRemoteSettings(env)).grants).toEqual([]);
    expect((await disableRemoteSettings(env, 4321)).grants).toEqual([]);
  });
});
