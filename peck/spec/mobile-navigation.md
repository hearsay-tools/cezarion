# Navigate between projects and tasks on a phone

A repository owner needs to review tasks on a narrow screen. Phone navigation gives them stacked task cards, a bottom menu for other views, and a project drawer while leaving room to read an individual task.

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

- On a phone, the main task list uses vertically stacked cards.
- The task search field is available on the list page.
- The Views bar sits at the bottom of the list page.
- New task sits above the Views bar.
- More opens a bottom sheet with Skills, Workflows, and Project settings.
- The project drawer opens from the left and leaves a visible strip for dismissal on the right.
- Selecting another project closes the drawer and shows that project's tasks.
- An individual task page offers Back and hides the Views bar and floating New task link.
- Back returns to the selected project's task list.
- The selected project's list can be reloaded directly.

## Behavior

1. Sam opens "More" from the bottom Views bar.
2. Sam dismisses "More" with "Escape".
3. Sam opens the project drawer with "Switch project: cedar-tools".
4. Sam selects "river-docs" in the project drawer.
5. Sam opens "Invoice partner migration" from its main task card.
6. Sam returns to the task list with "Back".
7. Sam leaves and later comes back to the task list for "river-docs" by reloading it.

## Acceptance criteria

All criteria are mandatory. Each asks about one thing the user can see.

### Before Sam opens More

- **AC1:** Before Sam opens "More", do the main task cards form one vertical column?
- **AC2:** Before Sam opens "More", is the "Search tasks" field visible?
- **AC3:** Before Sam opens "More", does the Views bar sit at the bottom of the phone screen?
- **AC4:** Before Sam opens "More", does the floating "New task" link sit above the Views bar without overlapping it?
- **AC5:** Before Sam opens "More", is "Archive invoice prototype" absent from the main task cards?

### After Sam opens More

- **AC6:** After Sam opens "More", does its sheet meet the bottom edge of the phone screen?
- **AC7:** After Sam opens "More", is "Skills" above "Workflows" in the sheet?
- **AC8:** After Sam opens "More", is "Workflows" above "Project settings" in the sheet?

### After Sam opens the project drawer

- **AC9:** After Sam opens the project drawer, does it meet the left edge of the phone screen?
- **AC10:** After Sam opens the project drawer, is a strip of the dimmed page visible to its right?

### After Sam selects river-docs

- **AC11:** After Sam selects "river-docs", is the "Navigation" dialog absent?
- **AC12:** After Sam selects "river-docs", is "Invoice partner migration" visible in the main task cards?
- **AC13:** After Sam selects "river-docs", is "Audit invoice export" absent from the main task cards?

### After Sam opens Invoice partner migration

- **AC14:** After Sam opens "Invoice partner migration", is the "Back" control visible at the top of the task page?
- **AC15:** After Sam opens "Invoice partner migration", is the bottom Views bar absent?
- **AC16:** After Sam opens "Invoice partner migration", is the floating "New task" link absent?

### After Sam returns with Back

- **AC17:** After Sam returns with "Back", is "Invoice partner migration" visible in the main task cards?
- **AC18:** After Sam returns with "Back", is the bottom Views bar visible?

### After Sam comes back to river-docs by reloading it

- **AC19:** After Sam comes back to "river-docs" by reloading it, is "Invoice partner migration" visible in the main task cards?
- **AC20:** After Sam comes back to "river-docs" by reloading it, is "Audit invoice export" absent from the main task cards?
