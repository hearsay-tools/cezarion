# One module decides what a route may do with a run's checkout

A cockpit route that touches a run's checkout asks one **run checkout module**,
`server/run-checkout.ts`, once. The route names a **checkout intent**: `read`, `mutate`,
`publish`, `remove` or `open`. The module looks the run up, runs the checks that intent
requires in a fixed order, takes the intent's claim, and returns either a refusal (a literal
status and an `{ error }` body) or a handle (the run, the directory to use, and for `publish`
and `remove` the claim's release). The handler answers a refusal with `c.json(body, status)`.
It calls the release in `finally`, after all of its async work. The module holds no route.

Before this record, 14 handlers in `server/server.ts` each chose a directory and a guard set by
hand: 22 direct guard calls, five rules for a directory to read, write or open and three more to
publish or remove, three answers for a run with no checkout (409, 400, 200), and an
autosave-cleanup guard on 4 of the 14 handlers, added route by route
(hearsay-tools/cezarion#944). One claim refused with two wordings. Seven same-file clone pairs
sat between the handlers, and every guard test booted the whole app.

## Consequences

The module checks and claims in one synchronous step (ADR 0032): no `await` between the record
read and the claim. It calls `RunManager.claimForPublish` and `claimWorktreeReclaim`; the claims
stay facade methods, and tests that spy on them still see every call (ADR 0053). The run claim
does not replace the worktree mutation lock (ADR 0003).

A read never refuses a foreign owner (ADR 0006) and never rebuilds a reclaimed worktree
(ADR 0009). Only `publish` rebuilds one, under its claim. Artifact routes read the data
directory and stay outside the module (ADR 0043). Each handler keeps a literal `c.json` call
for every answer, so `AppType` keeps every route's response union (ADR 0016).

`adoptFallbackControl`, `requireRunControl` and `protectFallbackRun` stay in front of the
handlers. The extraction keeps every status code, refusal text, extra field and check order.
Where routes disagree today, the module takes a named per-route option. A behavior change
deletes its option in its own pull request, with a red test first. One such change is fixed
here: `git/commit` and `git/push` refuse a run whose `status` is `running`, and still accept
`queued` and `waiting` runs.

ADR 0002 (the text `/diff` stays a protected surface), ADR 0003, ADR 0006, ADR 0009, ADR 0016,
ADR 0032, ADR 0043 and ADR 0053 still hold.

Implementation: [2026-11-10-run-checkout-module.md](../../.ai/specs/2026-11-10-run-checkout-module.md),
`packages/cezar/src/server/run-checkout.ts` (created by the spec's slices),
[server.ts](../../packages/cezar/src/server/server.ts),
[open-in-targets.ts](../../packages/cezar/src/server/open-in-targets.ts),
[maintenance-claims.ts](../../packages/cezar/src/workflows/run/maintenance-claims.ts).

Coverage: `packages/cezar/src/server/run-checkout.test.ts` (created by the spec's slices; it
boots no app), [worktrees-api.test.ts](../../packages/cezar/src/server/worktrees-api.test.ts),
[git-changes.test.ts](../../packages/cezar/src/server/git-changes.test.ts),
[run-ownership-controls.test.ts](../../packages/cezar/src/server/run-ownership-controls.test.ts),
[fallback-run-controls.test.ts](../../packages/cezar/src/server/fallback-run-controls.test.ts).
