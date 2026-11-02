# Limit the sidebar without hiding main-list tasks

A repository owner needs a short sidebar while keeping the full task list available. They can set a project-specific limit, correct an invalid value, or remove the limit with Unlimited.

## Identity

Nobody is signed in. The cockpit runs locally without accounts.

## Page

Sam Reed starts on the Sidebar settings page for cedar-tools at `/p/cedar-tools/settings/sidebar`.

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

- Overall limits must be positive whole numbers unless Unlimited is selected.
- An invalid value shows a reason and disables Save sidebar limits.
- A saved limit caps the project's sidebar task rows.
- A shortened sidebar states how many rows it shows out of the full total.
- The main Project tasks list keeps all tasks regardless of the sidebar limit.
- Each project has its own sidebar limits.
- Unlimited removes the overall limit.
- Saved limits survive a page reload.

## Behavior

1. Sam enters "0" in "Overall"; the app refuses this limit because it must be a positive whole number or Unlimited.
2. Sam corrects "Overall" to "2".
3. Sam saves the limit with "Save sidebar limits".
4. Sam views the Project tasks page for "cedar-tools".
5. Sam reloads the Project tasks page with the limit of "2".
6. Sam views the Sidebar settings page for "river-docs".
7. Sam returns to the Sidebar settings page for "cedar-tools".
8. Sam selects "Overall Unlimited".
9. Sam saves Unlimited with "Save sidebar limits".
10. Sam returns to the Project tasks page for "cedar-tools".
11. Sam leaves and later comes back to that Project tasks page by reloading it.

## Acceptance criteria

All criteria are mandatory. Each asks about one thing the user can see.

### Before Sam enters anything

- **AC1:** Before Sam enters anything, does "Overall" show "10"?
- **AC2:** Before Sam enters anything, is "Overall Unlimited" unchecked?
- **AC3:** Before Sam enters anything, is "Finished Unlimited" checked?

### When Sam enters 0 in Overall

- **AC4:** When Sam enters "0" in "Overall", does the app show "Enter a positive whole number or choose Unlimited."?
- **AC5:** When Sam enters "0" in "Overall", is "Save sidebar limits" disabled?

### After Sam corrects Overall to 2

- **AC6:** After Sam corrects "Overall" to "2", is "Save sidebar limits" enabled?

### After Sam saves the limit

- **AC7:** After Sam saves the limit, does the app show "Sidebar limits saved."?

### After Sam views Project tasks for cedar-tools

- **AC8:** After Sam views Project tasks for "cedar-tools", is "Review invoice totals" visible in the sidebar's task list?
- **AC9:** After Sam views Project tasks for "cedar-tools", is "Audit invoice export" visible in the sidebar's task list?
- **AC10:** After Sam views Project tasks for "cedar-tools", is "Polish settings labels" absent from the sidebar's task list?
- **AC11:** After Sam views Project tasks for "cedar-tools", does the sidebar offer "2 of 3"?
- **AC12:** After Sam views Project tasks for "cedar-tools", is "Polish settings labels" visible in the main task list?
- **AC13:** After Sam views Project tasks for "cedar-tools", does the main results count say "3 tasks"?
- **AC14:** After Sam views Project tasks for "cedar-tools", is "Archive invoice prototype" absent from the main task list?

### After Sam reloads Project tasks with the limit of 2

- **AC15:** After Sam reloads Project tasks with the limit of "2", does the sidebar offer "2 of 3"?

### After Sam views Sidebar settings for river-docs

- **AC16:** After Sam views Sidebar settings for "river-docs", does "Overall" show "10"?

### After Sam returns to Sidebar settings for cedar-tools

- **AC17:** After Sam returns to Sidebar settings for "cedar-tools", does "Overall" show "2"?

### After Sam selects Overall Unlimited

- **AC18:** After Sam selects "Overall Unlimited", is the "Overall" number field disabled?

### After Sam comes back to Project tasks by reloading it

- **AC19:** After Sam comes back to Project tasks by reloading it, is "Polish settings labels" visible in the sidebar's task list?
- **AC20:** After Sam comes back to Project tasks by reloading it, does the main results count say "3 tasks"?
