import { afterEach, describe, expect, it, vi } from 'vitest';
import { productIdentity } from './identity.ts';

afterEach(() => {
  vi.doUnmock('./switch.ts');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe.each([false, true])('operator display names (switch %s)', rebrand => {
  it('uses the same identity in serve banners, subcommand help and the missing-build title', async () => {
    vi.resetModules();
    vi.doMock('./switch.ts', () => ({ REBRAND_SWITCH: rebrand }));
    const name = rebrand ? productIdentity(true).displayName : 'cezar';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { printServeBanner, warnServeBind } = await import('../serve-boot.ts');
    printServeBanner('1.2.3', '/repo/cezar', null, [], 'http://localhost:4321');
    expect(log.mock.calls[0]).toEqual([`\n  ${name} v1.2.3 — /repo/cezar`]);
    warnServeBind('0.0.0.0', 4321);
    expect(log.mock.calls.at(-1)?.[0]).toContain(`— ${name} has no built-in auth.`);
    const { BUILD_HINT_HTML } = await import('../server/static-ui.ts');
    expect(BUILD_HINT_HTML).toContain(`<title>${name} — build the cockpit</title>`);
    const { runWorkerCommand, runMessageCommand } = await import('../delegation/cli.ts');
    await runWorkerCommand(['--help'], {});
    expect(log.mock.calls.at(-1)?.[0]).toContain(`${name} worker — manage owned coding workers`);
    await runMessageCommand(['--help'], {});
    expect(log.mock.calls.at(-1)?.[0]).toContain(`${name} message — task conversations`);
    const { taskHelp } = await import('../task-cli/cli.ts');
    expect(taskHelp()).toContain(`${name} task — start, watch and steer cockpit tasks`);
  });
});
