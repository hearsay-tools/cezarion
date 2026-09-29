# quick-list group age: reproduction

Spec: `quick-list.e2e.ts`, "puts the shared reference on the group row's line 2".

The fixture's `now` is fixed at module load; the row renders its age against the live clock.
A shard that starts the browser a couple of minutes after the module loads shows a larger age.
No CI failure bundle exists for this; it is a local reproduction, made 2026-09-29 by aging the
fixture clock (`const now = Date.now() - 120_000`), which is what a slow start does.

| Assertion | Result with a 2 minute stale fixture clock |
| --- | --- |
| old: `toBe('2 needs review · #425 · 9m')` | red: `Received: "2 needs review · #425 · 11m"` |
| new: 9m + elapsed minutes, ±1 | green (1 passed) |

With the unmodified clock both pass, so the new bound keeps pinning the age (a wrong value such as
`30m` still fails) without depending on wall-clock time.
