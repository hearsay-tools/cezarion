# Keep snapshots authoritative over live events

Streams provide immediate updates; HTTP snapshots define the run list and detail truth.
Patch only caches already fetched and reconcile after reconnect or visibility restoration.
A stream that began after some runs existed cannot construct a complete list.

## Consequences

Persist meaningful item snapshots and usage changes while coalescing raw deltas onto the live
wire only. Both event generations share sequence allocation, so gaps in replay are normal.
Clients deduplicate by a sequence high-water mark rather than treating every gap as loss.
Images persist through the file pipeline instead of embedding raw base64 in event history.

CPU and memory samples stay in a small external live store, outside durable records and the
query cache, so telemetry ticks update only subscribers. External forge state and cold indexes
retain their explicit reconciliation backstops; the stream does not make external state local.

## Considered Options

- **Build list caches from arriving stream rows.** Rejected because that produces only the subset observed since connection.
- **Persist every streamed text delta.** Rejected in favor of final snapshots and live coalescing to bound replay and write work.

Implementation: [events.ts](../../packages/web/src/api/events.ts), [ui-event-sink.ts](../../packages/cezar/src/runs/ui-event-sink.ts), [run-events.ts](../../packages/web/src/api/run-events.ts).

Coverage: [ui-event-sink.test.ts](../../packages/cezar/src/runs/ui-event-sink.test.ts), [events.test.ts](../../packages/web/src/api/events.test.ts), [run-events.test.ts](../../packages/web/src/api/run-events.test.ts).
