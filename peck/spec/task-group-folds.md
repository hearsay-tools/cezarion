# Fold task groups without hiding search matches

A repository owner needs to shorten a task list without removing tasks. They can fold a status group, search within it, and restore the full list while the browser remembers their fold choice.

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

- Task groups start expanded in a fresh browser.
- Collapse groups hides the main task rows while keeping the group heading and task count visible.
- Main-list group folds do not fold the sidebar's task list.
- A search temporarily reveals matching tasks inside a folded group.
- Clearing the search returns the group to its saved folded state.
- Expand groups restores the task rows.
- Fold choices survive a page reload.
- Criteria about rows refer to the main task list unless they explicitly name the sidebar.

## Behavior

1. Sam folds the main task groups with "Collapse groups".
2. Sam reloads the Project tasks page with its main task groups folded.
3. Sam searches the "Active" task list for "Audit invoice export" using "Search tasks".
4. Sam clears "Search tasks" to "".
5. Sam unfolds the main task groups with "Expand groups".
6. Sam leaves and later comes back to the Project tasks page by reloading it.

## Acceptance criteria

All criteria are mandatory. Each asks about one thing the user can see.

### Before Sam folds any groups

- **AC1:** Before Sam folds any groups, does the main "Finished 3" group show its task rows?
- **AC2:** Before Sam folds any groups, is "Review invoice totals" visible in the main task list?
- **AC3:** Before Sam folds any groups, is "Archive invoice prototype" absent from the main task list?
- **AC4:** Before Sam folds any groups, is "Invoice partner migration" absent from the main task list?

### After Sam folds the main task groups

- **AC5:** After Sam folds the main task groups, is the main "Finished 3" group heading visible?
- **AC6:** After Sam folds the main task groups, is "Audit invoice export" absent from the main task rows?
- **AC7:** After Sam folds the main task groups, is "Review invoice totals" absent from the main task rows?
- **AC8:** After Sam folds the main task groups, is "Polish settings labels" absent from the main task rows?
- **AC9:** After Sam folds the main task groups, does the main results count say "3 tasks"?
- **AC10:** After Sam folds the main task groups, is "Audit invoice export" visible in the sidebar's task list?

### After Sam reloads with the main task groups folded

- **AC11:** After Sam reloads with the main task groups folded, is "Audit invoice export" absent from the main task rows?

### After Sam searches for Audit invoice export

- **AC12:** After Sam searches for "Audit invoice export", is "Audit invoice export" visible in the main task rows?
- **AC13:** After Sam searches for "Audit invoice export", does the main results count say "1 task matching “Audit invoice export”"?

### After Sam clears Search tasks

- **AC14:** After Sam clears "Search tasks", is "Audit invoice export" absent from the main task rows?
- **AC15:** After Sam clears "Search tasks", is the main "Finished 3" group heading visible?

### After Sam unfolds the main task groups

- **AC16:** After Sam unfolds the main task groups, is "Audit invoice export" visible in the main task rows?
- **AC17:** After Sam unfolds the main task groups, is "Polish settings labels" visible in the main task rows?

### After Sam comes back to Project tasks by reloading it

- **AC18:** After Sam comes back to Project tasks by reloading it, is "Review invoice totals" visible in the main task rows?
