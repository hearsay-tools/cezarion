import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { request, type Cockpit } from './http.ts';

describe('task HTTP response bounds', () => {
  let server: Server;
  let cockpit: Cockpit;
  let status: number;
  let stall: boolean;

  beforeEach(async () => {
    status = 200;
    stall = false;
    server = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      if (stall) res.write('['); // Headers arrived, but the list body never finishes.
      else res.end(JSON.stringify('x'.repeat(3_145_729)));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cockpit = { origin, projectId: 'default', api: `${origin}/api/v1/p/default` };
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each([
    ['/runs/run-id', 'GET', 200],
    ['/runs', 'POST', 201],
    ['/runs', 'GET', 500],
  ])('retains the byte cap for %s %s (HTTP %i)', async (path, method, responseStatus) => {
    status = responseStatus;
    await expect(request(cockpit, path, { method })).rejects.toMatchObject({
      exitCode: 2, body: { code: 'unavailable', error: 'cockpit request failed: Response too large' },
    });
  });

  it('retains the request deadline while reading an unbounded run-list body', async () => {
    stall = true;
    await expect(request(cockpit, '/runs', { timeoutMs: 50 })).rejects.toMatchObject({
      exitCode: 2, body: { code: 'unavailable' },
    });
  });
});
