# Archive and restore a finished task

Finished tasks can crowd a repository owner's task list. Archiving moves a task into a separate list, and restoring it puts it back in Active without starting the task again.

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

- A finished task's page offers Archive task.
- Archiving asks for confirmation and names the task that will move.
- Cancelling the confirmation keeps the task in Active.
- An archived task appears in Archived and is absent from the main Active list.
- An archived task's page offers Unarchive.
- Restoring a task returns it to Active.
- Archive choices survive a page reload.
- The main Project tasks list contains only the selected project's tasks; sidebar links are separate.

## Behavior

1. Sam opens "Audit invoice export" from the main task list.
2. Sam requests to archive "Audit invoice export" with "Archive task" on its task page, without confirming the request.
3. Sam cancels the archive request for "Audit invoice export".
4. Sam archives "Audit invoice export" with "Archive task" on its task page, confirming the request.
5. Sam views the "Active" task list on the Project tasks page for "cedar-tools".
6. Sam views the "Archived" task list for "cedar-tools".
7. Sam reloads the "Archived" task list.
8. Sam opens "Audit invoice export" from the main archived task list.
9. Sam restores "Audit invoice export" with "Unarchive".
10. Sam checks the "Archived" task list on the Project tasks page for "cedar-tools".
11. Sam switches to the "Active" task list for "cedar-tools".
12. Sam leaves and later comes back to the "Active" task list by reloading it.

## Acceptance criteria

All criteria are mandatory. Each asks about one thing the user can see.

### Before Sam opens anything

- **AC1:** Before Sam opens anything, is "Audit invoice export" visible in the main Active task list?
- **AC2:** Before Sam opens anything, is "Archive invoice prototype" absent from the main Active task list?

### After Sam opens Audit invoice export

- **AC3:** After Sam opens "Audit invoice export", is the "Archive task" control visible on its task page?

### After Sam requests to archive Audit invoice export without confirming

- **AC4:** After Sam requests to archive "Audit invoice export" without confirming, is the dialog heading "Archive task?" visible?
- **AC5:** After Sam requests to archive "Audit invoice export" without confirming, does the dialog say "Move “Audit invoice export” out of Active tasks. You can restore it from Archived."?

### After Sam cancels the archive request

- **AC6:** After Sam cancels the archive request for "Audit invoice export", is the "Archive task?" dialog absent?
- **AC7:** After Sam cancels the archive request for "Audit invoice export", does its task page offer "Archive task"?

### After Sam archives Audit invoice export and confirms

- **AC8:** After Sam archives "Audit invoice export" and confirms the request, does its task page offer "Unarchive"?

### After Sam views the Active task list

- **AC9:** After Sam views the "Active" task list for "cedar-tools", is "Audit invoice export" absent from the main results?
- **AC10:** After Sam views the "Active" task list for "cedar-tools", does the main results count say "2 tasks"?

### After Sam views the Archived task list

- **AC11:** After Sam views the "Archived" task list for "cedar-tools", is "Audit invoice export" visible in the main results?
- **AC12:** After Sam views the "Archived" task list for "cedar-tools", is "Archive invoice prototype" visible in the main results?
- **AC13:** After Sam views the "Archived" task list for "cedar-tools", does the main results count say "2 tasks"?
- **AC14:** After Sam views the "Archived" task list for "cedar-tools", is "Invoice partner migration" absent from the main results?

### After Sam reloads the Archived task list

- **AC15:** After Sam reloads the "Archived" task list, is "Audit invoice export" visible in the main results?

### After Sam restores Audit invoice export with Unarchive

- **AC16:** After Sam restores "Audit invoice export" with "Unarchive", does its task page offer "Archive task"?

### After Sam checks the Archived task list

- **AC17:** After Sam checks the "Archived" task list for "cedar-tools", is "Audit invoice export" absent from the main results?
- **AC18:** After Sam checks the "Archived" task list for "cedar-tools", does the main results count say "1 task"?

### After Sam comes back to the Active task list by reloading it

- **AC19:** After Sam comes back to the "Active" task list by reloading it, is "Audit invoice export" visible in the main results?
- **AC20:** After Sam comes back to the "Active" task list by reloading it, does the main results count say "3 tasks"?
