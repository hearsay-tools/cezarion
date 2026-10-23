import type { createApp } from './server.ts';

/**
 * Type-only HTTP route table inferred from chained versioned family builders. Loose
 * registrations discard accumulated route types. This module must introduce no runtime imports.
 */
export type AppType = ReturnType<typeof createApp>;
