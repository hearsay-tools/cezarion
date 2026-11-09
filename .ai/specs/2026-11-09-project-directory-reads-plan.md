# Additive project-directory reads

Implementation plan for hearsay-tools/cezarion#3086. The approved issue is the
scope. The release switch does not gate reads. P5 changes writes later.

`project-paths.ts` separates ordered read roots from the legacy write root.
Singleton files use whole-file presence precedence, even when the first file is
damaged. Catalogs use names; runs use IDs. A run's sidecars follow its record,
including when a duplicate sidecar is absent in the winning directory.

The coordinator approved per-family copy-on-write on 2026-11-09. A family with any
member read from `.ai/squawk/` has run ownership `fallback`: every automatic path
meets the same refusal as a foreign family and skips it. Only an explicit run control
(`requireRunControl`) adopts the family, which copies its records and sidecars into
the legacy directory inside one transaction. `RunDatabase` refuses any other write or
claim in such a family, so a bypass fails loudly. Boot and reads do not copy fallback
state or create an empty legacy database. Neither tree is
moved or symlinked. The fallback tree stays logically read only. Normal read-only SQLite WAL coordination
may change only `runs.db-wal` and `runs.db-shm`. An unreadable or unsupported
fallback database contributes no runs and one warning; it never fails boot.

The planner chose no tombstones. Automatic retention and worktree cleanup skip
fallback-only items and duplicate logical records and log one count per sweep. An explicit destructive operation
refuses with the fallback path and asks the user to use the binary that migrated
the project. This preserves the source bytes and prevents deleted runs returning
from fallback on the next read.

| Case | Read | Write / cleanup |
| --- | --- | --- |
| Neither tree | Existing defaults | Explicit writes use legacy |
| Legacy only | Existing behavior, including import and recovery | Existing behavior |
| Fallback only | Read-only source, no shadow database | An explicit run control adopts the family into legacy; automatic writes skip it |
| Legacy root with fallback workers | Union; one mixed family | Read only for automatic paths, like fallback only |
| Both, duplicate ID/name | Legacy item and its own sidecars | Legacy |
| Both, disjoint IDs/names | Union | Legacy |
| Damaged legacy singleton/store | Existing failure/default contract; no fallback substitution | Refuse unsafe replacement |
| Live foreign fallback claim | Readable; ownership `fallback` | Refuse adoption and writes |
| Dead fallback live family | Readable; no boot recovery write | A control adopts it, then normal orphan adoption recovers it |
| Automatic fallback cleanup | Retain bytes and evidence | Skip; one count per sweep |
| Explicit fallback or duplicate deletion | Retain bytes and evidence | Refuse; name source path and required binary |
| Writes in a fallback worktree | Refuse agent launch/Continue, setup, preview commands and Git writes; autosave/cleanup skip with a count; diff, files and result collection remain readable |
| Release switch off | Dual reads | No migration or deprecation notice |
| Release switch on | Same dual reads and precedence | Legacy notice; writes remain legacy until P5 |

Existing legacy-only tests keep their expectations. The skill-directory drift
guard gains `.ai/squawk/skills` immediately after `.ai/cezar/skills` and the browser
fixture catalog gains both fallback catalogs. This replaces the old closed list
with the approved additive discovery guarantee.

## Reader inventory

The sweep includes direct strings, split path components and `dataDir` consumers.
Explicit-directory storage helpers retain their API; their callers select the
winning record before reading and the legacy directory before writing.

