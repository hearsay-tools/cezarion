# Site features needing design coverage

Compared the current implementation with `design.pen` for issue #224. Work paused at the user’s request on 2026-09-11. These are inputs for the next design iteration, not permission to remove capabilities or weaken their tests.

## No dedicated screen in the reference

- **Inbox / follow-ups:** optional inbox navigation, follow-up review/start flows, and the New task Follow-ups switch.
- **Automations:** optional automation navigation, list/editor, and GitHub automation links.
- **Variant comparison:** `/compare/:groupId`. Parallel variants are designed on New task, but comparing their results is not.
- **Plan review:** New task includes Plan first, but the resulting plan review/edit/start overlay has no dedicated frame.

## Controls absent from the shown layouts

| Surface | Current capability without a shown placement |
| --- | --- |
| Shared sidebar | Add project (open local folder / clone from GitHub); Tools diagnostics; installed-version/update indicator; theme shortcut; Active/Archived session switcher; pin/unpin and pinned-session grouping. |
| New task | Suggested-task starters and the optional Follow-ups switch. |
| Project tasks | Full resource-column table and saved column visibility/folding; Mark all read; inline rename and pin/unpin; the existing floating mobile New task button. Per-row resource disclosure and archive access are already designed. |
| All tasks | Group by; project-tag / Untagged filtering and counts; per-run read/unread, archive/unarchive and conflict-resolution actions. Project, Status and Workflow filters are already designed. |
| GitHub | Assigned to me shortcut; project-board filter; extra Clear filters and standalone refresh controls. The design shows a synced status but no separate refresh placement. |

## Entry points exist, but their detailed interfaces are not drawn

- **Task actions:** the reference has an ellipsis, but does not show its contents or the Notes/handoff reader, Open in/terminal chooser, copyable resume command, Finish, manual read/unread, pin, archive or delete confirmations. This is missing detail, not evidence that these actions should disappear.
- **GitHub PR detail:** Pull requests is a designed tab, but the supplied detail example is an issue. PR Conversation/Changes, checks/merge readiness, merge method/confirmation, requirements bypass and conflict resolution need detail states.
- **Project settings:** Agents (runner/account/model defaults and prompts), Agent config/MCP, Worktrees retention and Prompt templates editors are named in navigation but have no interior frames. General is designed. Bookmarklets are covered by the Skills extras.
- **Global settings:** Notifications, Resources, Skills update preferences, Agent accounts/authentication and Projects management are named, but their section interiors are not drawn. Appearance has the separate density/reading-width guide.
- **Workflow editing dialogs:** Import/Add step/Delete have entry points; their expanded dialogs are not shown. Workflow Auto and mobile Move up/Move down ARE designed.

## Already designed — do not classify as gaps

The GitHub Hand this to the agent form is fully specified in frames 9A–9D: prompt, Template, Workflow, Skills/chips, Model, Runner, Effort, Agent account, and Start task. The earlier worker inventory claiming this was absent was incorrect. Session continuation controls, expanded activity, Skills detail/Manage skills/Run from GitHub, task resources, archive tabs, and the appearance defaults also have references.

## Separate implementation/data gaps

These are not missing designs: the session composer/header and GitHub form still need structural implementation work; task-list refinements remain unfinished. All tasks has a designed Project filter that the current implementation lacks. Its Changes/token presentation also requires data the current global run index does not supply. No API was widened and no values were fabricated.

## Pause state

No work from this session was pushed; existing PR #227 remains unchanged at `8c6f0a52`. No new PR was opened. The commit that omitted sidebar extras/suggested tasks and changed their tests was reverted. Unfinished worker patches and a workflow WIP stash are retained separately and are not accepted or verified for integration. Resume after the revised `design.pen`; preserve functional expectations, verify the complete implementation, then draft a new PR.
