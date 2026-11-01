import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enableRemoteSettings, readRemoteSettings } from './remote-settings.ts';
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

const ports = () => readRemoteSettings(env).grants.map((grant) => grant.port);
const remote = (port: number, settingsAdmin = false): CockpitHealth => ({ url: `http://127.0.0.1:${port}`, localHandoff: false, settingsAdmin });

describe('cez remote-settings', () => {
  it('enable --port grants that cockpit and prints the host-command warning', async () => {
    const { code, body } = await run(['enable', '--port', '4322']);
    expect(code).toBe(0);
    expect(body).toMatchObject({ ok: true, port: 4322, path: join(home, 'remote-settings.json'), warning: REMOTE_SETTINGS_WARNING });
    expect(ports()).toEqual([4322]);
  });

  it('enable without --port grants the only remote cockpit running on loopback', async () => {
    const { code, body } = await run(['enable'], [{ url: 'http://127.0.0.1:4321', localHandoff: true, settingsAdmin: true }, remote(4325)]);
    expect(code).toBe(0);
    expect(body.port).toBe(4325);
    expect(ports()).toEqual([4325]);
  });

  it.each([
    ['no remote cockpit', [] as CockpitHealth[], []],
    ['several remote cockpits', [remote(4321), remote(4322)], [4321, 4322]],
  ])('enable without --port refuses with %s and grants nothing', async (_case, cockpits, listed) => {
    const { code, body } = await run(['enable'], cockpits);
    expect(code).toBe(2);
    expect(body).toMatchObject({ ok: false, code: 'choose_cockpit', ports: listed });
    expect(String(body.error)).toContain('--port');
    expect(ports()).toEqual([]);
  });

  it('disable --port withdraws one grant; disable alone withdraws every grant', async () => {
    await run(['enable', '--port', '4321']);
    await run(['enable', '--port', '4322']);
    expect((await run(['disable', '--port', '4321'])).body).toMatchObject({ ok: true, grants: [{ port: 4322 }] });
    expect(ports()).toEqual([4322]);
    expect((await run(['disable'])).body).toMatchObject({ ok: true, grants: [] });
    expect(ports()).toEqual([]);
  });

  it('status reports the grants and what each cockpit does with them', async () => {
    await enableRemoteSettings(4321, env);
    await enableRemoteSettings(4322, env);
    const { body } = await run(['status'], [
      remote(4321, true),
      remote(4322, false),
      remote(4323, false),
      { url: 'http://127.0.0.1:4324', localHandoff: true, settingsAdmin: true },
      { url: 'http://127.0.0.1:4325', localHandoff: false },
      // An older local cockpit sends no settingsAdmin, and still edits settings.
      { url: 'http://127.0.0.1:4326', localHandoff: true },
    ]);
    expect((body.grants as Array<{ port: number }>).map((grant) => grant.port)).toEqual([4321, 4322]);
    expect(body.cockpits).toEqual([
      { url: 'http://127.0.0.1:4321', remote: true, settingsAdmin: true, effect: 'remote cockpit: remote settings administration is in effect' },
      {
        url: 'http://127.0.0.1:4322',
        remote: true,
        settingsAdmin: false,
        effect: 'remote cockpit: granted, but settings stay read-only because it binds a non-loopback host, or it reads another CEZ_HOME',
      },
      { url: 'http://127.0.0.1:4323', remote: true, settingsAdmin: false, effect: 'remote cockpit: not granted, settings are read-only' },
      { url: 'http://127.0.0.1:4324', remote: false, settingsAdmin: true, effect: 'local cockpit: settings are editable without a grant' },
      { url: 'http://127.0.0.1:4325', remote: true, settingsAdmin: false, effect: 'this cockpit is older than remote settings administration and keeps settings read-only' },
      { url: 'http://127.0.0.1:4326', remote: false, settingsAdmin: true, effect: 'local cockpit: settings are editable without a grant' },
    ]);
  });

  it.each([[[]], [['open']], [['enable', 'now']], [['enable', '--port', '0']], [['enable', '--port', '70000']], [['enable', '--port', 'x']], [['status', '--port', '4321']], [['enable', '--bogus']]])(
    'refuses %j with usage exit 64 and grants nothing',
    async (argv) => {
      const { code, body } = await run(argv, [remote(4321)]);
      expect(code).toBe(64);
      expect(body).toMatchObject({ ok: false, code: 'invalid_input' });
      expect(ports()).toEqual([]);
    },
  );
});
