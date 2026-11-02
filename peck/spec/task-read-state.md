# Mark a finished task read or unread

A repository owner needs to distinguish reviewed work from finished work that needs attention. They can mark a task read without opening its conversation, or mark it unread to return it to their attention.

## Identity

Nobody is signed in. The cockpit runs locally without accounts.

## Page

Sam Reed starts on the All tasks page at `/tasks`.

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

- An unread completed task has an unread marker beside its title.
- Opening a row's resource details reveals its read or unread action.
- Marking a task read removes its unread marker.
- Marking it unread restores the marker.
- A cancelled task has no read or unread action.
- Read choices survive a page reload.
- Read choices do not remove tasks from the list.
- All criteria refer to the main All tasks results, separate from sidebar links.

## Behavior

1. Sam reveals the actions for "Audit invoice export" with "Show resources for Audit invoice export".
2. Sam marks "Audit invoice export" read with "Mark Audit invoice export read".
3. Sam reloads the list after marking "Audit invoice export" read.
4. Sam reveals the saved read action for "Audit invoice export" with "Show resources for Audit invoice export".
5. Sam marks "Audit invoice export" unread with "Mark Audit invoice export unread".
6. Sam reveals the actions for "Polish settings labels" with "Show resources for Polish settings labels".
7. Sam leaves and later comes back to the All tasks page by reloading it.

## Acceptance criteria

All criteria are mandatory. Each asks about one thing the user can see.

### Before Sam reveals any actions

- **AC1:** Before Sam reveals any actions, does the row for "Audit invoice export" show an "unread" marker?
- **AC2:** Before Sam reveals any actions, does the row for "Review invoice totals" show an "unread" marker?
- **AC3:** Before Sam reveals any actions, does the row for "Polish settings labels" have no "unread" marker?
- **AC4:** Before Sam reveals any actions, is "Archive invoice prototype" absent from the main results?

### After Sam reveals the actions for Audit invoice export

- **AC5:** After Sam reveals the actions for "Audit invoice export", is "Mark Audit invoice export read" visible?

### After Sam marks Audit invoice export read

- **AC6:** After Sam marks "Audit invoice export" read, does its row have no "unread" marker?
- **AC7:** After Sam marks "Audit invoice export" read, is "Mark Audit invoice export unread" visible?
- **AC8:** After Sam marks "Audit invoice export" read, does "Review invoice totals" have an "unread" marker?
- **AC9:** After Sam marks "Audit invoice export" read, does the main results caption say "4 of 5"?

### After Sam reloads the list after marking Audit invoice export read

- **AC10:** After Sam reloads the list after marking "Audit invoice export" read, does its row have no "unread" marker?

### After Sam reveals the saved read action for Audit invoice export

- **AC11:** After Sam reveals the saved read action for "Audit invoice export", is "Mark Audit invoice export unread" visible?

### After Sam marks Audit invoice export unread

- **AC12:** After Sam marks "Audit invoice export" unread, does its row show an "unread" marker?
- **AC13:** After Sam marks "Audit invoice export" unread, is "Mark Audit invoice export read" visible?

### After Sam reveals the actions for Polish settings labels

- **AC14:** After Sam reveals the actions for "Polish settings labels", is the "Mark Polish settings labels read" control absent from its row?
- **AC15:** After Sam reveals the actions for "Polish settings labels", is the "Mark Polish settings labels unread" control absent from its row?

### After Sam comes back to All tasks by reloading it

- **AC16:** After Sam comes back to All tasks by reloading it, does "Audit invoice export" have an "unread" marker?
- **AC17:** After Sam comes back to All tasks by reloading it, does "Review invoice totals" have an "unread" marker?
- **AC18:** After Sam comes back to All tasks by reloading it, does the main results caption say "4 of 5"?
