# HTML report cards and the project Reports shelf

Epic: hearsay-tools/cezarion#2399. This spec covers the work after the shared
reader. It plans hearsay-tools/cezarion#2401 (report cards in conversations),
hearsay-tools/cezarion#2402 (project Reports shelf), and one small prerequisite
slice that both need.

## Status

| Phase | Items | State on `main` |
| --- | --- | --- |
| 1 | hearsay-tools/cezarion#2400 reader | Merged: PR hearsay-tools/cezarion#2407 (`7fac3b06b`), PR hearsay-tools/cezarion#2414 (`a0440272`). The `needs-qa` gate is still open: real mobile-app QA has not run. |
| 2 | S1 report metadata, then #2401 and #2402 in parallel | This spec |

What phase 1 gives the later slices (read `packages/web/src/routes/task-git/report-reader.tsx`):

- Route `/p/<project>/tasks/<run>/report?artifact=<id>` (or `?path=`). The URL is
  the one source of the selection.
- `ReportBar`, `ReportBody`, `State` and `HtmlReportFrame` are separate
  components. The route function `TaskReportRoute` owns the URL read, the
  non-HTML redirect to Files, the full-screen phone layout and Back
  (`useLeaveReader`, through `readerFrom`).
- `taskFileHref` (`task-thread/file-links.ts`) rewrites publication links
  (`…/files?artifact=<uuid>`) to the reader.
- Sanitizing, sandbox and CSP live in `lib/html-report.ts`. No later slice adds
  a second renderer or changes the isolation boundary.

## Shared decisions

| ID | Decision | Source |
| --- | --- | --- |
| D1 | A report's title is its HTML `<title>`, read from the first 64 KiB. Without one, it is the file name without the extension. | Owner, 2026-11-01 |
| D2 | A report is a published artifact whose name ends in `.html` or `.htm` (`isHtmlPath`). No arbitrary URL, local file name or remote link becomes a card or a shelf entry. | Issues hearsay-tools/cezarion#2401, hearsay-tools/cezarion#2402 |
| D3 | Every report opens in the phase 1 reader. Cards embed the reader component; the shelf navigates to the reader route. | Epic |
| D4 | Ownership: every read goes through a run in the request's project (`store.getRun(id)`), as artifact routes do today. A link to a run in another project keeps its original link and gets no card. | ADR 0043 |
| D5 | Owned worker tasks are tasks of the project. Their published reports count, with the worker task as the source task. | Planner (technical) |
| D6 | No new setting, flag, manifest or polling interval. The download route keeps `attachment`; the image route keeps refusing HTML. | Issues, ADR 0043, AGENTS.md § Zero config |

## Slice S1: report metadata (new sub-issue, prerequisite)

Work type: feature. Both later slices read the same fields, so one slice lands
them first.

- Contract (`packages/contract/src/artifacts.ts`): `publishedArtifactSchema`
  gains an optional `title` (string, at most 200 characters after whitespace
  collapse). Optional, so old records stay valid.
- Store (`packages/cezar/src/artifacts/store.ts`): one helper derives the title
  under D1 from the first 64 KiB of an HTML artifact. It decodes entities,
  drops control characters, collapses whitespace and truncates. It never runs
  or loads anything. A non-HTML artifact has no title.
- Route: `GET /runs/:id/artifacts/:artifactId/metadata`, chained into the runs
  family, validated by middleware. It returns `{ artifact }` from
  `metadata.json` plus the title. It does not return content. It answers 404
  for a missing or deleted artifact and for a run outside the project. It
  checks the content file's size against the metadata. It does not hash the
  content.
- Cockpit: `getArtifactMetadata` / `useArtifactMetadata(runId, artifactId)` and
  one display helper `reportTitle(artifact)` (title, else file name without the
  extension).
- Preserved: `GET /runs/:id/artifacts` and `GET /runs/:id/artifacts/:artifactId`
  keep their shapes and their checks, except for the new optional field.
- Checks: contract-parity and typed-body tests for the route; store unit tests
  for the title (none, entities, very long, script inside `<title>`, `<title>`
  after 64 KiB, malformed); a 404 test for a deleted artifact and a foreign
  project.

Behavior on `main` after S1 alone: no visible change.

## Slice #2401: report cards in conversations

Depends on S1 on `main`.

### Behavior

- Cards appear only in assistant messages (`AssistantMessage`,
  `task-thread/thread-items.tsx`). The handoff panel, Files previews, user
  messages and ask cards keep plain links.
- Card placement (owner, 2026-11-01): one card per distinct published report,
  after the message text. Inline links stay links and open the reader. A report
  referenced several times in one message gets one card.
