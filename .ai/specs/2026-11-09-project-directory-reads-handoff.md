# Project-directory dual reads: implementation handoff

Baseline for the replacement worker implementing hearsay-tools/cezarion#3086.
The coordinator is `253e7706-aeaf-4498-8dd0-9ee43cbaf491`; this worker is
`fbe890d6-d78e-4695-baf6-c346b08c8b7c`, branch `cez/fbe890d6`.
Nothing was pushed. No PR was opened, marked ready, queued or merged.

## Status and transfer boundary

**The run-store mechanism is not accepted. Round 3 B1 and B2 remain open.**
The coordinator stopped patch rounds and assigned a fresh design evaluation.
Do not treat passing tests or the existing area-doc rules as proof that automatic
writes obey the contract. They do not: the two paths below can still copy fallback
records. Do not implement another local patch here without the coordinator's new
brief. This worker applied only the two requested closing items in `fd836c600`:
the cold-read contract sentence in runs-store.md and a block-bodied curried mock
in index-project-paths.test.ts. The reviewed implementation head was
`f86bab3b792eb9d16ba5eab1e03b4b1db0ae5e43`; the pinned implementation baseline was
`b7c17fed2de276ca81645a94a17d61e223d8a1ba`.

The transfer instruction is coordinator request
`0d87c9b3-5fae-469b-905f-e98d98ef03c4`. The new worker inherits the branch as a
baseline, including incomplete measurements and open defects. The coordinator
owns review workers, release, issue/board state, merge and friction posts.

## Current design

### Path selection and run source

`project-paths.ts` separates the legacy write root from ordered read roots:
`.ai/cezar/` first, `.ai/squawk/` second, in both release-switch states. Singleton
selection uses whole-file presence, not per-key fallback. Catalogs use names;
runs use IDs. Run history, artifacts, handoffs, transcript facts, worker results
and cleanup evidence follow the selected record's source as a unit. A missing
legacy sidecar never causes a read from the losing fallback duplicate.

`runs/project-run-sources.ts` discovers a fallback SQLite database or parses
fallback runs.json in memory. Fallback DB opens are read-only. An unsupported,
locked or unreadable fallback source contributes no runs and one warning.
A damaged primary keeps its existing failure contract. Fallback files are never
migrated or recovered. A normal legacy-only project keeps its old behavior.

### ProjectRunConnection read projection

`runs/project-run-connection.ts` wraps the primary DatabaseSync with a proxy.
With fallback-only data, the primary starts in memory and carries an explicit
`deferred` flag from the initial open; it opens a legacy disk DB only for a write.
If another process creates that DB meanwhile, `refresh()` switches to disk and
prepared statement proxies reprepare against the current connection.

The fallback DB is attached with `mode=ro`, or JSON rows occupy a temp table.
`project_runs` is a temporary UNION ALL view with primary-ID precedence;
`project_claims` merges claims with primary-family precedence. Run fallback
insertion sequences are shifted into a disjoint negative domain (this is an
internal run-index domain, separate from the positive automation-log cursors).
The projection supplies defaults for columns absent from a readable old schema.

`prepare()` rewrites SELECT/WITH FROM/JOIN table references for `runs` and
`run_claims`, skipping quoted text and comments and retaining aliases. Writes
still address the real primary tables. This narrowed rewrite replaced an unsafe
whole-word text replacement in round 1. `project-run-database.test.ts` exercises
the read API, including report queries and peer pagination, with duplicate and
disjoint sources. This remains an adapter mechanism to re-evaluate, not a new
approved public storage contract.

### preserveFamilies copy-on-write

RunDatabase.transaction selects families only for upserts whose selected row is
fallback. After existing ownership and row fences pass, it invokes
ProjectRunConnection.preserveFamilies inside the primary transaction. It refuses
a live fallback owner. It copies missing family rows and matching run sidecars to
legacy and advances primary commit sequence metadata. A primary-only upsert does
not copy untouched fallback relatives. The sidecar copier rejects redirected
sources and differing orphan destinations; byte-identical destinations from an
interrupted attempt count as preserved. Ordinary rollback removes newly copied
paths, and commit clears that rollback list.

