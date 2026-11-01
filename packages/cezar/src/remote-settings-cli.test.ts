import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRemoteSettings } from './remote-settings.ts';
import { REMOTE_SETTINGS_WARNING, runRemoteSettingsCommand, type CockpitHealth } from './remote-settings-cli.ts';

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cez-remote-settings-cli-'));
  env = { CEZ_HOME: home };
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function run(argv: string[], cockpits: CockpitHealth[] = []) {
  const lines: string[] = [];
  const code = await runRemoteSettingsCommand(argv, env, { stdout: (line) => lines.push(line), cockpits: async () => cockpits });
  return { code, body: JSON.parse(lines.join('\n')) as Record<string, unknown> };
}

describe('cez remote-settings', () => {
  it('enable turns the switch on and prints the host-command warning', async () => {
    const { code, body } = await run(['enable']);
    expect(code).toBe(0);
    expect(body).toMatchObject({ ok: true, enabled: true, path: join(home, 'remote-settings.json'), warning: REMOTE_SETTINGS_WARNING });
    expect(readRemoteSettings(env).enabled).toBe(true);
  });

  it('disable turns it off again', async () => {
    await run(['enable']);
    const { code, body } = await run(['disable']);
    expect(code).toBe(0);
    expect(body).toMatchObject({ ok: true, enabled: false });
    expect(readRemoteSettings(env).enabled).toBe(false);
  });

  it('status reports the switch and what each cockpit does with it', async () => {
    await run(['enable']);
    const { body } = await run(['status'], [
      { url: 'http://127.0.0.1:4321', localHandoff: false, settingsAdmin: true },
      { url: 'http://127.0.0.1:4322', localHandoff: false, settingsAdmin: false },
      { url: 'http://127.0.0.1:4323', localHandoff: true, settingsAdmin: true },
      { url: 'http://127.0.0.1:4324', localHandoff: false },
      { url: 'http://127.0.0.1:4325', localHandoff: true },
    ]);
    expect(body.enabled).toBe(true);
    expect(body.cockpits).toEqual([
      { url: 'http://127.0.0.1:4321', remote: true, settingsAdmin: true, effect: 'remote cockpit: remote settings administration is in effect' },
      {
        url: 'http://127.0.0.1:4322',
        remote: true,
        settingsAdmin: false,
        effect: 'remote cockpit: settings stay read-only because it binds a non-loopback host, or it reads another CEZ_HOME',
      },
      { url: 'http://127.0.0.1:4323', remote: false, settingsAdmin: true, effect: 'local cockpit: settings are editable without the switch' },
      { url: 'http://127.0.0.1:4324', remote: true, settingsAdmin: false, effect: 'this cockpit is older than the switch and keeps settings read-only' },
      // An older local cockpit sends no settingsAdmin, and still edits settings.
      { url: 'http://127.0.0.1:4325', remote: false, settingsAdmin: true, effect: 'local cockpit: settings are editable without the switch' },
    ]);
  });

  it('status with the switch off says remote cockpits are read-only', async () => {
    const { body } = await run(['status'], [{ url: 'http://127.0.0.1:4321', localHandoff: false, settingsAdmin: false }]);
    expect(body).toMatchObject({ enabled: false, cockpits: [{ effect: 'remote cockpit: settings are read-only' }] });
  });

  it.each([[[]], [['open']], [['enable', 'now']]])('refuses %j with usage exit 64', async (argv) => {
    const { code, body } = await run(argv);
    expect(code).toBe(64);
    expect(body).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(readRemoteSettings(env).enabled).toBe(false);
  });
});
