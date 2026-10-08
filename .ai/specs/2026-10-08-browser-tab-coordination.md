# Browser tab coordination

Shipped by the implementation for [hearsay-tools/cezarion#924](https://github.com/hearsay-tools/cezarion/issues/924).

The default HTTP/1.1 listener must serve ten cockpit tabs without permanent event
streams occupying Chrome's six ordinary connections. Local, authenticated bootstrap
selects one same-origin module SharedWorker (`/live-worker.js`, protocol `cezar-live-v1`).
Each document keeps its own QueryClient, initial requests, mutations and transcript
cursor; the worker shares only demanded wire traffic.

## Bounds and lifetime

- A coordination group holds at most one workspace SSE, one multiplexed task SSE and
  one ordinary topic WebSocket. Preview remains its separate binary channel.
- Visible documents renew demand every five seconds. A document which crashes or
  stops renewing loses its lease after 15 seconds of worker execution. Hidden,
  pagehide and frozen documents release demand immediately; restored documents
  authenticate a fresh health bootstrap, reconcile active scopes and rehydrate history/context before accepting shared delivery. Failed restoration remains closed and retries with bounded backoff.
- Last demand closes transports and aborts reads. The topic socket retains its
  existing one-second StrictMode grace. No invisible document owns another's work.
- Worker-port liveness and stream liveness are separate. Documents switch a silent
  worker to finite recovery within 15 seconds; the worker reopens a feed silent for
  40 seconds even if ports still renew. The topic socket retains its heartbeat watchdog.
- Server generation changes, incompatible worker protocols, expired cursors and
  bounded-buffer resets cause authoritative recovery. Authentication rejection
  removes shared demand and falls back to document-authenticated HTTP.

## HTTP and replay

`POST /api/v1/workspace/run-events` carries up to 32 distinct project/run demands in
one SSE stream. `POST /api/v1/workspace/run-event-batches` returns finite replay
prefixes, each capped at 256 events and 1 MiB. Contracts and request validation live
in `packages/contract`; both endpoints are workspace-only chained Hono routes.
The boot alias and canonical project ID cannot request the same run twice.

Replay attaches the store listener before reading persisted NDJSON. Plain and Brotli
history are read incrementally. Each task has its own ordering/high-water mark;
sequence gaps are legitimate. A missing task produces a scoped error while healthy
tasks continue. Abort, task deletion and project-store closure detach listeners and
cancel replay. Slow subscribers reset instead of retaining unbounded live queues. The complete UTF-8 SSE envelope, including framing, is capped at 1 MiB; an individually oversized event produces a scoped 413 reset instead of an endless reconnect.

Document cursors acknowledge only their own accepted prefix. Late subscribers restart
the union at the oldest demanded cursor and other readers deduplicate overlap.
Oversized records and stale cursors rehydrate through the existing paginated history
and context APIs. The legacy per-run SSE route retains its full replay and large-record
behavior; the new finite limit does not restrict existing clients.

## Finite fallback

Remote mode, absent/blocked workers, protocol mismatch and failed workers use no
persistent SSE or ordinary WebSocket. Task batches run on a two-second visible
cadence, workspace reconciliation on five seconds, with one finite cycle per document
and a ten-second abort deadline that also cancels reset/history hydration. Errors back off up to 30 seconds. Backlog drains in
small yielded batches. Browser/OS suspension can delay all timing guarantees; native
resume and online events restart reconciliation.

Recurring Changes, Commits, runs-index, skill-update and GitHub reads use an explicit
allowlist. Local duplicate views share each path at the fastest demanded existing
cadence. Initial reads remain local. Fallback preserves each cadence; GitHub lists
are not accelerated to the five-second workspace schedule. Mutations remain local
and invalidate shared reads. Automation state/log reads and the bounded
`GET /api/v1/projects/checkout/:checkoutId/progress` recovery cover transient consumers.

Remote fallback trades connection safety for up to two seconds of task latency and
five seconds of workspace latency, plus request/backoff time. Ephemeral intermediate
deltas coalesce into full active-item snapshots in finite batches, so unfinished text
and tool output remain visible. The store retains at most 256 active items / 4 MiB of serialized snapshots,
with a 1 MiB per-item cap, after credential redaction. Snapshots share the persisted
sequence clock and merge into bounded replay prefixes; no raw deltas reach disk.
Completion/session end, run deletion and store closure release their retained items.
Eviction drops whole items (never a partial suffix); subsequent full snapshots can
reseed them, and persisted content is always recovered. As with an SSE reconnect,
process restart or eviction can lose intermediate ephemeral content. Simultaneously visible remote tabs still duplicate finite reads. Caches,
rendering and memory are deliberately document-local.

## Preview

Hidden preview panes close their socket, timers and frame work. A decoded bitmap
finishing after suspension is released without drawing. Each pane supplies an opaque
viewer ID. Automatic resume may retain that viewer's session but may not take a session
claimed by another tab, even if the newer tab has since detached. Explicit “Use it
here” can claim it. Visibility never replenishes blocked-proxy retry budgets.

## Verification and provenance

`tab-coordination.e2e.ts` observes page and SharedWorker Network domains in one Chrome
profile over real HTTP/1.1. It covers mixed tabs, ten native visible windows, task/project
isolation, late join, owner loss, finite fallback, remote Basic Auth, freeze/resume and
server connection loss. Unit tests cover protocol/epochs, leases, independent feed
watchdogs, cancellation, replay races, bounded prefixes, project removal and preview
ownership. `live-preview.e2e.ts` exercises real frames and competing viewers.

The [performance report](../../docs/performance/browser-tab-coordination.md) records
reproduction commands, measurements and limitations. No runtime dependency,
configuration or environment flag was added. The upstream ledger check found no direct
equivalent; adjacent [open-mercato/cezar#986](https://github.com/open-mercato/cezar/pull/986)
informed the independent workspace watchdog. No ledger decision or upstream code was
imported.
