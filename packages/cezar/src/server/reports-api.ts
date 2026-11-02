import { Hono } from 'hono';
import { reportsQuerySchema } from '@open-mercato/cezar-contract/reports';
import type { ProjectApiEnv } from './server.ts';
import { queryZodValidator } from './validators.ts';

export const reportsRoutes = new Hono<ProjectApiEnv>()
  .get('/reports', queryZodValidator(reportsQuerySchema), async c => {
    const page = await c.get('project').store.reports.list(c.req.valid('query'));
    if ('error' in page) return c.json(page, 400);
    return c.json(page);
  });
