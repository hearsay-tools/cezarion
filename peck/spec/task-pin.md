# Keep selected tasks at the top of the list

A repository owner needs to keep selected tasks easy to find among finished work. Pinning moves a task above unpinned tasks in its group, and removing the pin restores the normal order.

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

- The main Active list groups finished and cancelled tasks under Finished.
- Each unarchived task row offers Pin task when the pointer or keyboard focus reaches its controls.
- A pinned task row offers Unpin task.
- Pinned tasks appear above unpinned tasks within their group.
- Within each pin state, done tasks appear above cancelled tasks, and newer done tasks appear above older ones.
- Pinning preserves the task count and keeps the Project tasks page open.
- Pin choices survive a page reload.
- Criteria about task order and controls refer to the main list, separate from the sidebar.

## Behavior

1. Sam pins "Polish settings labels" in the main "Active" task list.
2. Sam reloads the Project tasks page to check the pinned position of "Polish settings labels".
3. Sam pins "Audit invoice export" in the main task list.
4. Sam removes the pin from "Audit invoice export" with "Unpin task" in its main task row.
5. Sam removes the pin from "Polish settings labels" with "Unpin task" in its main task row.
6. Sam leaves and later comes back to the "Active" task list by reloading it.

## Acceptance criteria

All criteria are mandatory. Each asks about one thing the user can see.

### Before Sam pins anything

- **AC1:** Before Sam pins anything, does "Review invoice totals" appear above "Audit invoice export" in the main Finished group?
- **AC2:** Before Sam pins anything, does "Audit invoice export" appear above "Polish settings labels" in the main Finished group?
- **AC3:** Before Sam pins anything, is "Archive invoice prototype" absent from the main task list?
- **AC4:** Before Sam pins anything, is "Invoice partner migration" absent from the main task list?

### After Sam pins Polish settings labels

- **AC5:** After Sam pins "Polish settings labels", does it appear above "Review invoice totals" in the main Finished group?
- **AC6:** After Sam pins "Polish settings labels", does its main task row offer "Unpin task"?
- **AC7:** After Sam pins "Polish settings labels", does the main results count say "3 tasks"?
- **AC8:** After Sam pins "Polish settings labels", is the main page heading "Project tasks" visible?

### After Sam reloads to check the pinned position of Polish settings labels

- **AC9:** After Sam reloads to check the pinned position of "Polish settings labels", does it appear above "Review invoice totals" in the main Finished group?
- **AC10:** After Sam reloads to check the pinned position of "Polish settings labels", does its main task row offer "Unpin task"?

### After Sam pins Audit invoice export

- **AC11:** After Sam pins "Audit invoice export", does it appear above "Polish settings labels" in the main Finished group?
- **AC12:** After Sam pins "Audit invoice export", does its main task row offer "Unpin task"?
- **AC13:** After Sam pins "Audit invoice export", does the main row for "Polish settings labels" offer "Unpin task"?

### After Sam removes the pin from Audit invoice export

- **AC14:** After Sam removes the pin from "Audit invoice export", does "Polish settings labels" appear above "Review invoice totals" in the main Finished group?
- **AC15:** After Sam removes the pin from "Audit invoice export", does its main task row offer "Pin task"?

### After Sam removes the pin from Polish settings labels

- **AC16:** After Sam removes the pin from "Polish settings labels", does "Review invoice totals" appear above "Audit invoice export" in the main Finished group?
- **AC17:** After Sam removes the pin from "Polish settings labels", does "Audit invoice export" appear above "Polish settings labels" in the main Finished group?

### After Sam comes back to the Active task list by reloading it

- **AC18:** After Sam comes back to the "Active" task list by reloading it, does "Polish settings labels" appear below "Audit invoice export" in the main Finished group?
- **AC19:** After Sam comes back to the "Active" task list by reloading it, does the main results count say "3 tasks"?
- **AC20:** After Sam comes back to the "Active" task list by reloading it, does "Review invoice totals" appear above "Audit invoice export" in the main Finished group?
