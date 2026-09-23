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

describe('server-owned restart endpoint', () => {
  it('captures a bound nondefault address and actual assigned port', async () => {
    const { restartEndpoint } = await import('./helper.ts');
    expect(restartEndpoint({ address: '127.0.0.2', family: 'IPv4', port: 54321 })).toEqual({ host: '127.0.0.2', port: 54321 });
  });

  it('formats IPv6 health URLs with brackets', async () => {
    const { restartHealthUrl } = await import('./helper.ts');
    expect(restartHealthUrl({ host: '::1', port: 4321 })).toBe('http://[::1]:4321/api/v1/health');
  });

  it('refuses missing, unbound or non-loopback endpoints', async () => {
    const { restartEndpoint } = await import('./helper.ts');
    for (const address of [null, '/tmp/socket',
      { address: '127.0.0.1', family: 'IPv4', port: 0 },
      { address: '0.0.0.0', family: 'IPv4', port: 4321 },
      { address: '192.168.1.2', family: 'IPv4', port: 4321 },
      { address: '127.0.0.1.evil.test', family: 'IPv4', port: 4321 },
      { address: '::', family: 'IPv6', port: 4321 },
    ]) expect(() => restartEndpoint(address)).toThrow();
  });
});

describe('direct restart health request', () => {
  it.each([false, true])('aborts and closes an unresponsive probe (headers sent=%s)', async (sendHeaders) => {
    const { createServer } = await import('node:http');
    const { requestRestartHealth } = await import('./helper.ts');
    let closed!: Promise<void>;
    let received!: () => void;
    const started = new Promise<void>(resolve => { received = resolve; });
    const server = createServer((_request, response) => {
      closed = new Promise<void>(resolve => response.once('close', resolve));
      if (sendHeaders) { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); }
      received();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing fixture listener');
      const controller = new AbortController();
      const rejected = expect(requestRestartHealth({ host: address.address, port: address.port }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
      await started;
      controller.abort();
      await rejected;
      await closed;
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
