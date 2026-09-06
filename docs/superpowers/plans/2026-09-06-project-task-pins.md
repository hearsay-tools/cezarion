# Project task pins implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Port upstream `44a8dbba` for persistent per-project pins while preserving fork behavior.

**Architecture:** Keep optional pin metadata in each project RunStore, expose a contract-validated chained route, and reuse existing run SSE/cache reconciliation. Sort pins ahead of ordinary status ordering and let existing visible-variant collapsing promote the entire group once. Add pin controls to the existing project list, table, mobile card and thread actions.

**Tech Stack:** TypeScript, Zod, Hono, React, TanStack Query, Tailwind, Vitest, agent-browser.

**Spec:** Parent-approved concrete design in #93 task conversation on 2026-09-06; requirements and clarification at https://github.com/wjarka/cezar/issues/93.

## Global constraints

- Fresh fork baseline `064a2f00`; selective port only, preserve package identity/version and unrelated fork changes.
- No lifecycle or scheduling changes; preserve monitoring, unread/attention counts, attachments and repository references.
- Optional `pinned`/`pinnedAt` without defaults; absence means unpinned. Unpin/archive delete both, unarchive never restores; ignore archived pin attempts and clear stale metadata.
- Visible group members retain variant order and independent flags; each group appears once. Pinned buckets spend no recent row budget.
- Contract-owned request/path schemas, inferred types, chained boot/scoped route, existing run SSE.
- Keyboard/pressed state, 44px phone targets, themes/reduced motion, explicit failure/retry feedback; no artwork needed.

## 1. Persistence and API

Files: `packages/cezar/src/runs/store.ts`, `packages/contract/src/runs.ts`, `packages/cezar/src/server/server.ts`; adjacent store/request-validation/route-parity/contract-parity/typed-bodies tests; `BACKWARD_COMPATIBILITY.md`.

Interface: `setPinned(id: string, pinned: boolean): RunRecord | undefined`; `POST /api/v1[/p/:projectId]/runs/:id/pin`, absent body means pin, `{pinned:false}` means unpin, updated RunRecord or 404; body and path validated by middleware.

- [x] Run baseline unit suite, import upstream tests first and confirm missing pin behavior fails.
- [x] Apply upstream implementation hunks; resolve docs against fork history. Move pin body schema into contract and use existing run-id param schema.
- [x] Add archived pin regression: `store.setArchived(id, true); store.setPinned(id, true); expect(store.getRun(id)).not.toHaveProperty('pinned')`; flush/reload and assert both fields absent. Implement `if (pinned && !run.archived)` with `clearPin` otherwise.
- [x] Verify old records, pin round trip, unpin deletion, single/bulk archive, unknown/wrong-typed requests, identical run IDs in separate projects, boot/scoped aliases, typed body rejection and route inventory.

## 2. Grouping and controls

Files: `packages/web/src/lib/task-groups.ts`, `components/pin-toggle.tsx`, `components/task-quick-list.tsx`, `components/project-groups.tsx`, `routes/tasks-overview.tsx`, `routes/task-thread/run-actions.ts`, `routes/task-thread/run-header.tsx`, `api/client.ts`, `api/queries.ts`, `styles/index.css`; adjacent tests.

Interfaces: `usePinRun(projectId?, cacheScope?)`; `PinToggle({pinned,onToggle,className})`; `Pinned` bucket before ordinary buckets.

- [x] Import upstream grouping/component tests before implementation; confirm red.
- [x] Apply pin-only upstream hunks. Preserve existing ordering within ranks, variant A/B/C member order, status dots/counts, scope and cache identities.
- [x] Extend grouping tests with one archived pinned sibling, multiple active pins in one group, lone visible survivor, pinned group plus ten ordinary rows, unchanged sibling flags and unread/attention counts.
- [x] Give shared pin buttons 44px phone/no-hover targets, preserve focus reveal and pressed-state semantics, and explicit reduced-motion classes.
- [x] Retain authoritative state until mutation success. Failure explains that pin update failed and asks user to retry; test failure then retry on real query/components with network boundary mocked.

## 3. Verification and delivery

- [x] Prove new regression tests fail against source-only reverted implementation; restore and run focused tests.
- [x] Run `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package` in order; diagnose and fix failures.
- [x] Exercise built app with agent-browser using scratch state: reload/restart, scoped pins, group expansion, row caps, archive/unarchive, failure/retry, keyboard, 360x640 and desktop, light/dark/reduced-motion. Record acceptance results in `.ai/qa/2026-09-06-project-task-pins.md`.
- [ ] Review diff for preserved fork features and no lifecycle changes, commit conventional feature change, push and open draft PR closing #93 with verification/experience evidence.
- [ ] Move board to In review; use pr-checks to monitor CI and inline feedback and fix actionable findings. Keep draft for parent merge.
