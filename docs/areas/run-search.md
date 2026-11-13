# Run search

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/contract/src/run-search.ts`, then its readers: `packages/web/src/lib/tasks-table.ts` (`filterRuns`), `packages/web/src/lib/global-tasks.ts` (`filterGlobalTasks`, `tasksExcludingFacet`), `packages/cezar/src/runs/store.ts`, `packages/cezar/src/runs/run-index.ts`

## Rules

`RUN_SEARCH_FIELDS` lists every searchable field, `matchesRunSearch` is the one predicate, and `sqlPrefilterTokens` derives from the same list. A new field is one entry there: every reader of its scopes searches it. Each reader's difference is an option of its call, never code of its own: `scope` (`shown` for the lists, `stored` for the server) and the automation names (the palette passes none). Every reader matches each whitespace-separated token on its own (hearsay-tools/squawk#1884). The ast-grep rule `run-search-field-list-outside-contract` refuses a second field list, and `run-search-readers.test.ts` pins the readers' calls. `run-search-prefilter.test.ts` shows the SQL prefilter never drops a run the predicate accepts. Its one kept gap is a match only through U+212A or U+0130, which JavaScript folds to ASCII and SQLite does not (hearsay-tools/squawk#1884). A new field still needs a [reader sweep](../../CODE_REVIEW.md#changing-working-behavior) over the browser specs that search or count tasks.
