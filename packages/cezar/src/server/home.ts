import type { Home } from '../home/home.ts';
import { resolveHome } from '../home/resolve.ts';

/** Embedded server callers resolve once; CLI callers keep their injected object. */
export function withServerHome<T extends { home?: Home }>(deps: T): T & { home: Home } {
  return { ...deps, home: deps.home ?? resolveHome({ purpose: 'server' }) };
}