The approved condition is **explicit writes only**. The adapter does not encode
that intent. Any automatic caller that reaches a normal write can trigger the
same preservation. Round 3 demonstrates that this distinction is not enforced
by held-set filtering or by the low-level write boundary.

### Held admission and family recovery filters

RunStore.holdDecoded returns fallback records as detached reads, instead of
inserting them into `held`. They follow the existing cold-read convention:
deep-frozen in Vitest only; production callers must use store methods to write.
`hold`/`record` preserve a selected fallback record before mutable admission.
Explicit adoptFamily preserves before holding/settling. Startup live, reference
and automation healing candidates, holdFamily, and setRepoHandle cold repair
exclude fallback rows. Conflict refresh evicts a fallback replacement. Family
recovery filters exclude fallback workers, and automatic conversation projection
skips fallback participants. These filters fixed tested paths but did not cover
question-retirement writes or automatic family archive cascades.

### Automation log cursor projection

`automations/project-files.ts` merges definitions/state by ID with legacy
precedence and retains unknown top-level file keys when writing the counterpart.
Log dedup keys remain raw `(automationId, seq)`; receipt keys include receipt ID,
status and update time. Only merged page reads map legacy seq n to 2n and fallback
seq n to 2n-1, then sort by that positive cursor. New legacy appends do not shift
existing cursors. Legacy-only pages keep their old sequences. Append and
compaction use raw positive legacy sequences. Compaction never rewrites fallback
logs/receipts into legacy; fallback-only compaction is a no-op. Tests page HTTP
3+3+2+0 rows with an intervening legacy append and compact/reload, plus a 200-row
store test. No HTTP cursor or stored-log schema was changed.

## Approved decisions and their sources

The original worker brief and issue hearsay-tools/cezarion#3086 are the fixed
scope: legacy wins before P5; fallback supplies missing items; writes stay legacy;
no global `.ai` rename; `.ai/qa`, `.ai/specs`, `.ai/skills` stay unchanged; tracked
files are never moved; no new setting/env flag; dual reads are not switch-gated;
home/switch.ts is read-only and remains off in source; notices start only with the
release switch. Preserve ownership/orphan fences, skill precedence and private
storage exclusions. Do not change AGENTS.md without the owner gate. No stacked
PRs; the coordinator releases an exact head/base before a draft PR and lands it.

The following are the full decision texts received from the coordinator. IDs
identify the source messages in the Cezar conversation. They distinguish planner
and owner decisions relayed by the coordinator from this worker's design choices.

### Copy-on-write and read-only fallback

Source: coordinator message `5f35b07e-4e86-4a9c-9285-526554728ddf`.

Decision, part 1 (approved now): per-family copy-on-write is approved. It is the issue's rule 'Preserve fallback-only data when an existing operation writes its legacy counterpart'. Conditions: copy happens only on an explicit write to that family, inside the existing primary transaction and ownership checks; boot, list and every read never create .ai/cezar/runs.db or any legacy file; never a whole-tree copy. Part 2 (confirmed): never delete, change or move bytes under .ai/squawk/ in P4a; it is read only. Part 3 (pending): a legacy tombstone is new stored state that the spec does not name, and P4b2's merge would have to handle it. I am asking the planner. Until I answer, build the alternative that adds no state: automatic cleanup and retention skip fallback-only items; an explicit destructive operation on a fallback-only item is refused with a clear error that names .ai/squawk/. Keep that code isolated so a tombstone can replace it if the planner chooses that.

### Planner rule A: no tombstone

Source: coordinator message `50340285-4352-42ea-9551-9ae5ab687b3c`.

