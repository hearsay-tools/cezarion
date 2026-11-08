import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstallContext } from '../server-install/types.ts';
import { Home } from './home.ts';
import { testHome } from './test-home.testkit.ts';
import { productIdentity } from './identity.ts';

afterEach(() => {
  vi.doUnmock('./switch.ts');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe.each([false, true])('secondary operator display names (switch %s)', rebrand => {
  it('names the desktop product after linking a built checkout', async () => {
    vi.resetModules();
    vi.doMock('./switch.ts', () => ({ REBRAND_SWITCH: rebrand }));
    const root = mkdtempSync(join(tmpdir(), 'display-link-'));
    try {
      mkdirSync(join(root, 'dist'));
      writeFileSync(join(root, 'dist/index.js'), '// fixture');
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: productIdentity(false).npmPackage, version: '1.2.3' }));
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { runSelfUpdateCommand } = await import('../self-update/cli.ts');
      const home = Home.sandbox(join(root, 'home'));
      const { SelfUpdateService } = await import('../self-update/service.ts');
      const service = new SelfUpdateService({ home, pkgName: productIdentity(false).npmPackage, version: '1.2.3', entry: join(root, 'dist/index.js'), restart: () => {} });
      expect(await runSelfUpdateCommand('link', [root], { home, modifyPath: false, service })).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toContain(`desktop: ${rebrand ? productIdentity(true).displayName : 'Cezar'} ▸ Versions`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
