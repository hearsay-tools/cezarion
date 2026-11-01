import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disableRemoteSettings, enableRemoteSettings, isGranted, isPortGranted, readRemoteSettings, remoteSettingsPath } from './remote-settings.ts';

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
    expect(readRemoteSettings(env)).toEqual({ grants: [], path: join(home, 'remote-settings') });
    expect(isPortGranted(env, 4321)).toBe(false);
  });

  it('grant one cockpit port at a time, and each read sees the change', async () => {
    await enableRemoteSettings(4322, env, new Date('2026-11-01T10:00:00Z'));
    const both = await enableRemoteSettings(4321, env, new Date('2026-11-01T11:00:00Z'));
    expect(both.grants).toEqual([
      { port: 4321, enabledAt: '2026-11-01T11:00:00.000Z' },
      { port: 4322, enabledAt: '2026-11-01T10:00:00.000Z' },
    ]);
    expect(isGranted(readRemoteSettings(env), 4321)).toBe(true);
    expect(isPortGranted(env, 4321)).toBe(true);
    expect(isGranted(readRemoteSettings(env), 4323)).toBe(false);
    expect(isPortGranted(env, 4323)).toBe(false);
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
    expect(isPortGranted(env, 4321)).toBe(false);
  });

  it('fails closed on a grant file that does not parse', async () => {
    await mkdir(remoteSettingsPath(env), { recursive: true });
    for (const content of ['not json', '[]', '{"enabledAt": 5}']) {
      await writeFile(join(remoteSettingsPath(env), '4321.json'), content);
      const state = readRemoteSettings(env);
      expect(state.grants, content).toEqual([]);
      expect(state.issue, content).toBeDefined();
      expect(isPortGranted(env, 4321), content).toBe(false);
    }
  });

  it('ignores files that do not name a port', async () => {
    await mkdir(remoteSettingsPath(env), { recursive: true });
    for (const name of ['0.json', '70000.json', 'x.json', '.4321.1.2.tmp', 'remote-settings.json']) {
      await writeFile(join(remoteSettingsPath(env), name), '{}');
    }
    expect(readRemoteSettings(env).grants).toEqual([]);
    expect(isPortGranted(env, 0)).toBe(false);
    expect(isPortGranted(env, 70000)).toBe(false);
  });

  // Two enable or disable runs at once must not restore a grant the other withdrew.
  it('concurrent grants and withdrawals never undo each other', async () => {
    const ports = Array.from({ length: 12 }, (_, index) => 4321 + index);
    await Promise.all(ports.map((port) => enableRemoteSettings(port, env)));
    expect(readRemoteSettings(env).grants.map((grant) => grant.port)).toEqual(ports);
    const withdrawn = ports.filter((port) => port % 2 === 0);
    await Promise.all(withdrawn.map((port) => disableRemoteSettings(env, port)));
    expect(readRemoteSettings(env).grants.map((grant) => grant.port)).toEqual(ports.filter((port) => port % 2 === 1));
  });

  it('disable succeeds when nothing is granted', async () => {
    expect((await disableRemoteSettings(env)).grants).toEqual([]);
    expect((await disableRemoteSettings(env, 4321)).grants).toEqual([]);
  });
});
