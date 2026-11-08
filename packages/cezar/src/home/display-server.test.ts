import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os'; // test-home-read: checks refusal of the pinned test home; never writes it.
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunManager } from '../workflows/run.ts';
import type { InstallContext } from '../server-install/types.ts';
import { testHome } from './test-home.testkit.ts';
import { productIdentity } from './identity.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';

afterEach(() => {
  vi.doUnmock('./switch.ts');
  vi.resetModules();
});

describe.each([false, true])('server display names (switch %s)', rebrand => {
  it('gates an API refusal, account hint and installer label without changing their contracts', async () => {
    vi.resetModules();
    vi.doMock('./switch.ts', () => ({ REBRAND_SWITCH: rebrand }));
    const name = rebrand ? productIdentity(true).displayName : 'cezar';
    const refusedRoot = homedir(); // test-home-read: the API must reject the pinned OS home, not an arbitrary sandbox folder.
    const { readAccountIdentity } = await import('../agent-config/account-identity.ts');
    expect(await readAccountIdentity('opencode', '/unused')).toEqual({
      available: false, fields: [],
      reason: `OpenCode keeps its login outside its config folder, so ${name} cannot read it.`,
    });
    const { createUbuntuVps } = await import('../server-install/platforms/ubuntu-vps.ts');
    const step = createUbuntuVps({ rebrand }).steps({ state: {} } as InstallContext).find(step => step.id === 'autostart');
    expect(step?.title).toBe(`Run ${name} as a service (systemd — starts now + on boot)`);
    const command = productIdentity(rebrand).command;
    const { previewRefusal } = await import('../ci-wait/errors.ts');
    expect(previewRefusal('headless').message).toBe(`No cockpit is attached to this run (\`${command} run\`).`);
    const { SKILL_SOURCES_HOSTED_ERROR } = await import('../server/skill-sources.ts');
    expect(SKILL_SOURCES_HOSTED_ERROR).toContain(`run \`${command} remote-settings enable\``);
    const { listAgentConfig } = await import('../agent-config/service.ts');
    const listing = await listAgentConfig('/unused', {}, false);
    expect(listing.files.find(file => file.readOnlyReason)?.readOnlyReason).toContain(`run \`${command} remote-settings enable\``);
    const { RunStore } = await import('../runs/store.ts');
    const { createApp } = await import('../server/server.ts');
    const root = mkdtempSync(join(tmpdir(), 'display-server-'));
    const store = RunStore.open(join(root, '.ai/cezar'));
    try {
      const app = createApp({ home: testHome(), repoRoot: root, store, manager: {} as RunManager, version: 'test' });
      const response = await apiRequest(app, '/api/v1/projects', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: refusedRoot }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: `not a project folder: ${refusedRoot} is your home directory or a ${name} task worktree` });
    } finally {
      store.flush();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
