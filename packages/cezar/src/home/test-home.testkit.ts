import type { Home } from './home.ts';
import { resolveHome } from './resolve.ts';

/** Explicit Home for legacy test fixtures while their environment setup is migrated. */
export function testHome(env: NodeJS.ProcessEnv = process.env): Home {
  return resolveHome({ purpose: 'cli', env });
}
