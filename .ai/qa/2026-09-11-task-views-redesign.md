# Task views — revised issue 224 references

Worker: `cez/ab1e8278`. Source reference: parent `cezarion.pen`, revised PNGs and main-content JSON extracts. No source design file copied or committed.

## Coverage

| Reference | Implementation and preserved behavior |
| --- | --- |
| 19 `e8wQer`, mobile `N6NED` | Inbox card stack, visible runnable suggestion, engine/model controls, optional instructions and templates, source links, dismissal/acknowledgment; provider gate retained. |
| 20 `f2220g`, `UFERI`, mobile `Jn0Bt` | Automation cards and editor sections, current saved trigger, five recent execution records per automation from the existing log API; full log route retained. Editing can enable through the existing baseline endpoint. Loading/error/retry/disabled paths retained. |
| 21 `yH9DZ`, mobile `hG4Cl` | Comparison columns stack on mobile; actual diff stats, progress, conditional usage, task links, named pick buttons, collapsible full diffs, terminal gate and destructive confirmation. |
| 22 `empfw`, mobile `i9Si8J` | Proposed chain cards with wrapping prompt text and visible Move up/down/Remove controls. Save/start/discard/overwrite/provider gates retained. Mobile sheet begins below the 52px shell; keyboard and drag reorder remain. |
| 25 `M5SWe`, mobile `lpRVc` | Full resource table is the default, saved fold/expand choices remain authoritative. Columns popover edits the same persistence API. Summary view retained as an alternative. Inline rename has Save/Cancel plus original Enter/blur/Escape behavior. Pin, read marker, mark-all-read, archive-finished and compare strip retained. Mobile cards expand real resource facts; purple New task FAB. |
| 26 `AHKNo` | Actual article cards, Project multi-select joined with existing Status/Workflow/tag filters, URL persistence and group toggles. Read/archive/restore/conflict/reference/project links retained. Project selection repeats `project=`; older bookmarked queries retain their semantics. |
| 33 `mpyjl` | Disabled optional features, empty/loading/error/retry rendering, comparison waiting/404 states; capability tests and real browser HTTP-fault captures. |

## Verification

- Server build, web typecheck and production web build passed.
- 305 focused tests passed across eight suites. The suites cover task overview, global tasks and helpers, Inbox, plan review, comparison, automations, and task-table calculations.
- New behavior tests were observed failing before fixes: Project filtering/URL, comparison retry, automation saved-trigger/enable/error/recent-log behavior, default resource columns, mobile details, task-list retry, explicit rename Save/Cancel, and visible Inbox suggestion.
- `task-views-layout.e2e.ts` boots disposable git worktrees with distinct committed variant diffs, a paused automation, and runnable/note-only Inbox entries. It checks 1440 Wide and 402/360 in both themes, persisted columns, mobile details, URL filter clearing, confirmation and acknowledgment. A separate local HTTP fault process checks loading → error → Retry → filtered-empty without replacing the application.
- 15 browser tests passed across the task-view, plan, and variant suites; the final task-view matrix/action/state suite passed again after the last Inbox change.
- Existing `plan-mode.e2e.ts` and `variants-compare.e2e.ts` pass their real plan/save/reorder/start and variant-pick flows. Plan adds six theme/viewport captures; relocated header assertions keep checking the actual task title in the subtitle.

Artifacts (generated, ignored): `.ai/qa/artifacts_e2e/task-views/` contains `{project,global,inbox,automations,editor,compare,loading,error,empty}-{1440,402,360}-{light,dark}.png`. Plan captures are `.ai/qa/artifacts_e2e/plan-review-{1440,402,360}-{light,dark}.png`.

## Integration boundaries

No server/API schema, run engine, shared shell, shared styles, theme/density defaults, or design source changes. Shared shell appearance is the parent's responsibility; these captures use this worker's inherited shell. Global resource details use only cost/CPU/memory fields supplied by the existing run index; no directional token values were invented. Complete directional resource information remains available in the project table and mobile project details. Inbox remains project-scoped; the design's hidden all-project facet is not fabricated against a scoped API. Full repository verification and PR creation belong to the parent.
