import { reportsIndex } from '../artifacts/reports-index.ts';
import { Hono } from 'hono';
import { reportsQuerySchema } from '@open-mercato/cezar-contract/reports';
import type { ProjectApiEnv } from './server.ts';
import { queryZodValidator } from './validators.ts';

export const reportsRoutes = new Hono<ProjectApiEnv>()
  .get('/reports/state', c => {
    const store = c.get('project').store;
    if (store.unavailable) return c.json({ error: store.unavailable.message }, 409);
    reportsIndex(store).markRead();
    return c.json(reportsIndex(store).state());
  })
  .get('/reports', queryZodValidator(reportsQuerySchema), async c => {
    const store = c.get('project').store;
    if (store.unavailable) return c.json({ error: store.unavailable.message }, 409);
    const page = await reportsIndex(store).list(c.req.valid('query'));
    if ('error' in page) return c.json(page, 400);
    return c.json(page);
  });