| Reader or caller group | Disposition |
| --- | --- |
| `index.ts` project boot and `initCommand` | Converted boot resolver; retained legacy init/catalog writes |
| `serve-command.ts` | Converted project boot resolver and switch-gated notice |
| `server/project-context.ts` boot/lazy/maintenance | Converted resolver; fallback maintenance preflight; no empty DB |
| `server/server.ts` boot and cold workspace search | Converted resolver and winning-run source calls |
| `runs/store.ts` | Converted ID union, source-bound evidence; `fallback` ownership and explicit `adoptFallbackFamily` |
| `runs/run-database.ts`, legacy imports | Converted read projection; fallback DB read-only, JSON parsed in memory |
| `runs/run-index.ts` | Converted cold listing, search and checkout lookup; no recovery |
| `artifacts/reports-index.ts`, `runs/report-rows.ts` | Converted scan source; retained legacy/in-memory derived cache writes |
| `automations/store.ts`, `automations/coordinator.ts` | Converted definitions/state by ID and event logs; writes remain legacy |
| `git-worktree.ts` | Converted recognition/protection; fallback cleanup skips; writes remain legacy |
| `delegation/workspace.ts` | Converted receipt path validation for both managed names; writes remain legacy |
| `delegation/results.ts`, `delegation/service.ts` | Converted history/artifact/retained-result reads; spawn preparation writes remain legacy |
| `delegation/worker-cleanup.ts`, `runs/retention.ts` | Converted fallback refusal/skip; source-bound evidence; legacy byte cleanup retained |
| `workflows/run.ts` and `workflows/run/*` | Converted entry write root; retained generated launch/task paths under legacy; adoption precedes launch writes |
| `artifacts/store.ts` | Retained anchored explicit-directory helpers; converted API, report and delegation callers |
| `artifacts/resolve.ts` | Converted exclusions for both private runtime trees |
| `handoff.ts`, store handoff path | Retained explicit-directory writers; converted read callers and family preservation |
| `config.ts` async load/raw/update/sync readers | Converted whole-file read selection; locked writes preserve fallback singleton keys |
| `core/agent-model-policy.ts` | Converted synchronous raw config selection |
| `workspace/migrations.ts` | Converted legacy-first config selection; edits remain legacy |
| Worktree setup and server config/skill-source edits | Converted through shared config readers/writer; no alternate merge policy |
| `workflows/load.ts`, `WORKFLOWS_DIR` consumers | Converted cross-directory name precedence; retained same-directory duplicates and legacy saves |
| `skills.ts`, `SKILL_DIRS` | Converted ordered roots; preserved built-in, shared `.ai/skills/`, mirror and team precedence |
| `skills-remote.ts` | Converted project team-config selection; team cache remains home-owned |
| `session-context.ts`, `SESSION_CONTEXT_FILE` | Converted whole-file read; tracked shared context paths unchanged |
| `ui-state.ts` | Converted project preference singleton reads; writes preserve fallback keys |
| `runs/webhook.ts` | Converted project context and pending-question history source |
| `home/migration-accounts.ts` | Converted conservative account-in-use probe across both stores |
| `self-update/checkouts.ts` | Converted cold task lookup through shared run index |
| `workspace/projects.ts`, `workspace/semaphore.ts` | Converted managed-worktree recognition for both names |
| `task-cli/discovery.ts` | Retained Git common-directory project discovery; no runtime-name dependency |
| `server/cockpit-ownership.ts`, `server/launch-key.ts` | Converted fallback ownership inspection and whole-file launch-key read; claims/key writes legacy |
| Voice asks and recent-action log | Converted history source and per-decision event union; appends legacy |
| History, transcript facts, attachments and SSE helpers | Retained explicit-directory APIs; store/HTTP/feed callers select winning source; fallback facts never persist |
| Autosave, scratch and preview cleanup stores | Retained legacy resource writers/sweeps; fallback resources are never reclaimed or imported at boot |
| `packages/web/src/lib/skill-groups.ts`, `skill-empty-hint.tsx` | Converted copied project skill paths |
| `preview/preview-states.tsx` | Converted managed-worktree path recognition |
| `.ai/scripts/e2e-catalogs.mjs` | Converted fixture catalog isolation across both names |
| `.ai/scripts/probe-questions.ts` and development fixtures | Retained legacy write roots; shared RunStore now reads both; fixtures pin legacy writes |
| `data-gitignore.ts`, root `.gitignore` | Converted both runtime trees and sibling journal; common Git excludes work in linked worktrees |
| Area instructions | Updated cli, git-worktree, runs-store, skills, handoff-journal, workflows, workspace-registry, project-routes and web-ui; `AGENTS.md` unchanged per owner gate |
| Campaign skill, epic-mode reference | Retained `.ai/qa/` and `.ai/specs/`; neither path changes |
| Auto-merge checker | Retained repository policy globs, including `.ai/skills/`; no project-state reader |
| Historical specs/ADRs, comments and CLI wording | Retained history and legacy write-path descriptions; final wording belongs to P3e |
