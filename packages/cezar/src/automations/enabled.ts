import { productEnv } from '../core/product-env.ts';

/** Automations are on unless the value is exactly `0` (spec 2026-10-02-scheduled-automations). */
export function automationsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return productEnv('AUTOMATIONS', env) !== '0';
}
