import { Hono } from 'hono';
import { homeRecoveryActionSchema } from '@open-mercato/cezar-contract/home-recovery';
import type { Home } from '../home/home.ts';
import { acceptHomeRecovery, getHomeRecovery, restoreHomeRecovery, subscribeHomeRecovery } from '../home/recovery.ts';
import { jsonZodValidator } from './validators.ts';
import type { SocketHub, TopicPublisher } from './ws.ts';

export const HOME_RECOVERY_TOPIC = 'home:recovery';

/** Watching and inspection live in HomeStore's recovery service, only while demand exists. */
export function createHomeRecoveryPublisher(home: Home): TopicPublisher {
  return {
    snapshot: async () => getHomeRecovery(home),
    start(publish) {
      let previous = JSON.stringify(getHomeRecovery(home));
      return subscribeHomeRecovery(home, () => {
        const snapshot = getHomeRecovery(home);
        const serialized = JSON.stringify(snapshot);
        if (serialized === previous) return;
        previous = serialized;
        publish(snapshot);
      });
    },
  };
}

/** Chained once into the workspace API, behind its existing request-origin guard. */
export function createHomeRecoveryRoutes({ home, socketHub }: { home: Home; socketHub?: SocketHub | undefined }) {
  socketHub?.registerTopic(HOME_RECOVERY_TOPIC, createHomeRecoveryPublisher(home), { loopbackReadable: false });
  return new Hono()
    .get('/home/recovery', (c) => c.json(getHomeRecovery(home), 200))
    .post('/home/recovery/restore', jsonZodValidator(homeRecoveryActionSchema), async (c) => {
      try {
        await restoreHomeRecovery(home, c.req.valid('json').file);
        return c.json(getHomeRecovery(home), 200);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
      }
    })
    .post('/home/recovery/accept', jsonZodValidator(homeRecoveryActionSchema), (c) => {
      try {
        acceptHomeRecovery(home, c.req.valid('json').file);
        return c.json(getHomeRecovery(home), 200);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
      }
    });
}
