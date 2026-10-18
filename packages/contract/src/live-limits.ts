/**
 * Bounds of one live-runs batch, shared by the route and the cockpit's reader.
 *
 * No runtime import, so a consumer of these loads no schema (hearsay-tools/cezarion#1237).
 */

export const LIVE_RUN_LIMIT = 32;
export const LIVE_EVENT_LIMIT = 256;
export const LIVE_BYTE_LIMIT = 1024 * 1024;
