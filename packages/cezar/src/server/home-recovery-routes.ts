import { Hono, type Context } from 'hono';
import { homeRecoveryActionSchema } from '@open-mercato/cezar-contract/home-recovery';
import type { Home } from '../home/home.ts';
import { acceptHomeRecovery, getHomeRecovery, importHomeRecovery, restoreHomeRecovery } from '../home/recovery.ts';
import { subscribeHomeRecovery } from '../home/recovery-watch.ts';
import { REBRAND_SWITCH } from '../home/switch.ts';
import { jsonZodValidator } from './validators.ts';
import type { SocketHub, TopicPublisher } from './ws.ts';

export const HOME_RECOVERY_TOPIC = 'home:recovery';

/** Watching and inspection live in HomeStore's recovery service, only while demand exists. */
export function createHomeRecoveryPublisher(home: Home, legacyCanary = REBRAND_SWITCH): TopicPublisher {
  return {
    snapshot: async () => getHomeRecovery(home, legacyCanary),
    start(publish) {
      let previous = JSON.stringify(getHomeRecovery(home, legacyCanary));
      return subscribeHomeRecovery(home, () => {
        const snapshot = getHomeRecovery(home, legacyCanary);
        const serialized = JSON.stringify(snapshot);
        if (serialized === previous) return;
        previous = serialized;
        publish(snapshot);
      }, legacyCanary);
    },
  };
}

/** Chained once into the workspace API, behind its existing request-origin guard. */
export function createHomeRecoveryRoutes({ home, socketHub, localHandoff, legacyCanary = REBRAND_SWITCH }: {
  home: Home; socketHub?: SocketHub | undefined; localHandoff: () => boolean; legacyCanary?: boolean | undefined;
}) {
  const snapshot = () => getHomeRecovery(home, legacyCanary);
  socketHub?.registerTopic(HOME_RECOVERY_TOPIC, createHomeRecoveryPublisher(home, legacyCanary), { loopbackReadable: false });
  return new Hono()
    .get('/home/recovery', (c) => c.json(snapshot(), 200))
    .use('/home/recovery/*', async (c, next) => {
      if (!localHandoff()) return c.json({ error: 'Home recovery actions require a local cockpit.' }, 403);
      return next();
    })
    .use('/home/recovery/*', async (c, next) => {
      // Grant files are host-CLI-only, including in a local cockpit (remote-settings.ts).
      const body: unknown = await c.req.json().catch(() => undefined);
      if (body && typeof body === 'object' && 'file' in body && typeof body.file === 'string'
        && body.file.startsWith('remote-settings/')) return c.json({ error: 'Remote settings grants require the host CLI.' }, 403);
      return next();
    })
    .post('/home/recovery/restore', jsonZodValidator(homeRecoveryActionSchema), (c) =>
      respondRecovery(c, snapshot, () => restoreHomeRecovery(home, c.req.valid('json').file, c.req.valid('json').detectedAt)))
    .post('/home/recovery/import', jsonZodValidator(homeRecoveryActionSchema), (c) =>
      respondRecovery(c, snapshot, () => importHomeRecovery(home, c.req.valid('json').file, c.req.valid('json').detectedAt, legacyCanary)))
    .post('/home/recovery/accept', jsonZodValidator(homeRecoveryActionSchema), (c) =>
      respondRecovery(c, snapshot, () => acceptHomeRecovery(home, c.req.valid('json').file, c.req.valid('json').detectedAt, legacyCanary)));
}

async function respondRecovery(c: Context, snapshot: () => ReturnType<typeof getHomeRecovery>, action: () => void | Promise<void>) {
  try {
    await action();
    return c.json(snapshot(), 200);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
  }
}
