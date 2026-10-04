# Reclaimable worker capacity (#816)

> Design record for #816. Approved 2026-10-04. Supersedes the limits paragraph of `2026-09-06-owned-workers-isolated-worktrees.md`.

Replaces the 32 lifetime worker creations per parent (spec
`2026-09-06-owned-workers-isolated-worktrees`, PR #138) with reclaimable
resource capacity plus a finite runaway ceiling.

## Problem

`authorizeSpawn` rejects `parent.delegation.receipts.length >= 32`. Receipts
survive destroy and history deletion (they carry exact-retry and ownership
evidence), so a parent that created 32 workers can never delegate again, even
after every worktree is verifiably removed. The contract bounds receipts,
results and relationship workers to 32, and the route and cockpit `.slice(0, 32)`
worker lists, so raising only the service cap would hide later workers.

## What the old cap was load-bearing for

1. A finite bound on how many workers one parent can ever create (runaway spawn
   loops). It was described as a cost/abuse bound.
2. A bound on payload size: receipts and results live on the parent run record,
   which `/runs` returns in full, and relationship responses.
3. Indirectly, a bound on concurrent owned worktrees per parent.

It was never a spending bound: one worker may Continue repeatedly, and destroy
cannot undo prior charges.

## Decision (approved 2026-10-04)

Two fixed limits, no configuration:

| Limit | Value | Bounds |
| --- | --- | --- |
| `WORKER_CAPACITY` | 32 outstanding allocations per parent | Disk/worktree resources and concurrent ownership |
| `WORKER_CREATION_LIMIT` | 1,024 creations per parent (matches the per-family message bound) | Runaway spawning and every receipt/result/relationship payload |

Neither is a spending budget. Spending stays bounded by workspace `maxParallel`
concurrency and a human stopping the parent. Recovery at the creation ceiling
is starting a new task. No human extension mechanism is added.

## Accounting

`packages/cezar/src/delegation/capacity.ts` owns both constants and a pure
`workerCapacity(parent, getRun)` returning `{ outstanding, limit, created,
creationLimit }`.

A receipt is **released** only when either holds:

- its worker record has `delegation.destroy.phase === 'complete'` and
  `remaining` is empty; or
- the receipt carries `deletion` (history deletion requires a verified complete
  destroy first, `RunStore.workerDeletionEvidence`).

Every other receipt is **outstanding**: accepted/queued, running, waiting,
settled, destroy `requested`/`terminating`/`cleaning`/`incomplete`, and a
receipt whose record is missing without a deletion marker (conservative).

Consequences:

- Release is derived from durable state, so it happens exactly once, survives
  restart and Continue, and needs no migration. A parent already holding 32
  legacy receipts spawns worker 33 as soon as one is verifiably destroyed.
- Provisioning failure: the worker record exists from acceptance; `destroy`
  treats already-absent resources as cleaned, so the slot is freed explicitly by
  destroy. Nothing frees a slot implicitly.
- Incomplete cleanup keeps its slot until a retry (explicit or the #642
  automatic retry) completes.

## Enforcement

- `authorizeSpawn` (`policy.ts`) checks the creation ceiling, then capacity,
  each with a distinct `capacity_limit` message naming the recovery:
  - capacity: `Parent has 32 outstanding workers (accepted, live, or not
    verifiably destroyed). Collect results, then destroy finished workers to free
    capacity; incomplete cleanup holds its slot until a retry completes`
  - ceiling: `Parent reached 1,024 worker creations; start a new task to
    delegate further`
- `RunStore.createOwnedRun` re-checks `workerCapacity` inside the receipt
  transaction (throws), so no path writes a receipt past either limit.
- Spawns stay serialized per parent; a concurrent destroy only releases.
- Exact-retry receipts resolve before either limit, unchanged.

## Contract

`packages/contract/src/delegation.ts`:

- root `receipts` and `results`: `.max(32)` → `.max(1_024)`.
- `runRelationshipsSchema.workers`: `.max(32)` → `.max(1_024)`; add
  `capacity: { outstanding, limit, created, creationLimit }` (non-negative ints).
- Wait `workerIds`/`revisions`/`outcomes` stay at 32: undestroyed workers never
  exceed 32, so a wait selection never needs more.

Records with ≤32 receipts parse unchanged; no migration.

## Surfaces

- **Relationships route** (`server.ts`): drop `.slice(0, 32)`; return every
  owned worker (bounded by the ceiling), plus `capacity` from `workerCapacity`.
- **Cockpit** (`run-relationships.tsx`): drop `.slice(0, 32)` in `workerIdsOf`;
  show `Capacity N of 32 in use` for root runs in both the header panel and the
  Workers activity section; at the limit, explain: `All 32 worker slots are in
  use. Clean up finished workers to free a slot.` Add a **Clean up** button per
  settled worker (`review`/`done`/`failed`/`cancelled`) without a complete
  destroy, calling the existing human `POST /runs/:id/worker-destroy` (its guard
  is unchanged) after an inline confirmation, because it removes the worktree
  and branch. A refusal is shown in the server's own words. Destroy checkpoints the result before removing anything; review
  gates are not accepted and nothing runs automatically. Incomplete results show
  the existing `Cleanup` state.
- **CLI / generated instructions** (`provision.ts`): replace "At most 32
  accepted workers, including destroyed workers" with the outstanding/creation
  wording and the destroy recovery; state the limits bound resources and runaway
  spawning, not spending.
- **Docs**: README worker paragraph, `.env.example` limit comment, and the
  limits paragraph of spec `2026-09-06` (pointer to this design; also copied to
  `.ai/specs/2026-10-04-reclaimable-worker-capacity.md`).

## Tests

Each regression proven red against the old cap (`git stash push -- <sources>`).

- `capacity.test.ts` / `policy.test.ts`: worker 33 after verified destroy,
  including a legacy parent with 32 receipts; queued, `cleaning`, `incomplete`
  and missing-record receipts hold slots; deleted receipts release; 1,024
  ceiling; exact retry at capacity still resolves.
- `service.test.ts`: concurrent spawns at 31 outstanding admit exactly one;
  repeated destroy releases once; destroy racing a spawn never exceeds 32.
- Store: `createOwnedRun` rejects a 33rd outstanding receipt when policy is
  bypassed.
- `runs/delegation-state.test.ts`: >32 receipts and results reload after
  restart; readiness still evaluates every historical worker.
- Contract parity / route: relationships returns all 33+ workers plus
  `capacity`.
- Cockpit unit: 33+ workers render, capacity line and exhaustion text, Clean up
  calls the route.

Runner lifecycle, input delivery and completion signalling are unchanged, so no
`RUNNER_IDS` parity cell is required.

## Out of scope

`maxParallel`; deleting retry/ownership evidence; automatic deletion of
uncollected work or accepting review gates.