- A card shows the report title (`reportTitle`), the type label `HTML report`
  and a `Read report` button (44 px minimum). It fetches only
  `useArtifactMetadata`. It never mounts `HtmlReportFrame` and never calls
  `useArtifact` before the user opens it.
- Metadata loading: the card shows the file name from the link text and a
  disabled-looking but working link. Metadata 404 or error: the card is
  replaced by the original link, which still opens the reader route. The
  answer text never disappears.
- Open, wide screen (≥ 1180 px): the reader opens in a side pane beside the
  conversation. Medium width (768–1179 px): the reader takes the main area with
  a `Conversation` step-back control. Phone (≤ 767 px): the reader is full
  screen with Back. These are the breakpoints of the existing preview split
  (`PREVIEW_DOCK_QUERY`, `PREVIEW_PHONE_QUERY`).
- The pane works at shipped defaults. The split that `PreviewSplit` uses today
  is generalized so that it does not depend on `CEZ_PREVIEW`. When the live
  preview is also enabled, the pane shows one surface at a time: opening a
  report shows the report; closing it returns the pane to its earlier preview
  state.
- Inside the pane, Back (or Close) closes the pane. It does not walk history.
- The reader extraction: `TaskReportRoute` becomes a thin route over a
  `ReportReader({ runId, selection, fragment, onBack, variant })` component.
  The route keeps its current behavior, which the phase 1 specs pin.

### Selection state

