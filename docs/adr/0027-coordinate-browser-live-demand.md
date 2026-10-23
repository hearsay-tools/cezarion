# Coordinate live demand across browser documents

Visible local documents share a SharedWorker owner for workspace SSE, multiplexed task SSE,
topic WebSocket subscriptions and recurring reads. Each document retains its own cursor and
recovery state. Leases expire dead documents; subscriber byte and task limits bound retained
work. Publishers start on first demand and stop after the last subscriber leaves.

## Consequences

Hidden documents release demand. Authentication failure, remote mode, a different service
base or an unavailable worker uses finite authenticated HTTP reads with backoff. It does not
open a permanent stream in every tab. Epochs and server generations reject stale delivery and
trigger authoritative hydration after restart.

The preview is a deliberate separate socket per open viewer. It carries binary frames and
input for one task, including remote mode, with bounded connection attempts. It does not share
the small-topic subscription bus. The older one-socket-per-tab description no longer states
the browser ownership model.

Implementation: [live-coordinator.ts](../../packages/web/src/api/live-coordinator.ts), [live-owner.ts](../../packages/web/src/api/live-owner.ts), [live-fallback.ts](../../packages/web/src/api/live-fallback.ts), [ws.ts](../../packages/cezar/src/server/ws.ts), [preview-socket.ts](../../packages/web/src/api/preview-socket.ts).

Coverage: [live-owner.test.ts](../../packages/web/src/api/live-owner.test.ts), [live-coordinator.test.ts](../../packages/web/src/api/live-coordinator.test.ts), [live-fallback.test.ts](../../packages/web/src/api/live-fallback.test.ts).
