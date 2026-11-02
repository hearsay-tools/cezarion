# Expand the desktop project rail

A repository owner needs to identify projects without losing space for their work. They can expand the project rail to read full names, then return to compact project marks while keeping the task sidebar available.

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

- The desktop project rail sits to the left of the task sidebar.
- Its compact form shows short project marks.
- Expanding the rail reveals full project names and the Cezarion wordmark.
- Expansion keeps the task sidebar at the same width and gives the main content less width.
- The rail, task sidebar, and main content remain beside each other without overlap.
- Expanding or collapsing the rail does not change the selected project's tasks.
- This browser remembers the rail's expanded or collapsed state after a reload.

## Behavior

1. Sam expands the project rail with "Expand projects".
2. Sam reloads the Project tasks page with the project rail expanded.
3. Sam collapses the project rail with "Collapse projects".
4. Sam leaves and later comes back to the Project tasks page by reloading it.

## Acceptance criteria

All criteria are mandatory. Each asks about one thing the user can see.

### Before Sam expands the project rail

- **AC1:** Before Sam expands the project rail, is the project mark "ct" visible in the rail?
- **AC2:** Before Sam expands the project rail, is the project mark "rd" visible in the rail?
- **AC3:** Before Sam expands the project rail, does the rail sit to the left of the task sidebar?
- **AC4:** Before Sam expands the project rail, is the "Expand projects" control visible?
- **AC5:** Before Sam expands the project rail, is "Audit invoice export" visible in the main task list?
- **AC6:** Before Sam expands the project rail, is "Invoice partner migration" absent from the main task list?

### After Sam expands the project rail

- **AC7:** After Sam expands the project rail, is the full project name "cedar-tools" visible in the rail?
- **AC8:** After Sam expands the project rail, is the full project name "river-docs" visible in the rail?
- **AC9:** After Sam expands the project rail, is the wordmark "Cezarion" visible at the top of the rail?
- **AC10:** After Sam expands the project rail, is the rail wider than before Sam expanded it?
- **AC11:** After Sam expands the project rail, is the task sidebar the same width as before Sam expanded the rail?
- **AC12:** After Sam expands the project rail, is the main content area narrower than before Sam expanded the rail?
- **AC13:** After Sam expands the project rail, is the full title "Audit invoice export" readable in the main task list?
- **AC14:** After Sam expands the project rail, is the "Collapse projects" control visible?

### After Sam reloads with the project rail expanded

- **AC15:** After Sam reloads with the project rail expanded, is the full project name "cedar-tools" visible in the rail?
- **AC16:** After Sam reloads with the project rail expanded, is the full project name "river-docs" visible in the rail?
- **AC17:** After Sam reloads with the project rail expanded, does the main content start to the right of the task sidebar without covering it?

### After Sam collapses the project rail

- **AC18:** After Sam collapses the project rail, is the rail narrower than its expanded form?
- **AC19:** After Sam collapses the project rail, is the project mark "ct" visible in the rail?

### After Sam comes back to Project tasks by reloading it

- **AC20:** After Sam comes back to Project tasks by reloading it, is the "Expand projects" control visible?