Decision, part 3 (final, planner chose A; no tombstone): (1) automatic retention and worktree cleanup skip fallback-only items and log ONE line per sweep with a count, not one line per item; (2) an explicit delete of a fallback-only item fails with an error that names the .ai/squawk/ path and tells the user to use the binary that migrated the project; (3) tests for both cases; (4) record the rule in the PR body and in docs/areas/runs-store.md.

### SQLite WAL coordination exception

Source: coordinator message `b801a7b4-3e81-40af-bbb1-7a9ae7ae78f3`.

Decision: use normal read-only SQLite WAL coordination for the fallback runs.db. No snapshot mechanism, no immutable=1. Reason: -wal/-shm are SQLite coordination files, not product data; a newer binary that writes that database concurrently needs exactly this coordination, and both sidecars are already in the squawk ignore rules. Conditions: (1) the fallback database never opens read-write, never runs schema migrations, the legacy runs.json import or recovery, and never writes records or evidence; (2) an unknown or newer schema version, a locked or unreadable fallback database, or a read-only directory that blocks the -shm file degrades to 'no fallback runs' plus one warning, never a boot failure and never a write; (3) rewrite the 'no writes under .ai/squawk' tests to assert no logical changes (rows and evidence files byte-identical), and allow only the SQLite sidecars; (4) state this exception in docs/areas/runs-store.md and the PR body. This also confirms ce6ca8480 for F1-F3; I read the diff.

### Duplicate logical deletion refusal

Source: coordinator message `0cca6575-abcf-4c7a-8465-40bdb24e3f53`.

Approved: the stronger refusal. It is the planner's rule A applied consistently (no false-success delete, no new state). Rules: (1) an explicit logical delete of a run, workflow or automation fails whenever the same ID or name also exists under .ai/squawk/, whichever copy is selected; use the same error form (it names the .ai/squawk/ path and says to use the binary that migrated the project). (2) Automatic retention that deletes logical records skips such items too and counts them in the same one-line-per-sweep log. (3) Byte cleanup of resources that exist only under .ai/cezar/ (for example a legacy worktree directory) continues as today. (4) Legacy-only projects (no .ai/squawk/) see no change; pin that with a test. (5) Add the rule to the runs-store doc table and the PR body. Tests for duplicate-delete refusal and retention skip.

### Node-test measurement path limitation

Source: coordinator message `83971814-e653-46e7-91bd-a03c9e026f99`.

No accepted measurement path exists for changed callbacks in a node:test TypeScript file: that is open issue hearsay-tools/cezarion#1711. Do not restructure the test to avoid the gate. Collect the complete evidence for everything else (bundled check or CI coverage for the Vitest parts), keep the skill-dirs drift test passing, and record the gap precisely: file, the two callbacks, complexity 1 each, exit 2 reason, hearsay-tools/cezarion#1711. I am asking the owner now for the exception; I will tell you the answer before the PR opens. Continue the implementation.

### Fallback-worktree writer refusal

Source: coordinator message `3bbe399c-76ef-4f2e-ab30-da8f164c5785`.

Approved: the refusal. A checkout under .ai/squawk/worktrees/ is inside the read-only tree, and this case occurs only after a downgrade, the same as rule A. Scope: every product operation that would write into a worktree under .ai/squawk/ is refused (explicit) or skipped (automatic, counted in the same one-line sweep log): agent launch and Continue, autosave commits, worktree setup, preview start if it writes there, and worktree removal or cleanup. Use the same error form (names the .ai/squawk/ path, says to use the binary that migrated the project). Record-only edits stay permitted through copy-on-write into .ai/cezar/. Reads of that worktree (diff, files view, collect) stay permitted. Add tests for Continue refusal and the autosave/cleanup skip, and add the row to the runs-store doc table and the PR body.

### Owner-approved measurement exception

Source: coordinator message `1ad0612e-176d-459b-87b7-c58476b992ab`.

