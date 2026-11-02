# Filter tasks across projects

A repository owner needs to review work from several repositories in one place. Project and status filters narrow the workspace task list, and the selected view survives a page reload.

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

- All tasks includes active tasks from every registered project.
- Archived tasks are absent from the Active results.
- Project and status filters apply together.
- The results caption states the number shown out of all stored tasks, including archived tasks.
- Clear removes the selected filters.
- Filter choices survive a page reload.
- Criteria about task presence refer to the main All tasks results, separate from sidebar links.

## Behavior

1. Sam filters the main task results to "cedar-tools" with "Filter by project".
2. Sam also filters the results to "done" with "Filter by status".
3. Sam reloads the list filtered to "cedar-tools" and "done".
4. Sam removes both filters with "Clear (2)".
5. Sam filters the main results to "river-docs" with "Filter by project".
6. Sam leaves and later comes back to the list filtered to "river-docs" by reloading it.

## Acceptance criteria

All criteria are mandatory. Each asks about one thing the user can see.

### Before Sam filters anything

- **AC1:** Before Sam filters anything, does the main results caption say "4 of 5"?
- **AC2:** Before Sam filters anything, is "Invoice partner migration" visible in the main results?
- **AC3:** Before Sam filters anything, is "Archive invoice prototype" absent from the main results?

### After Sam filters to cedar-tools

- **AC4:** After Sam filters to "cedar-tools", does the main results caption say "3 of 5"?
- **AC5:** After Sam filters to "cedar-tools", is "Audit invoice export" visible in the main results?
- **AC6:** After Sam filters to "cedar-tools", is "Polish settings labels" visible in the main results?
- **AC7:** After Sam filters to "cedar-tools", is "Invoice partner migration" absent from the main results?

### After Sam also filters to done

- **AC8:** After Sam also filters to "done", does the main results caption say "2 of 5"?
- **AC9:** After Sam also filters to "done", is "Audit invoice export" visible in the main results?
- **AC10:** After Sam also filters to "done", is "Review invoice totals" visible in the main results?
- **AC11:** After Sam also filters to "done", is "Polish settings labels" absent from the main results?

### After Sam reloads the list filtered to cedar-tools and done

- **AC12:** After Sam reloads the list filtered to "cedar-tools" and "done", does the main results caption say "2 of 5"?
- **AC13:** After Sam reloads the list filtered to "cedar-tools" and "done", is "Invoice partner migration" absent from the main results?

### After Sam removes both filters

- **AC14:** After Sam removes both filters with "Clear (2)", does the main results caption say "4 of 5"?
- **AC15:** After Sam removes both filters with "Clear (2)", is "Invoice partner migration" visible in the main results?

### After Sam filters to river-docs

- **AC16:** After Sam filters to "river-docs", does the main results caption say "1 of 5"?
- **AC17:** After Sam filters to "river-docs", is "Invoice partner migration" visible in the main results?
- **AC18:** After Sam filters to "river-docs", is "Audit invoice export" absent from the main results?

### After Sam comes back to the list filtered to river-docs by reloading it

- **AC19:** After Sam comes back to the list filtered to "river-docs" by reloading it, does the main results caption say "1 of 5"?
- **AC20:** After Sam comes back to the list filtered to "river-docs" by reloading it, is "Invoice partner migration" visible in the main results?
