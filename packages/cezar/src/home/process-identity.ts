import { processStartToken } from '../core/process-stat.ts';

let identity: { token: string | undefined } | undefined;

/** A process never changes its start identity. Cache absence too, without IO at import time. */
export function ownProcessStartToken(): string | undefined {
  identity ??= { token: processStartToken(process.pid) };
  return identity.token;
}