Owner decision (cezar_ask in coordinator task, 2026-11-09): 'Open, state the gap'. The PR may open with the skill-dirs.test.ts measurement gap stated in its Validation section: file, both callbacks, complexity 1 each, the exit 2 reason, and hearsay-tools/cezarion#1711 (Refs, not a closing keyword). Every other changed function still needs complete evidence and resolved findings. The PR still opens only after the reviewer rounds and my release.

### Stable positive log cursor constraint

Source: coordinator message `2e440a5c-15cc-4ca2-8979-54820ed87ea7`.

Plan accepted. One constraint on the log cursor: a positive cursor over the merged page must stay stable while new legacy entries are appended between page requests (no skipped or repeated rows). A position-in-merged-list cursor fails that. Pin it with a test that appends legacy entries between two page requests.

### Keep the existing cold-read convention

Source: coordinator message `598e81e9-6af3-4577-bada-bdd37e212d4f`.

Decision: no change. Keep the existing convention (runs-store.md: cold reads are detached and deep-frozen under Vitest only). The fallback branch follows the same contract as cold legacy reads on main, so it adds no new class of silent loss, and a production-only freeze would turn the same caller bug into a crash only for fallback rows. Your tests already exercise the fallback branch under Vitest, where a mutating caller fails. Record one sentence in the runs-store doc that fallback reads follow the cold-read contract. Keep the head frozen until round 3 reports.

## Complete round-2 caller audit

Source: worker formal reply `61a2678f-f5b0-4a89-9bff-d25e8a54a362` to coordinator
request `3cfd6e71-e35b-4cd0-9792-68030c99960e`. This is the complete caller audit
as sent, not a claim that it excludes all automatic write paths. Round 3 disproves
that stronger claim.

B1 choke-point fix and audit:
- holdDecoded now refuses fallback admission, returning a detached read (frozen under Vitest). Its three direct callers are hold, answerCold and setRepoHandle.
- hold is reached by record/pin and explicit controls. It preserves a selected fallback record/family transactionally before holdDecoded. record retains its defensive preservation branch. pin reaches record, not a read admission.
- answerCold serves peek/getRun/fromRow, including listWorkersOf and every indexed family/list reader. Anchoring a legacy root cannot now hold a fallback worker. The mixed read test calls both getRun and listWorkersOf before checking listRuns.
- setRepoHandle excludes fallback rows from its cold repair query; held iteration now contains only legacy rows.
- Other held insertion path adoptLoadedRun is reached by loadHeldRows (live, reference-heal, automation-heal) and holdFamily. All startup candidates filter fallback; holdFamily also filters fallback rows before adoption. holdFamily callers are boot loadHeldRows and explicit adoptFamily. Explicit adoptFamily first preserves a selected fallback record, so it becomes primary before its mutable adoption. Untouched fallback members of a legacy family remain skipped.
- createRun inserts a newly generated legacy record. commitIndex inserts/replaces held records only after persist commits explicit writes; createOwnedRun routes through commitIndex. Its held-map adapter and archiveFamily adapter expose ReadonlyMap only, never insert.
- Conflict refresh may replace an existing held record; it now evicts a record if the projected replacement is fallback. Eviction, delete, open-failure cleanup and close only remove held state.
- A separate automatic write path surfaced during this audit: conversation event projection can name fallback participants from a legacy root. It now skips those participants. Also, RunDatabase preserves a family only when an upsert actually selects a fallback row. Recovery writes to a primary parent cannot copy untouched fallback relatives.
Tests: mixed live legacy root + running fallback worker manager boot confirms root recovery lifecycle/status, worker absent from legacy DB and held list, fallback DB/evidence unchanged; conversation projection skip; direct mixed reads; explicit fallback adoption preservation.


## Review history

Before independent rounds, the coordinator reviewed `863102016` and sent F1-F3 in
`99d33c4b-14ad-42c6-aafb-bb93d2fcd378`. All three were fixed in `ce6ca8480` and
accepted in the WAL decision above:

