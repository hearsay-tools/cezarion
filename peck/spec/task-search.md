# Find tasks in one project

A repository owner needs to find finished work without mixing it with another project's tasks. The Project tasks page lets them search the Active list, recover from an empty result, and view archived work separately.

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

- The main Project tasks results contain tasks from the selected project.
- Active contains unarchived tasks, including finished and cancelled tasks.
- Archived contains archived tasks.
- Search ignores letter case and narrows the selected list.
- The results show a count of matching tasks.
- An empty result explains which search found nothing and offers Show all tasks.
- The sidebar has its own task list; criteria about results refer to the main Project tasks list.

## Behavior

1. Sam searches the "Active" task list for "INVOICE" using "Search tasks".
2. Sam replaces the search with "no-such-task".
3. Sam restores the unfiltered task list with "Show all tasks".
4. Sam views the "Archived" task list for "cedar-tools".

## Acceptance criteria

All criteria are mandatory. Each asks about one thing the user can see.

### Before Sam searches anything

- **AC1:** Before Sam searches anything, is the main heading "Project tasks" visible?
- **AC2:** Before Sam searches anything, does the main results count say "3 tasks"?
- **AC3:** Before Sam searches anything, is "Audit invoice export" visible in the main task list?
- **AC4:** Before Sam searches anything, is "Archive invoice prototype" absent from the main task list?
- **AC5:** Before Sam searches anything, is "Invoice partner migration" absent from the main task list?

### After Sam searches the Active task list for INVOICE

- **AC6:** After Sam searches the "Active" task list for "INVOICE", is "Audit invoice export" visible in the main results?
- **AC7:** After Sam searches the "Active" task list for "INVOICE", is "Review invoice totals" visible in the main results?
- **AC8:** After Sam searches the "Active" task list for "INVOICE", is "Polish settings labels" absent from the main results?
- **AC9:** After Sam searches the "Active" task list for "INVOICE", is "Archive invoice prototype" absent from the main results?
- **AC10:** After Sam searches the "Active" task list for "INVOICE", is "Invoice partner migration" absent from the main results?
- **AC11:** After Sam searches the "Active" task list for "INVOICE", does the main results count say "2 tasks matching “INVOICE”"?

### After Sam replaces the search with no-such-task

- **AC12:** After Sam replaces the search with "no-such-task", is the heading "No matching tasks" visible?
- **AC13:** After Sam replaces the search with "no-such-task", does the page say "No tasks match “no-such-task”."?
- **AC14:** After Sam replaces the search with "no-such-task", are there zero task rows in the main results?

### After Sam restores the unfiltered task list with Show all tasks

- **AC15:** After Sam restores the unfiltered task list with "Show all tasks", is the "Search tasks" field empty?
- **AC16:** After Sam restores the unfiltered task list with "Show all tasks", does the main results count say "3 tasks"?
- **AC17:** After Sam restores the unfiltered task list with "Show all tasks", is "Polish settings labels" visible in the main results?

### After Sam views the Archived task list

- **AC18:** After Sam views the "Archived" task list for "cedar-tools", is "Archive invoice prototype" visible in the main results?
- **AC19:** After Sam views the "Archived" task list for "cedar-tools", is "Audit invoice export" absent from the main results?
- **AC20:** After Sam views the "Archived" task list for "cedar-tools", does the main results count say "1 task"?
