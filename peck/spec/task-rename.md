# Rename a task without changing its request

A repository owner needs clear titles to find completed work. They can edit a task title, cancel a draft, or save a new name while keeping the original request available on the task page.

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

- A task row offers Rename task.
- The title editor starts with the task's current title.
- The editor offers Save and Cancel.
- Cancelling a draft keeps the saved title.
- Saving a title changes the task's name in the list and on its task page.
- The original request appears under Your message on the task page.
- A saved title survives a page reload.
- Criteria about task rows refer to the main Project tasks list, separate from the sidebar.

## Behavior

1. Sam begins renaming "Audit invoice export" in the main "Active" task list without saving a change.
2. Sam changes the "Task title" draft to "Draft export audit" without leaving the field.
3. Sam discards the draft with "Cancel rename".
4. Sam renames "Audit invoice export" to "Invoice export audit" in the main task list and saves it with "Save title".
5. Sam opens "Invoice export audit" to read its original request.
6. Sam returns to the Project tasks page for "cedar-tools".
7. Sam leaves and later comes back to the "Active" task list by reloading it.

## Acceptance criteria

All criteria are mandatory. Each asks about one thing the user can see.

### Before Sam begins renaming anything

- **AC1:** Before Sam begins renaming anything, is "Audit invoice export" visible in the main task list?
- **AC2:** Before Sam begins renaming anything, is "Review invoice totals" visible in the main task list?
- **AC3:** Before Sam begins renaming anything, is "Archive invoice prototype" absent from the main task list?
- **AC4:** Before Sam begins renaming anything, is "Invoice partner migration" absent from the main task list?

### After Sam begins renaming Audit invoice export

- **AC5:** After Sam begins renaming "Audit invoice export", does the "Task title" field contain "Audit invoice export"?
- **AC6:** After Sam begins renaming "Audit invoice export", does the editor offer the "Save title" button?
- **AC7:** After Sam begins renaming "Audit invoice export", does the editor offer the "Cancel rename" button?

### After Sam changes the Task title draft

- **AC8:** After Sam changes the "Task title" draft to "Draft export audit", does the field contain "Draft export audit"?

### After Sam discards the draft with Cancel rename

- **AC9:** After Sam discards the draft with "Cancel rename", is "Audit invoice export" visible as a task title in the main list?
- **AC10:** After Sam discards the draft with "Cancel rename", is "Draft export audit" absent from the main list?
- **AC11:** After Sam discards the draft with "Cancel rename", is the "Task title" field absent from the main list?

### After Sam renames Audit invoice export and saves it

- **AC12:** After Sam renames "Audit invoice export" to "Invoice export audit" and saves it, is "Invoice export audit" visible as a task title in the main list?
- **AC13:** After Sam renames "Audit invoice export" to "Invoice export audit" and saves it, is the title "Audit invoice export" absent from the main list?
- **AC14:** After Sam renames "Audit invoice export" to "Invoice export audit" and saves it, is "Review invoice totals" visible in the main list?
- **AC15:** After Sam renames "Audit invoice export" to "Invoice export audit" and saves it, does the main results count say "3 tasks"?

### After Sam opens Invoice export audit

- **AC16:** After Sam opens "Invoice export audit", does the task page heading say "Invoice export audit"?
- **AC17:** After Sam opens "Invoice export audit", does "Your message" show the original request "Audit invoice export"?

### After Sam comes back to the Active task list by reloading it

- **AC18:** After Sam comes back to the "Active" task list by reloading it, is "Invoice export audit" visible in the main results?
- **AC19:** After Sam comes back to the "Active" task list by reloading it, is the title "Audit invoice export" absent from the main results?
- **AC20:** After Sam comes back to the "Active" task list by reloading it, does the main results count say "3 tasks"?