| Finding | Fix |
| --- | --- |
| F1: new .ai/.gitignore dirtied legacy-only project status | Use best-effort idempotent Git common-dir info/exclude; linked-worktree and clean-status/runtime-ignore tests |
| F2: new workflow/skill negations changed this repo's old ignore policy | Revert both negations; mirror only existing policy for squawk and its journal |
| F3: workflow seen-set also removed same-directory duplicates | Suppress names only across directories; tests pin both cross-directory precedence and same-directory behavior |

### Round 1: seven findings, fixed in fc7c56b98

Reviewer `1006a629` reviewed `f1d9858d7` against `b7c17fed2`; the coordinator sent
request `ef6f14ba-5c0f-47dd-a6cb-1b845955971b`. Formal response was
`b370de9d-7f24-4be1-aec5-095b4fb52d7f` (late reply). Round 2 confirmed these fixes
were present, while finding the additional paths listed next.

| Finding | Change and remaining limit |
| --- | --- |
| B1: boot holdFamily/reconcileRecoveryWorkerFamilies could copy/settle fallback rows | Filter startup family candidates and recovery family members. Later rounds found other paths; the general requirement is still open. |
| B2: duplicate fallback ID blocked worker destroy of legacy-only resources | Use canDeleteRun's worktree-purpose guard in worker cleanup; preserve the logical record and fallback resources. |
| B3: independent automation sequence domains hid fallback pages | First used disjoint negative fallback sequences. Round 2 rejected this solution; replaced by the current positive page-only projection. |
| D1: inferred deferred state raced another process creating runs.db | Carry initial storage mode explicitly; test first write survives reopen. |
| D2: crash after file copy but before DB commit stranded sidecars | Accept byte-identical existing copied sidecars on retry; refuse differing ones; test interrupted-copy retry. |
| G1: foreign-claim test expected an exception | Assert updateRun returns undefined and leaves state unchanged. |
| C1: broad SQL replacement changed literals/aliases | Narrow to FROM/JOIN references outside quoted text/comments; API-wide projection tests include reports and peer page. Coordinator accepted this in ca0ff72f-73d5-431d-8f0c-588745b3b1d3. |

### Round 2: two findings, fixed in f86bab3b7

Reviewer `7dcb714e` reviewed `fc7c56b98`; request
`3cfd6e71-e35b-4cd0-9792-68030c99960e`. Formal response and caller audit:
`61a2678f-f5b0-4a89-9bff-d25e8a54a362`.

| Finding | Change and evidence |
| --- | --- |
| B1 high: listWorkersOf decoded fallback workers into held before family filter; boot then recovered/copied them | Guard holdDecoded itself; audit other insertions; preserve before explicit adoption; skip conversation projection participants; only fallback upserts trigger preservation. Mixed live legacy root/running fallback worker manager test checks recovered root, no primary worker row, no held fallback worker and unchanged fallback DB/evidence. Round 3 shows two remaining automatic paths. |
| D1 medium: negative log cursors fail positive HTTP validation and get discarded after compaction | Page-only positive even/odd projection; raw legacy-only compaction. HTTP pagination with append between pages and compact/reload; store 200-row pagination, duplicate precedence, no copied fallback log/receipt rows. |

### Round 3: two OPEN findings; do not patch in this worker

Reviewer `b007d3a9` reviewed `f86bab3b7`. Coordinator request
`0d87c9b3-5fae-469b-905f-e98d98ef03c4` states:

1. **B1 OPEN: automatic question retirement copies fallback records.** Boot
   `RunRecovery -> reconcileWorkerWaits -> retireSettledQuestions/closeRoutedQuestions`
   follows a conversation `senderRunId` to a terminal fallback worker and appends
   `human-ask-closed`. That reaches
   `RunStore.appendEvent -> record -> persist -> RunDatabase.transaction -> preserveFamilies`
   and copies the fallback worker into primary. Held-set read admission guards do
   not prevent an automatic caller from invoking a normal store write.
