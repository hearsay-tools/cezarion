# Revised design reconciliation — issue 224

The revised source is `cezarion.pen`. The earlier `site-features-missing-from-design.md` describes the original design and is retained as history.

## Covered by the revised design and implementation

- Shared desktop/mobile navigation: Add project, Active/Archived, pinned/recent sessions, optional Inbox/Automations, Tools, theme and installed-version controls. Navigation instances now link to shared masters; see `navigation-repair.md`.
- Suggested task starters and the independent Follow-ups preference.
- Project resource columns and persistence, rename/pin/read actions, mobile resources and New task button.
- Global project/status/workflow/tag filtering, grouping, read/archive/reference actions.
- Inbox, automations, variant comparison and plan review.
- Task action menu, worktree chooser, Notes reader, Finish/Archive confirmations and existing resume facilities.
- GitHub prompt-first handoff and PR Conversation/Changes, readiness, merge confirmation, bypass and conflict handoff.
- Project/global settings interiors and Workflow import/add/delete dialogs.

## Runtime and API differences to retain explicitly

| Reference | Existing implementation contract | Result |
| --- | --- | --- |
| 27 — PR assignee/project-board filters | The GitHub driver supplies these fields for issues only. | Existing issue filters remain functional. PR-specific metadata/filtering needs a separate backend change; it is not represented with fake controls. |
| 27 — State dropdown | Existing search supports GitHub state terms; there is no separate state-dropdown contract. | Search and its pagination remain available. |
| 28 — Notes updated timestamp | Handoff endpoint returns plain text without modification time. | Notes, copy and close work; no timestamp is invented. |
| 28 — Native resume command | No read-only endpoint supplies the runner command. Existing `resumeHint` supplies the supported command; opening a terminal is a separate explicit action. | Existing command copy and terminal resume are preserved. No terminal is launched just to discover a command. |
| Global task resource examples | Global index supplies cost/CPU/memory, but not directional tokens or diff statistics. | Show the supplied values. Complete metrics remain in project task views. |
| Settings — provider and save variants | Installed runners, native authentication, inherited defaults and per-field saves are existing behavior. | Preserve these controls even where a reference illustrates a simpler configuration. |

Issue 224 explicitly excludes new HTTP routes and run-engine behavior. These differences are not permission to remove existing capabilities or weaken their tests. A future design pass can make the API-dependent variants explicit; new backend capabilities need their own scope.

## Verification evidence

- Repaired source: 158 frames retained, 144 linked navigation instances, no duplicate IDs or dangling refs; 78 main-content sections unchanged by the repair.
- Shared shell/New task/Tools: 12 viewport/theme browser cases; mobile drawer at 402 and 360px; no page overflow, footer reachable, mobile targets at least 44px.
- Integrated Settings/Skills/Workflows: 84 captures and add/remove/reorder/import-error/resource-save interactions passed.
- Reading width: Skills, Workflows and both Settings scopes keep the same 1208px route width at a 1440px viewport under Narrow and Wide. Task views retain their reading-width preference.
- Integrated task views: four native browser tests passed, including the multi-viewport matrix, persisted columns, resource disclosure, filtering, confirmations and retry states.
- Detailed route reports: `packages/web/e2e/settings-workflows-revised-qa.md`, `packages/web/e2e/session-github-design-qa.md`, `.ai/qa/2026-09-11-task-views-redesign.md`.

Repository validation: typecheck, 7,985 Vitest tests (30s timeout for the subprocess stress test), 37 core plus 261 workflow-script tests, production build/check:pack and 27 package tests passed. New-task hierarchy browser suite: 27 tests passed. Fixture captures do not claim real-device iOS keyboard verification or authenticated provider execution.
