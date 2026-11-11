import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstallContext } from '../server-install/types.ts';
import { testHome } from './test-home.testkit.ts';
import { productIdentity } from './identity.ts';

afterEach(() => {
  vi.doUnmock('./switch.ts');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe.each([false, true])('secondary operator display names (switch %s)', rebrand => {
  it('keeps shared packages for manual removal and names the product in the uninstall notice', async () => {
    vi.resetModules();
    vi.doMock('./switch.ts', () => ({ REBRAND_SWITCH: rebrand }));
    const { createAutoUi } = await import('../server-install/ui.ts');
    const { freshServerState } = await import('../server-install/types.ts');
    const ui = createAutoUi();
    const note = vi.spyOn(ui, 'note');
    const capture = vi.fn(), interactive = vi.fn();
    const ctx: InstallContext = {
      home: testHome(), state: freshServerState(), ui, runner: { capture, interactive },
      instance: 'default', save: async () => {}, dryRun: true, assumeYes: true,
      reconfigure: new Set(), repoRoot: '/unused', now: '2030-01-01T00:00:00Z', prefs: {},
    };
    const { createUbuntuVps } = await import('../server-install/platforms/ubuntu-vps.ts');
    const step = createUbuntuVps({ rebrand }).steps(ctx).find(step => step.id === 'nginx-proxy');
    expect(step).toBeDefined();
    await step!.undo(ctx, { artifacts: [{ kind: 'shared', type: 'package', name: 'nginx', removeHint: 'remove nginx manually' }] });
    expect(note).toHaveBeenCalledWith('remove nginx manually', `Installed for ${rebrand ? productIdentity(true).displayName : 'cezar'} but possibly used elsewhere — remove manually if unwanted`);
    expect(capture).not.toHaveBeenCalled();
    expect(interactive).not.toHaveBeenCalled();
  });
});
