# Delete a finished task after confirmation

A repository owner needs to remove task history they do not want to keep. The task page names the task before permanent deletion and lets them cancel the request.

## Identity

Nobody is signed in. The cockpit runs locally without accounts.

## Page

Sam Reed starts on the Project tasks page for cedar-tools at `/p/cedar-tools`.

## Given

### People

| Name | Role |
|------|------|
| Sam Reed | Repository owner |

### Projects

| Name |
|------|
| cedar-tools |
| river-docs |

### Tasks

| Title | Project | Status | Archived | Created date | Created time |
|-------|---------|--------|----------|--------------|--------------|
| Audit invoice export | cedar-tools | done | false | 2026-10-01 | 09:00 |
| Review invoice totals | cedar-tools | done | false | 2026-10-01 | 10:00 |
| Polish settings labels | cedar-tools | cancelled | false | 2026-10-01 | 11:00 |
| Archive invoice prototype | cedar-tools | done | true | 2026-10-01 | 08:00 |
| Invoice partner migration | river-docs | done | false | 2026-10-01 | 12:00 |

## Visible

- A finished task's Run actions menu offers Delete task….
- The confirmation names the task and says deletion cannot be undone.
- Cancelling the confirmation keeps the task available.
- Confirming deletion removes the task from the main task list.
- Deleting one task does not remove other tasks or another project's tasks.
- The deletion survives a page reload.
- All task-list criteria refer to main results, separate from sidebar links.

## Behavior

1. Sam opens "Audit invoice export" from the main task list.
2. Sam requests deletion of "Audit invoice export" through "Run actions" and "Delete task…" on its task page, without confirming the request.
3. Sam cancels the deletion request with "Cancel".
4. Sam requests deletion of "Audit invoice export" again through "Run actions" and "Delete task…" on its task page.
5. Sam confirms deletion with "Delete task" inside the confirmation dialog.
6. Sam views the "Active" task list on the Project tasks page for "cedar-tools".
7. Sam views the "Archived" task list for "cedar-tools".
8. Sam views the Project tasks page for "river-docs".
9. Sam returns to the "Active" Project tasks list for "cedar-tools".
10. Sam leaves and later comes back to that "Active" list by reloading it.

## Acceptance criteria

All criteria are mandatory. Each asks about one thing the user can see.

### Before Sam opens anything

- **AC1:** Before Sam opens anything, is "Audit invoice export" visible in the main Active task list?
- **AC2:** Before Sam opens anything, is "Archive invoice prototype" absent from the main Active task list?

### After Sam opens Audit invoice export

- **AC3:** After Sam opens "Audit invoice export", does its task page heading say "Audit invoice export"?

### After Sam requests deletion without confirming

- **AC4:** After Sam requests deletion without confirming, is the dialog heading "Delete task permanently?" visible?
- **AC5:** After Sam requests deletion without confirming, does the dialog say "Delete “Audit invoice export” and its transcript, worktree and branch. This cannot be undone."?
- **AC6:** After Sam requests deletion without confirming, does the dialog offer "Cancel"?
- **AC7:** After Sam requests deletion without confirming, does the dialog offer "Delete task"?

### After Sam cancels the deletion request

- **AC8:** After Sam cancels the deletion request, is the "Delete task permanently?" dialog absent?
- **AC9:** After Sam cancels the deletion request, does the task page heading say "Audit invoice export"?

### After Sam requests deletion again

- **AC10:** After Sam requests deletion again, is the dialog heading "Delete task permanently?" visible?

### After Sam views the Active list for cedar-tools

- **AC11:** After Sam views the "Active" list for "cedar-tools", is "Audit invoice export" absent from the main results?
- **AC12:** After Sam views the "Active" list for "cedar-tools", is "Review invoice totals" visible in the main results?
- **AC13:** After Sam views the "Active" list for "cedar-tools", is "Polish settings labels" visible in the main results?
- **AC14:** After Sam views the "Active" list for "cedar-tools", does the main results count say "2 tasks"?

### After Sam views the Archived list for cedar-tools

- **AC15:** After Sam views the "Archived" list for "cedar-tools", is "Archive invoice prototype" visible in the main results?
- **AC16:** After Sam views the "Archived" list for "cedar-tools", does the main results count say "1 task"?

### After Sam views Project tasks for river-docs

- **AC17:** After Sam views Project tasks for "river-docs", is "Invoice partner migration" visible in the main results?
- **AC18:** After Sam views Project tasks for "river-docs", is "Audit invoice export" absent from the main results?

### After Sam comes back to the Active list by reloading it

- **AC19:** After Sam comes back to the "Active" list by reloading it, is "Audit invoice export" absent from the main results?
- **AC20:** After Sam comes back to the "Active" list by reloading it, does the main results count say "2 tasks"?
