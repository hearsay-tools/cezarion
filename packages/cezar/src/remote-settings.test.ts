import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disableRemoteSettings, enableRemoteSettings, readRemoteSettings, remoteSettingsPath } from './remote-settings.ts';

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'cez-remote-settings-'));
  env = { CEZ_HOME: home };
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('remote settings switch', () => {
  it('is off when the host file does not exist', () => {
    expect(readRemoteSettings(env)).toEqual({ enabled: false, path: join(home, 'remote-settings.json') });
  });

  it('turns on, then off again, and each read sees the change', async () => {
    const on = await enableRemoteSettings(env, new Date('2026-11-01T10:00:00Z'));
    expect(on).toMatchObject({ enabled: true, enabledAt: '2026-11-01T10:00:00.000Z' });
    expect(readRemoteSettings(env).enabled).toBe(true);
    const off = await disableRemoteSettings(env);
    expect(off.enabled).toBe(false);
    expect(readRemoteSettings(env).enabled).toBe(false);
  });

  it('fails closed on a file that does not say enabled: true', async () => {
    for (const content of ['not json', '{"enabled": "yes"}', '{"enabled": false}', '[]']) {
      await writeFile(remoteSettingsPath(env), content);
      const state = readRemoteSettings(env);
      expect(state.enabled, content).toBe(false);
      expect(state.issue, content).toBeDefined();
    }
  });

  it('disable succeeds when the switch is already off', async () => {
    expect((await disableRemoteSettings(env)).enabled).toBe(false);
  });
});
