import { testHome } from '../home/test-home.testkit.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { DevServer, probePort } from './dev-server.ts';
import { ChromiumMissingError, PreviewHost, type RunContext } from './host.ts';
import { fakeViewer, fixtureProcessGuard } from './preview.testkit.ts';

// Tags the fixture launch below, so a process left after the test fails it (hearsay-tools/cezarion#1880).
const guard = fixtureProcessGuard();

/** Hang guard for the polls below: each ends the moment its state holds, so the bound only ends a hang. */
const HANG_GUARD_MS = 15_000;
afterEach(() => guard.assertNoneLeft());

it.each(['release', 'replacement'] as const)('reopening during real process teardown keeps %s waiting for the owned group', async action => {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address() as { port: number };
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const root = mkdtempSync(join(tmpdir(), 'cez-host-teardown-'));
  const fixture = fileURLToPath(new URL('./__fixtures__/fake-dev-server.mjs', import.meta.url));
  const command = [process.execPath, fixture, '--port', String(port), '--fork', '--ignore-term', ...guard.args].map(part => JSON.stringify(part)).join(' ');
  const registration = { port, command, label: 'fixture', registeredAt: new Date().toISOString(), answeredAtRegistration: false };
  const run = { id: 'run-1', previewServers: [registration] };
  const ctx: RunContext = { runId: run.id, title: 'teardown', worktreePath: root, dataDir: root, store: { getRun: () => run, appendEvent: () => undefined } as unknown as RunContext['store'] };
  let dev!: DevServer;
  // The real teardown runs; the stop the host awaits settles only once the test opens the gate.
  let tornDown: Promise<void> | undefined;
  let openGate!: () => void;
  const gate = new Promise<void>(resolve => { openGate = resolve; });
  const host = new PreviewHost({ home: testHome(),
    createServer: opts => {
      dev = new DevServer({ ...opts, probeMs: 20 });
      const stop = dev.stop.bind(dev);
      dev.stop = reason => { tornDown ??= stop(reason); return tornDown.then(() => gate); };
      return dev;
    },
    launchBrowser: async () => { throw new ChromiumMissingError(); },
  });
  let stopping: Promise<unknown> | undefined;
  let cleanup: Promise<void> | undefined;
  try {
    await host.open(ctx, fakeViewer(), { port });
    await host.run(run.id, port);
    await expect.poll(() => dev.state, { timeout: HANG_GUARD_MS }).toBe('up');
    stopping = host.stopPreview(run.id, { port, restart: true });
    await expect.poll(() => dev.state, { timeout: HANG_GUARD_MS }).toBe('stopped');
    // The shell exited, but the child ignores TERM and still owns the port until KILL.
    expect(await probePort(port)).toBe(true);
    await host.open(ctx, fakeViewer(), { port });
    if (action === 'replacement') run.previewServers = [{ ...registration, command: 'changed' }];
    let settled = false;
    cleanup = (action === 'release' ? host.release(run.id) : host.replaced(run.id, port)).then(() => { settled = true; });
    // The real teardown ends with a timer-driven KILL. A cleanup that did not wait for the stop has
    // only promise work left, so it would have settled before this resolves.
    await tornDown;
    expect(await probePort(port)).toBe(false);
    expect(settled).toBe(false);
    openGate();
    await cleanup;
    expect(await stopping).toMatchObject({ ok: false });
  } finally {
    openGate();
    await stopping;
    await cleanup;
    await host.release(run.id);
    rmSync(root, { recursive: true, force: true });
  }
});