The task route's search parameter `report=<artifactId>` is the one source of
the open report. `card=<messageKey>` names the card that opened it
(`messageKey` is the message's stable row key). Opening pushes a history entry;
closing pops it, or replaces it when there is no entry to pop. Conversation
scroll uses the existing `thread-scroll` memory, keyed by run and view.

| Path or trigger | Restored value | Displayed value |
| --- | --- | --- |
| Open the task without `report` | none | Conversation only; no report request |
| `report` with an invalid or empty id | none | Conversation only; the parameter is dropped with a history replace |
| Open card A, then card B in the same task | `report=B`, `card=B's message` | Report B only; report A never shows during the switch |
| Switch to task 2 and come back with browser Back | `report` and `card` from the URL | Same report in the pane; Back then closes it and scrolls the card into view |
| Switch tasks through the sidebar | task 2's URL, no `report` | Task 2's conversation; no report from task 1 shows (pane keyed by run id) |
| Report deleted after restore | `report` id | The reader's "Report missing or deleted" state in the pane; the card falls back to the link |
| Display differs from saved state | artifact id | Title and type come from metadata, not from the URL |
| Close the reader | previous entry | The conversation at its earlier scroll position, with focus on the card's `Read report` button |
| Same report referenced in two messages | `card` names the opener | Back returns to the card that opened it |
| Message still streaming | — | A card can appear when the link completes; it does not move the reading position |

### Preserved guarantees

- Unopened cards fetch no content and run nothing (browser spec counts
  requests and frames).
- The reader route, its Back behavior and the Files preview stay as phase 1
  shipped them (`html-report-reader.e2e.ts`, `artifact-project-links.e2e.ts`).
- Copy as HTML of a message keeps a plain link for each card.
- The link-safety rule from phase 1 stays as it is.

### Checks

Unit: card states (loading, loaded, 404, error), card de-duplication, the
selection parse, the extraction's route parity. Browser: desktop pane at
1440 px; medium width; 360×640 phone in light and dark; keyboard open and
close; 44 px targets; theme contrast; no content request before Read; Back to
the same card after a task switch. Reader sweep: `Markdown` consumers,
`thread-items` copy, `PreviewSplit` users, preview specs, and specs asserting
the new copy (`Read report`, `HTML report`).

## Slice #2402: project Reports shelf

Depends on S1 on `main`. Independent of #2401.

### Index

Artifacts are files under `<dataDir>/runs/<runId>-artifacts/`, and the files
stay the source of truth (ADR 0043). A project listing must not read every
run's directory on each request. The slice adds a rebuildable index:

- `runs.db` gains a table `artifacts (id PRIMARY KEY, run_id, name, title,
  created_at, size)` with indexes on `(created_at DESC, id)` and `(run_id)`. It
  is a cache: deleting it, or the whole store, loses nothing. Schema version 10,
  forward-only, following `docs/areas/runs-store.md` and
  `BACKWARD_COMPATIBILITY.md`.
- Only HTML artifacts are indexed (D2).
- Backfill: when the table has no completed-backfill marker in `meta`, the
  server lists `<dataDir>/runs/` once and indexes each `*-artifacts` directory
  whose run still exists. It runs after the listener is up and never blocks
  boot.
- New publications: `cez artifact publish` runs in the agent process and does
  not open `runs.db`. Publishing needs an active task, so the server
  reconciles runs that were live since the last reconciliation. It reads only
  those runs' artifact directories. It runs before a shelf query and when a
  run settles. The plan for this slice names the exact trigger and its tests.
- Deletion: task-history deletion removes the run's index rows in the same
  commit that deletes the run. A listing also drops a row whose content file is
  missing and reports it as missing (it does not hide an error as "empty").
- Worktree removal and archiving do not change the index.

### Route

`GET /reports?q=&before=&limit=` (project-scoped, chained, middleware
validated) returns `{ reports, nextCursor, total }`. Each entry has the
artifact id, run id, title (`reportTitle` rules), file name, published time,
size, and the source task's title and status. It is newest first, with an
opaque cursor, as `GET /run-summaries/archived` does. Search matches the report
title and file name, and the source task through `matchesRunSearch` (no second
field list). It never returns another project's rows.

### Cockpit

- Route `/p/<project>/reports`, with `q` in the URL. It is listed in
  `PAGE_TITLE_ROUTES`.
- Navigation (owner, 2026-11-01): Reports goes in More, beside Workflows: the
  sidebar overflow menu and the phone More sheet. No primary tab moves.
- Rows show the title, the source task (a link to the task) and the published
  date. Tapping a row navigates to the reader route with `readerFrom` set to
  the shelf, so Back returns to the shelf.
- Live updates use the existing workspace `run` and `run-deleted` events
  (debounced refetch) and `refetchOnWindowFocus`. No interval.
- States: loading; empty project ("No published reports yet", with a short
  line on `cez artifact publish`); no search match (with Clear search); error
  (with Retry); a missing entry (the reader's missing state, with a link back).

### Selection state

| Path or trigger | Restored value | Displayed value |
| --- | --- | --- |
| Open Reports without `q` | none | Newest reports first, scroll at the top |
| Open Reports with `q` | `q` from the URL | Matching reports; the search box shows `q` |
| Open a report, then Back | the shelf entry | Same `q`, same scroll position, focus on the row |
| Switch projects | the other project's `/reports` | Only that project's reports; no row from the first project shows |
| Report deleted after the list loaded | the row | Opening it shows the reader's missing state; the next refetch drops the row |
| Task history deleted | — | `run-deleted` refetch drops its rows |
| Display differs from saved state | `q` | Titles and task names come from the server, not the URL |
| Two reports with the same name | — | Both rows, told apart by source task and date |

### Checks

Server: index backfill, reconcile after a publish, history deletion, missing
content, foreign project, archived and terminal runs listed, paging and search,
contract parity and typed bodies. Cockpit unit: states and URL search.
Browser: list, search, open and Back with position, source-task link, empty
project, 360×640 light and dark, keyboard, 44 px targets. Reader sweep: nav
items, the sidebar tab-fit specs (`github-sidebar`, `smoke`,
`project-sidebar`, `mobile-tab-bar`, `automations`), ⌘K Views, and every spec
asserting nav labels.

## Schedule

| Order | Item | Release condition for dependents |
| --- | --- | --- |
| 1 | S1 report metadata | Merged; the metadata route and `title` contract tests pass on `main` |
| 2a | #2401 cards | Starts after S1 is accepted on `main` |
| 2b | #2402 shelf | Starts after S1 is accepted on `main`; runs in parallel with 2a |

Hot files for 2a and 2b: `packages/web/src/api/queries.ts`,
`packages/web/src/api/client.ts`, `packages/web/src/routes.tsx` and
`packages/contract/src/artifacts.ts` (different hunks). The reader extraction
(`report-reader.tsx`) belongs to 2a only; the shelf uses the route. The second
of 2a and 2b to finish opens its PR after the first merges.

## Phase 2 exit

On integrated `main`:

- S1, #2401 and #2402 each pass their acceptance criteria.
- One browser check opens the same published report from a card and from the
  shelf, and both reach the same reader component.
- The isolation checks from phase 1 still pass.
- No new setting or interval exists (`npm run lint` env contract; a grep for
  `refetchInterval` in the new files).

## Epic exit

The phase 2 exit, plus the owner's real mobile-app QA for #2400, #2401 and
#2402: open a report from a link, a card and the shelf, and return to the
source view. The `needs-qa` gate on each issue records it.

## Owner decisions (2026-11-01, planner task `ee217e94`)

| Question | Answer |
| --- | --- |
| Q1 Title | HTML `<title>`, else the file name (D1) |
| Q2 Cards | One card per report, after the message text |
| Q3 Navigation | In More, beside Workflows |
| Merge authority | The coordinator merges through land-pr after CI and review are clear and the owner added `qa-approved` |

The owner also accepted the technical decisions listed in this spec.
