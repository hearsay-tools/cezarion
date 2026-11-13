import { afterEach, expect, it, vi } from 'vitest';
import type { InstallContext } from '../server-install/types.ts';
import { freshServerState } from '../server-install/types.ts';
import { createAutoUi } from '../server-install/ui.ts';
import { createUbuntuVps } from '../server-install/platforms/ubuntu-vps.ts';
import { testHome } from './test-home.testkit.ts';
import { productIdentity } from './identity.ts';

afterEach(() => { vi.restoreAllMocks(); });

it('keeps shared packages for manual removal and names the product in the uninstall notice', async () => {
  const ui = createAutoUi();
  const note = vi.spyOn(ui, 'note');
  const capture = vi.fn(), interactive = vi.fn();
  const ctx: InstallContext = {
    home: testHome(), state: freshServerState(), ui, runner: { capture, interactive },
    instance: 'default', save: async () => {}, dryRun: true, assumeYes: true,
    reconfigure: new Set(), repoRoot: '/unused', now: '2030-01-01T00:00:00Z', prefs: {},
  };
  const step = createUbuntuVps().steps(ctx).find(step => step.id === 'nginx-proxy');
  expect(step).toBeDefined();
  await step!.undo(ctx, { artifacts: [{ kind: 'shared', type: 'package', name: 'nginx', removeHint: 'remove nginx manually' }] });
  expect(note).toHaveBeenCalledWith('remove nginx manually', `Installed for ${productIdentity().displayName} but possibly used elsewhere — remove manually if unwanted`);
  expect(capture).not.toHaveBeenCalled();
  expect(interactive).not.toHaveBeenCalled();
});
