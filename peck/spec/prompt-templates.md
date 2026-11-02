# Save reusable prompt templates

A repository owner needs to reuse clear instructions across tasks. They can add a template, save it for later, and remove it without changing another project's templates.

## Identity

Nobody is signed in. The cockpit runs locally without accounts.

## Page

Sam Reed starts on the Prompt templates settings page for cedar-tools at `/p/cedar-tools/settings/prompt-templates`.

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

### Prompt templates

| Label | Project | Text |
|-------|---------|------|
| Review security | cedar-tools | Check input validation and access boundaries. |
| Explain changes | cedar-tools | Describe the user-visible changes. |
| Translate release notes | river-docs | Translate the release notes into French. |

## Visible

- The editor lists only the selected project's templates.
- A new template needs both a label and instruction text before Add template is enabled.
- Adding a template creates an editable draft row and clears the new-template fields.
- Save persists the draft list.
- An empty instruction field shows a reason and disables Save.
- Reloading discards an unsaved invalid draft.
- Delete template removes a row from the draft list; Save persists that removal.
- Saved templates and removals survive a page reload.

## Behavior

1. Sam enters "Check accessibility" in "New template label" without entering instruction text; the app refuses to add it because both fields are required.
2. Sam enters "Check keyboard focus and field labels." in "New template text".
3. Sam adds "Check accessibility" with "Add template".
4. Sam saves the template list with "Save".
5. Sam reloads Prompt templates after saving "Check accessibility".
6. Sam tries to save "Check accessibility" with empty text "" in "Text for Check accessibility"; the app refuses because every template needs instruction text.
7. Sam reloads Prompt templates to discard the invalid text draft.
8. Sam removes "Check accessibility" with "Delete template" in that template's row.
9. Sam saves the removal with "Save".
10. Sam leaves and later comes back to Prompt templates by reloading it.

## Acceptance criteria

All criteria are mandatory. Each asks about one thing the user can see.

### Before Sam enters anything

- **AC1:** Before Sam enters anything, does "Label for Review security" contain "Review security"?
- **AC2:** Before Sam enters anything, does "Text for Review security" contain "Check input validation and access boundaries."?
- **AC3:** Before Sam enters anything, is a template row named "Translate release notes" absent?

### When Sam enters Check accessibility without instruction text

- **AC4:** When Sam enters "Check accessibility" without instruction text, is "Add template" disabled?

### After Sam enters the new instruction text

- **AC5:** After Sam enters "Check keyboard focus and field labels." in "New template text", is "Add template" enabled?

### After Sam adds Check accessibility

- **AC6:** After Sam adds "Check accessibility", does "Label for Check accessibility" contain "Check accessibility"?
- **AC7:** After Sam adds "Check accessibility", does "Text for Check accessibility" contain "Check keyboard focus and field labels."?
- **AC8:** After Sam adds "Check accessibility", is "New template label" empty?
- **AC9:** After Sam adds "Check accessibility", is "New template text" empty?

### After Sam saves the template list

- **AC10:** After Sam saves the template list, does the app show "Prompt templates saved"?

### After Sam reloads after saving Check accessibility

- **AC11:** After Sam reloads after saving "Check accessibility", does "Text for Check accessibility" contain "Check keyboard focus and field labels."?
- **AC12:** After Sam reloads after saving "Check accessibility", does "Label for Explain changes" contain "Explain changes"?

### When Sam tries to save Check accessibility with empty text

- **AC13:** When Sam tries to save "Check accessibility" with empty text, does the app show "Every template needs both a label and text."?
- **AC14:** When Sam tries to save "Check accessibility" with empty text, is "Save" disabled?

### After Sam reloads to discard the invalid text draft

- **AC15:** After Sam reloads to discard the invalid text draft, does "Text for Check accessibility" contain "Check keyboard focus and field labels."?

### After Sam removes Check accessibility

- **AC16:** After Sam removes "Check accessibility", is its template row absent?
- **AC17:** After Sam removes "Check accessibility", is "Save" enabled?

### After Sam comes back to Prompt templates by reloading it

- **AC18:** After Sam comes back to Prompt templates by reloading it, is the template row named "Check accessibility" absent?
- **AC19:** After Sam comes back to Prompt templates by reloading it, does "Text for Review security" contain "Check input validation and access boundaries."?
- **AC20:** After Sam comes back to Prompt templates by reloading it, is "Save" disabled?