2. **B2 OPEN: automatic archive cascades copy fallback family members.**
   `ArchiveOnMergeCoordinator / completeAction` unions fallback workers of a legacy
   root and archives them through `stageArchive/commitIndex`. This again reaches
   preservation even though the work is automatic.

The coordinator chose a fresh design re-evaluation after the third consecutive
round exposed another instance of the same class. No fix for either was applied.
No clean review, hot-file release, push or PR exists.

## Check evidence and limits

All paths below are worktree-local ignored logs/reports; they are diagnostics,
not committed deliverables. Preserve or regenerate them before worktree cleanup.
The checked source head for quality r6 is f86bab3b7, not the closing mock rewrite.

| Check | Result and provenance |
| --- | --- |
| Root npm run typecheck | PASS at f86bab3b7; .ai/qa/3086-typecheck-r3b.log; no later production-source edit |
| Root npm run lint | PASS at f86bab3b7, 16 cez + 36 ast-grep rules; .ai/qa/3086-lint-r3b.log; closing rerun PASS at fd836c600 in .ai/qa/3086-lint-handoff.log |
| Clone ratchet | PASS, 53 pairs, 0 violations at f86bab3b7; .ai/qa/3086-clones-r3.log |
| Citation check | PASS against b7c17fed2; closing rerun PASS at fd836c600 in .ai/qa/3086-citations-handoff.log |
| Build/package CLI/ownership/task tests | Earlier build/package run 4 tests PASS, 0 failures; .ai/qa/3086-package.log. Not a fresh package run on final head. |
| Focused round-2 checks | 6 files / 113 tests PASS; subsequent final adoption/source diagnostic 23 tests PASS. Partial diagnostics only. |
| Complete bundled quality r6 | 259 selected Vitest files: 257 PASS, 2 skipped; 4,646 tests PASS, 14 skipped; duration 718.52 s. 465/465 changed functions inventoried in 74 files; 461 numeric passes, 0 limit findings, 4 unavailable; max complexity 20, max CRAP 30. Exit 2 / INCOMPLETE, not PASS. |
| Quality provenance | .ai/cezar/tmp/3086/code-quality-r6.md and .json, .ai/qa/3086-quality-r6.log. Baseline b7c17fed2de276ca81645a94a17d61e223d8a1ba; head f86bab3b792eb9d16ba5eab1e03b4b1db0ae5e43. JSON command contains exact reproduction argv and file source hashes. |
| Parity | npm run test:parity delegates to Squeal, 236 files; latest round 15: 137 PASS, 99 pending in .ai/qa/3086-parity-r3.log. Never reached a full-pass verdict during implementation. |
| Squeal | Revision 77 at fd836c600: selected index-project-paths.test.ts and skill-dirs.test.ts both current PASS after 36.8 s; .ai/qa/3086-squeal-handoff.json. Global 1,182 current / 648 pending test files; 0 known failures; slow pending 0. No known failures is not a passing or current global verdict; lint daemon had disabled its oxlint lane after three 5-second timeouts. Root lint is separate and passed. |

Quality r6 unavailable functions:

| File | Function | Complexity | Reason / handling |
| --- | --- | ---: | --- |
| packages/cezar/src/index-project-paths.test.ts | startCockpitHint at 18:58 | 1 | Transformed function does not match coverage source positions. Block-bodied rewrite committed in fd836c600 per references/tool.md; fresh coverage still required. |
| packages/cezar/src/index-project-paths.test.ts | anonymous at 18:64 | 1 | Same curried mock mapping gap and rewrite; not an approved exception. |
| packages/cezar/test/unit/skill-dirs.test.ts | anonymous at 17:88 | 1 | File absent from Vitest coverage. No accepted node:test TypeScript callback measurement path; tool exits 2. Owner-approved exception, Refs hearsay-tools/cezarion#1711. |
| packages/cezar/test/unit/skill-dirs.test.ts | anonymous at 38:74 | 1 | Same approved limitation; keep drift test intact and state both callbacks in eventual PR Validation. |

