import { describe, expect, it, vi } from 'vitest';
import { manualRepairCommand, runRestartWorkflow, type RestartIO } from './helper.ts';

function setup(fail?: keyof RestartIO) {
  const order: string[] = [];
  const step = (name: string) => vi.fn(async () => { order.push(name); if (fail === name) throw new Error(name); });
  const io: RestartIO = {
    waitForOldExit: step('waitForOldExit'),
    promote: step('promote'),
    validateOriginal: step('validateOriginal'),
    launch: step('launch'),
    verifyHealth: step('verifyHealth'),
    reapReplacement: step('reapReplacement'),
    restore: step('restore'),
    launchPrevious: step('launchPrevious'),
    reportSuccess: step('reportSuccess'),
    reportFailure: step('reportFailure'),
  };
  return { io, order };
}

describe('restart helper transaction', () => {
  it('waits for old exit before promotion and proves new health before success', async () => {
    const { io, order } = setup();
    await runRestartWorkflow(io);
    expect(order).toEqual(['waitForOldExit', 'promote', 'validateOriginal', 'launch', 'verifyHealth', 'reportSuccess']);
  });

  it.each(['promote', 'validateOriginal', 'launch', 'verifyHealth'] as const)('restores after %s failure, reaping a replacement first', async (failed) => {
    const { io, order } = setup(failed);
    await runRestartWorkflow(io);
    expect(order.indexOf('restore')).toBeGreaterThan(order.indexOf(failed));
    if (failed === 'verifyHealth') expect(order.indexOf('reapReplacement')).toBeLessThan(order.indexOf('restore'));
    expect(order.at(-2)).toBe('launchPrevious');
    expect(order.at(-1)).toBe('reportFailure');
  });

  it('reports rollback failure without claiming success', async () => {
    const { io, order } = setup('restore');
    io.promote = async () => { order.push('promote'); throw new Error('promotion'); };
    await runRestartWorkflow(io);
    expect(order).toContain('reportFailure');
    expect(order).not.toContain('reportSuccess');
  });

  it('does not restore files or relaunch while the replacement might still be alive', async () => {
    const { io, order } = setup('reapReplacement');
    let rollbackFailed: boolean | undefined;
    io.verifyHealth = async () => { order.push('verifyHealth'); throw new Error('bad health'); };
    io.reportFailure = async (failed) => { rollbackFailed = failed; order.push('reportFailure'); };
    await runRestartWorkflow(io);
    expect(order).toContain('reapReplacement');
    expect(order).not.toContain('restore');
    expect(order).not.toContain('launchPrevious');
    expect(rollbackFailed).toBe(true);
  });

  it('provides a private npm repair command for the original installation', () => {
    expect(manualRepairCommand({ kind: 'global', prefix: '/tmp/test prefix', installRoot: '/unused', outerPackage: 'cezarion' }, '1.0.0'))
      .toBe("npm install --global --prefix '/tmp/test prefix' cezarion@1.0.0");
    expect(manualRepairCommand({ kind: 'npx', prefix: '/unused', installRoot: '/tmp/npx root', outerPackage: 'cezarion' }, '0.14.8'))
      .toBe("npm install --prefix '/tmp/npx root' cezarion@0.14.8");
  });
});
