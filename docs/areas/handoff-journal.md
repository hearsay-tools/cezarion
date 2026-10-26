# Task handoff journal

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/handoff.ts`, then its reader `packages/cezar/src/server/forge/github.ts`

## Rules

A per-task journal at `.ai/cezar/runs/<runId>.handoff.md` (spec 007, `.ai/specs/007-handoff-file-todos.md`), outside the worktree so it survives worktree removal. `seedHandoffFile` writes the skeleton. The agent finds the file through `CEZ_HANDOFF_FILE` and the `HANDOFF_ONLY_INSTRUCTIONS` system-prompt fragment, and keeps `## Progress log` (newest at the top) and `## Resume notes`.

**The file belongs to the agent; cezar writes no line of its own into it.** `buildPrBody` (`server/forge/github.ts`) and the Tasks-row preview (`packages/web/src/lib/task-preview.ts`) read the first lines of `## Progress log` as the agent's own summary. cezar touches the file in three places only, and two ast-grep rules (`.ai/ast-grep/rules/handoff-write-outside-writers.yml`, `handoff-written-outside-handoff-module.yml`) refuse a fourth:

- `seedHandoffFile` writes the skeleton once, for a file that does not exist yet.
- `writeHandoffRecords` rewrites cezar's records block whole: the lines from the `<!-- cezar:records … -->` marker line through `<!-- /cezar:records -->`, right before the seeded `## Goal`. Marker and header lookups match whole lines only, through `exactLineIndex` from `packages/contract/src/handoff.ts` (hearsay-tools/cezarion#1147).
- `deleteHandoff` and the store's purge remove the file with the run.

**cezar's records live in the run store, not the file** (hearsay-tools/cezarion#1809). `RunRecord.handoffRecords` holds the autosave reports, newest first, at most `HANDOFF_AUTOSAVE_RECORDS_MAX`. `recordHandoffAutosave` and `recordHandoffPeriodicAutosave` commit them through `RunStore.updateRun`, which commits a `handoffRecords` patch at once, and only then render the block. So the file never shows a record a crash would lose, and an agent that rewrites the file or edits a line cannot lose a record or restart a periodic count. Every session launch (`sessionContextFor`) calls `refreshHandoffRecords` before it reads the file, and `GET /runs/:id/handoff` renders the block from the store, so both show the store's records even after an agent edit or a crash between the commit and the render.

**cezar writes no lifecycle line.** Until hearsay-tools/cezarion#1809 cezar wrote a heartbeat (`turn complete — status=…`, `step "…" complete — …`, `session idle-closed — …`) at the top of the Progress log after every turn, the guarantee of spec 007 that "the handoff stays current when the agent writes nothing". The run event log's lifecycle events and the run status now carry those facts. A journal from an older run keeps its heartbeat lines and its `## Autosave (cezar)` section as they are; the preview still hides the old lines. The first design of hearsay-tools/cezarion#1004 wrote the autosave report at the top of the Progress log, and only CI's cockpit E2E caught it.