The final mock rewrite and skill-directory drift tests both have current passing Squeal verdicts at revision 77. This does not measure the changed mock functions or close the quality gaps.

The complete-quality gate has not passed. Only the two skill-dirs callbacks have
an owner exception. No other missing measurement may be represented as accepted.
After the replacement design changes source, collect one fresh complete report
or complete current Squeal evidence under the quality skill; do not combine
partial diagnostics into a whole-PR pass. Earlier r4/r5 collections were stopped
before producing reports and provide no final evidence.

## Independent work considered implemented

These parts do not depend on the rejected automatic-write mechanism. They remain
part of the baseline; they are not separate PRs or blanket approval of downstream
run-store callers. The complete reader inventory and acceptance matrix are in
[the implementation plan](2026-11-09-project-directory-reads-plan.md).

| Area | Completed behavior / relevant tests |
| --- | --- |
| Shared project paths | Ordered roots, presence selection, fixed legacy write root, managed-name recognition, switch-gated notices; project-paths.test.ts and project-paths-switch.test.ts cover neither/each/both/duplicates/disjoint and both switch states. |
| Config and singleton readers | config.ts async/sync/raw/update, core agent model policy, project context.yaml, UI state, workspace migrations, team config and launch key use presence precedence; explicit counterpart updates preserve fallback data and unknown keys under legacy. Damaged primary singleton does not fall through. |
| Workflow and skill catalogs | Across-root union with legacy-name precedence; same-directory duplicate workflow behavior retained; legacy saves/deletes obey approved refusal rule. Skill order retains built-ins, shared .ai/skills, mirrors and team sources. skill-dirs.test.ts drift expectation is the approved additive path-list change. |
| Ignore policy | data-gitignore.ts appends squawk runtime/journal rules to Git common-dir info/exclude, best effort/idempotent, no squawk creation. Tests pin clean legacy git status, linked-worktree common dir, ignored runtime and committable authored workflows/skills/context. Repo .gitignore only mirrors its existing cezar policy for squawk. |
| Web and fixture paths | Skill group paths/empty hints, managed checkout recognition in preview states, and e2e fixture catalog isolation include both names. No UI protocol or style redesign. |
| Private file exclusions | Artifact resolution excludes both runtime trees; explicit source selection remains centralized for store-dependent callers and needs the new design preserved. |
| Documentation | Area docs and tracked plan describe intended two-root contract; no AGENTS.md edits. Cold-read clarification now added. Runs-store's automatic-write guarantees remain requirements contradicted by open B1/B2, not evidence of completion. |

Worktree/source guard changes for fallback-managed worktrees, source-bound
artifacts/history/handoffs and cold task discovery are also implemented, but their
interactions with the run-store redesign must be rechecked. Keep ownership and
orphan protection and existing resource cleanup semantics. Do not rebase held
hearsay-tools/cezarion#3034 changes into this branch; keep its touched areas small.

## Continuation requirements

The coordinator owns the new design brief and reviewer/release loop. Re-evaluate
how explicit write intent is enforced, including automatic callers of public
store mutators and cascade writes, without weakening the approved decisions.
Preserve every fallback byte except SQLite WAL coordination. Do not infer an
explicit user write merely from reaching record(), transaction() or commitIndex().

No new source patch for round 3 was made. No push. Friction to relay through the
coordinator: large Squeal pending queues/late heartbeat and the disabled oxlint
lane impeded fresh parity/current coverage evidence; source-position matching
failed on a curried mock and has the documented block-body workaround. The
coordinator owns any friction posts and the required Squeal issue template flow.
