import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import type { DelegationRoutes } from './routes.ts';

export function createDelegationApp(routes: DelegationRoutes) {
  return new Hono().route('/api/v1/delegation', routes);
}
export type DelegationApp = ReturnType<typeof createDelegationApp>;
export async function startDelegationTransport(app: DelegationApp): Promise<{ url: string; close(): Promise<void> }> {
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  try {
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  } catch (error) { server.close(); throw error; }
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}/api/v1/delegation`, close: () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    if ('closeAllConnections' in server) server.closeAllConnections();
  }) };
}
