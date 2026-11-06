# <Feature name>

## Goal

## Evidence

## Plan

## Case tables

For the changes below, the spec or plan must carry the applicable case table,
reviewed before implementation. Use one row per case, cover every required case,
show behavior at shipped defaults, and state impossible cases with their reason.

| Change | Table and columns | Required cases |
| --- | --- | --- |
| Adds or changes a cross-run relationship: messaging, delegation or settlement notification | **Both ends**, each state at each end: State · Send path behavior · Settlement path behavior | queued, running, waiting, Finish pending, stopping, review, done, failed, cancelled, deleted, history deletion pending, restart, other process owns it, unreadable record. |
| Adds or changes a run state | **Transitions out**, based on `RUN_EXITS` in `packages/cezar/src/runs/run-exits.ts` ([ADR 0056](../../docs/adr/0056-let-the-run-store-own-run-exits.md)); triggers in `packages/cezar/src/workflows/run-states.ts`: State · Trigger · Who or what fires it · Behavior at shipped defaults | Each non-final state; its automatic exits or recorded human-only reason (`packages/cezar/src/workflows/run-states.test.ts`). |
| Changes how a `ToolGrant` (`packages/cezar/src/core/agent-runner.ts`) maps onto a runner's tool flags | **Tool-list kinds**, one per affected runner: Case · Emitted runner flags · Callable built-in, MCP and extension tools at shipped defaults | Every case in `TOOL_GRANT_CASES` (`packages/cezar/src/core/tool-grant-parity-cells.testkit.ts`); its cells pin each case on each runner. Show effective tool access, not only the flags sent, and say when a runner ignores a restriction or cannot distinguish two cases. |
| Adds, replaces or removes files in a running task's worktree (`worktree-write-outside-manifest`) | **Worktree cases**: Case · Files written, kept or removed · Worktree state at the next step, Continue and restart | A catalog or source that has not loaded yet; the same name from two sources; records written by an older cezar version; a crash between two writes; the source removing the item. |
| Starts a process that outlives the command that started it (`detached-spawn-outside-helper`) | **Process exits**: Case · What stops it · Behavior at shipped defaults | The normal stop; the starting command interrupted by SIGINT or SIGKILL before and after the start; the handle the stop reads, such as a descriptor, deleted or forged. The helper's tests hold the rest: the leader exits first, a member ignores SIGTERM, zombies, an unreadable or reused start identity. |
| Restores saved client state for an entity | **State restore cases**: Path or trigger · Restored value · Displayed value | Reopen without a selection; switch between two restored entities; entity unavailable after restore; derived display differs from saved state (e.g. provider mask). Derive from one state; never mask in a provider. |


The phase tables in [the unified-waits spec](2026-10-17-unified-waits.md#transitions-out-phase-2a)
show the form. The tables make cases explicit; they do not decide which cases share a policy.
