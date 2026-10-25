# Task handoff journal

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/handoff.ts`, then its reader `packages/cezar/src/server/forge/github.ts`

## Rules

A per-task journal at `.ai/cezar/runs/<runId>.handoff.md` (spec 007, `.ai/specs/007-handoff-file-todos.md`), outside the worktree so it survives worktree removal. `seedHandoffFile` writes the skeleton. The agent finds the file through `CEZ_HANDOFF_FILE` and the `HANDOFF_ONLY_INSTRUCTIONS` system-prompt fragment, and keeps `## Progress log` (newest at the top) and `## Resume notes`.

**The top of `## Progress log` belongs to the agent.** `buildPrBody` (`server/forge/github.ts`) reads its first lines as the agent's own summary when it writes the body of a draft PR opened from the cockpit (Goal plus the first lines of the Progress log). **cezar writes its own records to a cezar-owned section, never the Progress log**, as `## Autosave (cezar)` does since hearsay-tools/cezarion#1111: `appendHandoffAutosaveReport` and `recordHandoffPeriodicAutosave` write there, and the first report creates the section right before `## Progress log`. One exception exists on purpose: `appendHandoffHeartbeat`'s lifecycle lines (`turn complete — …`, `step "…" complete — …` and `session idle-closed — …` from `workflows/run.ts`) go to the top of the Progress log as the fallback that keeps the journal current when the agent writes nothing. A new cezar record does not join them. The first design of hearsay-tools/cezarion#1004 wrote the autosave report at the top of the Progress log, and only CI's cockpit E2E caught it.
