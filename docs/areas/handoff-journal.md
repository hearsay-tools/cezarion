# Task handoff journal

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/handoff.ts`, then the two readers' files `packages/cezar/src/server/server.ts` and `packages/cezar/src/server/forge/github.ts`

## Rules

A per-task journal at `.ai/cezar/runs/<runId>.handoff.md` (spec 007, `.ai/specs/007-handoff-file-todos.md`), outside the worktree so it survives worktree removal. `seedHandoffFile` writes the skeleton. The agent finds the file through `CEZ_HANDOFF_FILE` and the `HANDOFF_ONLY_INSTRUCTIONS` system-prompt fragment, and keeps `## Progress log` (newest at the top) and `## Resume notes`.

**The top of `## Progress log` belongs to the agent.** Two features read its first lines as the agent's own summary: `handoffProgressExcerpt` (`handoff.ts`) feeds the variants compare column (`handoffExcerpt` in the `GET /groups/:groupId` route of `server/server.ts`, spec 010), and `buildPrBody` (`server/forge/github.ts`) writes the body of a draft PR opened from the cockpit (Goal plus the first lines of the Progress log). **cezar writes its own records to a cezar-owned section, never the Progress log**, as `## Autosave (cezar)` does since hearsay-tools/cezarion#1111: `appendHandoffAutosaveReport` and `recordHandoffPeriodicAutosave` write there, and the first report creates the section right before `## Progress log`. One exception exists on purpose: `appendHandoffHeartbeat`'s lifecycle lines (`turn complete — …` and `step "…" complete — …` from `workflows/run.ts`, plus `picked from N variants` in `server.ts`) go to the top of the Progress log as the fallback that keeps the journal current when the agent writes nothing. `handoffProgressExcerpt` skips the lifecycle lines (and `session idle-closed — …`) whenever the agent wrote a line of its own, because the no-wait nudge's extra turn writes more of them (hearsay-tools/cezarion#1234). A new cezar record does not join them. The first design of hearsay-tools/cezarion#1004 wrote the autosave report at the top of the Progress log, and only CI's cockpit E2E (`variants-compare.e2e.ts`) caught it.
