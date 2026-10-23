# Read forge state in bounded shared batches

The forge is authoritative for remote objects, but it does not push updates to this local
cockpit. Keep open lists light and hydrate expensive counts and checks on demand in batches.
Cross-state search is a separate path, with exact-number lookup before text search. Do not
widen every hot list just to serve occasional historical queries.

## Consequences

Reference batches ask `issueOrPullRequest`, then use the returned kind. Usable partial
GraphQL data survives a failed subprocess; an unresolved repository remains a real error.
Status answers identify whose action is pending. Merge conflict is an independent axis, so a
ready PR can still show a conflict. Review dates and actual branch work inform review freshness.

The server owns cache cadence and returns the next recheck delay. Known mutations invalidate
rather than invent a final status. The browser remembers per-reference last-known values across
batch changes and within the tab’s session, labels stale answers, and replaces them with the
next authoritative response.

## Considered Options

- **Add merge conflict to the single status ranking.** Rejected because it can coexist with any action status.
- **Discard a whole batch on any GraphQL error.** Rejected when usable repository data still contains successful aliases.

Implementation: [github.ts](../../packages/cezar/src/server/forge/github.ts), [github.ts](../../packages/contract/src/github.ts), [queries.ts](../../packages/web/src/api/queries.ts).

Coverage: [github-ref-status-api.test.ts](../../packages/cezar/src/server/github-ref-status-api.test.ts), [github-search-api.test.ts](../../packages/cezar/src/server/github-search-api.test.ts).
