# Running Cezar for Peck

These specs cover the existing local cockpit. They do not require a human account, an AI provider account, GitHub, or a running agent. The user approved the Identity wording that describes local access without sign-in.

## Install and build

Use Linux or macOS, Node **24.21.0 or newer**, Git, and pnpm **12.11.2**. Chromium is needed by the verifier. Run all commands from the checkout root. Install dependencies once in a clean checkout:

```sh
pnpm install --frozen-lockfile
```

Build separately from starting a data run:

```sh
BUILD_ROOT="$PWD/.ai/qa/peck-build/cezar"
sh .ai/scripts/build-e2e.sh "$BUILD_ROOT"
```

This existing build script compiles the actual service and cockpit into an ignored directory. It links the installed dependencies and bundled mock runners. It builds the cockpit with `VITE_CEZ_E2E=1`, the repository's browser verification mode, which pins its display clock and background polling. The controls in these specs use their real app implementations. Allow up to three minutes for the build on a loaded host. Keep the checkout and its dependencies in place while this build runs.

## Fresh data

Give **each spec run** a new directory outside any `.ai/cezar/worktrees/` path. Do not serve the source checkout itself. The following commands create an isolated fixture for every supplied spec except `prompt-templates.md`:

```sh
RUN_ROOT="$(mktemp -d /tmp/cezar-peck-XXXXXX)"
node peck/seed.mjs peck/fixtures/project-tasks.json "$RUN_ROOT"
```

Twelve specs share the Given tables in `project-tasks.json`. For `prompt-templates.md`, use its own exact Given data instead:

```sh
RUN_ROOT="$(mktemp -d /tmp/cezar-peck-XXXXXX)"
node peck/seed.mjs peck/fixtures/prompt-templates.json "$RUN_ROOT"
```

Choose **one** fixture command per run. Do not load both into the same directory. For other Given rows, generate a JSON file from those rows and pass that file as the first argument to `seed.mjs`. The helper accepts JSON, not Markdown. Every cell must be a string, including `"true"` and `"false"`.

Each run has these separate stores:

- `$RUN_ROOT/home/config.json`: the workspace registry and preferences, selected through `CEZ_HOME`.
- `$RUN_ROOT/projects/cedar-tools/.ai/cezar/`: the selected project's run store.
- `$RUN_ROOT/projects/river-docs/.ai/cezar/`: the other project's run store.
- `$RUN_ROOT/tmp/`: process temporary files.

The helper refuses a nonempty destination. It creates two local Git repositories with a `main` branch and one commit each. Neither has a remote. Start with a fresh browser context and empty cookies, local storage and session storage for each spec. Use a **1440 × 900 desktop viewport**, except for `mobile-navigation.md`, which needs **390 × 844** before its first navigation and throughout its run. Keep default zoom and text scaling. Unfiltered result counts are hidden on phone layouts.

## Seed mapping

The JSON requires `people` and `projects` arrays. `tasks` and `prompt_templates` are optional arrays. Omitted `tasks` means no tasks. Table headings become lowercase keys; spaces become underscores in table and column names.

| Given table | Given key | App representation |
|-------------|-----------|--------------------|
| People | `name`, `role` | Narrative actor only. The app has no human identity or password model, so these rows do not create accounts. |
| Projects | `name` | Git directory name, workspace registry `id` and `name`, and `/p/<name>` route segment. The fixture names are lowercase slugs. |
| Tasks | `title` | Run `title` and original `task` text. No generated `titleSummary` replaces it. |
| Tasks | `project` | Selects the project's separate run store; must match one Projects name. |
| Tasks | `status` | Run `status`, exactly `done` or `cancelled` for these fixtures. Both are terminal states. |
| Tasks | `archived` | Run `archived`, converting the string `"true"` or `"false"` to a boolean. |
| Tasks | `created_date`, `created_time` | Run `createdAt`, joined as UTC with seconds `00`. |
| Prompt templates | `label` | Template `label`; the first-column seed key, unique within its project. |
| Prompt templates | `project` | Selects the project's separate `.ai/cezar/ui-state.json`; must match one Projects name. |
| Prompt templates | `text` | Template `text`, the reusable instructions shown in the editor. |

Task titles are the seed keys and must be unique within their project. The helper derives each run ID as `peck-` plus the first 20 hex characters of SHA-256 over `<project>`, a NUL byte, and `<title>`. It sets `workflow` to the built-in `quick-task`, `steps` to an empty array, and `tokensUsed` to zero. It sets `finishedAt` one minute after `createdAt`, and sets `archivedAt` to that finish time for an already archived task. Every task starts unpinned, using the app's default for an absent `pinned` field. There is no worktree, PR, transcript, automation, or pending question to seed. The helper omits `seenAt`, so active done tasks start unread. Cancelled tasks do not have a read state.

The helper writes the records to each project's `.ai/cezar/runs.json` before first boot. This is the app's existing legacy import path, also used by its browser fixtures. On first opening a project, the app imports it into `.ai/cezar/runs.db`. **After import, `runs.db` is authoritative**: editing `runs.json` does not reset the run. Create another fresh directory to reseed. Do not write into a live database.

When `prompt_templates` is supplied, the helper writes each project's `promptTemplates` array to that project's `.ai/cezar/ui-state.json` before boot. A template ID is `peck-` plus the first 20 SHA-256 hex characters of `<project>`, a NUL byte, and `<label>`. The helper seeds no skill assignments. A project with no matching rows gets an explicit empty array, which suppresses built-in templates. When the table is absent, the helper does not create `ui-state.json`; the app supplies its normal defaults. Prompt templates have no completion state, so that spec uses another project's template for exclusion and does not invent a final-state row.

The workspace registry includes both projects before boot, so the other-project exclusion is real. The terminal records cannot enter restart recovery as running tasks. No passwords, login requests, session cookies, or authentication stubs are required. Sam is the person operating the local browser.

## Start on the requested port

Choose an unused port; this example uses `4321`. Keep the same `BUILD_ROOT` and `RUN_ROOT` values established above:

```sh
PECK_PORT=4321
env -i \
  PATH="$PATH" HOME="$HOME" \
  TMPDIR="$RUN_ROOT/tmp" \
  CEZ_HOME="$RUN_ROOT/home" \
  CEZ_DRY_RUN=1 CEZ_PROJECT_WARMUP=0 CEZ_AUTOMATIONS=0 \
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
  GIT_CEILING_DIRECTORIES="$RUN_ROOT" \
  node "$BUILD_ROOT/dist/index.js" serve \
    --repo "$RUN_ROOT/projects/cedar-tools" \
    --port "$PECK_PORT" --no-open
```

Run this as a foreground process owned by the verifier's process supervisor. `env -i` keeps the parent task's Cezar controller settings, Git overrides, and provider credentials out of this fixture. `HOME` keeps its normal value; all Cezar workspace writes use the isolated `CEZ_HOME`.

Readiness: poll `http://127.0.0.1:<port>/api/v1/health` until it returns HTTP 200 and its JSON `bootProject` is `"cedar-tools"`. In the observed run, the service listened in about one second. Allow up to 60 seconds on a loaded host. Then open:

```text
http://127.0.0.1:<port>/p/cedar-tools
```

Open the path named in the spec's Page section. The supplied start paths are `/p/cedar-tools`, `/tasks`, `/p/cedar-tools/settings/sidebar`, `/p/cedar-tools/settings/prompt-templates`, and `/settings/global/appearance`. For Project tasks, wait for its heading and three main task rows. For All tasks, wait for its heading and four main task rows. For Sidebar settings, wait for the Overall field showing `10`. For Prompt templates, wait for the seeded `Review security` row. For Appearance, wait for the Theme, Density, and Reading width groups and the preview. Record the initial page only after those contents load. No install or build command is part of startup. For a given port, use the same origin spelling throughout; `localhost` and `127.0.0.1` have different browser storage.

## Drive and observe

Use the page's accessibility tree. The named controls are `Search tasks`, `Show all tasks`, `Active`, `Archived`, `Archive task`, `Cancel`, and `Unarchive`. The Active and Archived buttons include their counts, such as `Active · 3` and `Archived · 1`.

For `task-rename.md`, use `Rename task` in the named main-list row. The editor's field is `Task title`. Its buttons show `Save` and `Cancel`, with accessible names `Save title` and `Cancel rename`. Keep focus in the title field while entering a draft: Enter or leaving the field saves it. Use the editor's Cancel button to discard the draft. The task-page header has a separate editor with no Save or Cancel buttons, so perform this spec's edits in the main list. Opening the renamed task shows its new heading and the unchanged original request in the `Your message` entry.

For `task-pin.md`, use `Pin task` or `Unpin task` within the named main-list row. Hover over the row or focus its controls with the keyboard to reveal an unpinned row's controls. A pinned row keeps its Unpin control visible. Wait for the row's updated control and position after each change. Read task order from top to bottom in the main `Finished` group. Pins do not create another group. With this fixture, unpinned rows start as `Review invoice totals`, `Audit invoice export`, then `Polish settings labels`. Pinning the cancelled task moves it ahead of the unpinned done tasks. If both it and `Audit invoice export` are pinned, the done task comes first within that pinned pair.

The sidebar repeats active task links. Criteria about task presence, absence and counts refer to the **main Project tasks results**, under the main heading, not the sidebar. On a task page, `Archive task` is visible beside the disabled reply composer. Requesting archive **with the task-page control** opens an `Archive task?` confirmation. Main-list and All tasks archive controls can act immediately; do not use those for the confirmation steps in `task-archive.md`. When a step says to confirm, confirm inside that dialog. `Unarchive` acts without a second confirmation.

For `workspace-task-filters.md`, open `/tasks`. Use `Filter by project` and `Filter by status`, then the named option in the popover. Options include a count: `cedar-tools 3`, `river-docs 1`, and, after selecting cedar-tools, `done 2`. Selecting an option keeps the popover open. Dismiss it with Escape or an outside click before using another control. The `Clear (2)` button clears both selected facets. Read the separate header caption (`4 of 5`, `3 of 5`, `2 of 5`, or `1 of 5`), not the origin-filter count. Its denominator includes archived tasks. Wait for URL changes before reloading.

For `task-read-state.md`, open `/tasks`. Each row has `Show resources for <title>`, which reveals its actions. Then use `Mark <title> read` or `Mark <title> unread`. The marker beside a task title has the accessible name `unread`. Do not open the task's conversation to inspect its marker: visiting that conversation marks the task read automatically. Resource details collapse on reload, so reveal them again when the next step needs the saved read action. Cancelled tasks have neither read action. Keep every marker assertion inside its named main-list row.

For `sidebar-limits.md`, the setting belongs to the selected project. Use the number field `Overall`, checkbox `Overall Unlimited`, and button `Save sidebar limits`. Entering `0` shows the inline reason and disables Save; there is no rejection dialog to dismiss. The `Finished Unlimited` checkbox starts checked. After saving `2`, return to the project's main task page to compare the sidebar with the main list. The sidebar then shows `2 of 3`. The other project's Overall value remains `10`. Unlimited disables the number field; save it before returning to the task list. Wait for `Sidebar limits saved.` after each save.

For `prompt-templates.md`, use `New template label`, `New template text`, and `Add template`. Existing row fields are `Label for <label>` and `Text for <label>`. Each row repeats `Delete template`; use the one in the row named by the step. `Save` persists the whole list. Wait for `Prompt templates saved` after each save. Empty new instruction text disables Add template; empty text in an existing row disables Save and shows `Every template needs both a label and text.`. A refused action with a disabled button needs no click. To clear the existing text, focus its field, select all, and press Backspace; wait for the inline reason before recording the refusal. Reloading discards that invalid draft. No task is submitted and no skills are assigned in this spec.

For `desktop-project-rail.md`, use **1440 × 900** with fresh browser storage. The rail starts collapsed. `Expand projects` and `Collapse projects` are its accessible button names; the expanded button visibly says `Collapse`. Full project names in the rail are separate from the current project name in the task sidebar. Wait for the rail animation and label fade to finish before recording each state. Keep the same viewport and sidebar width for comparisons. Expansion requires enough room for the main content; the prescribed viewport has that room. The browser saves the rail choice under `cez-project-rail-expanded`.

For `mobile-navigation.md`, set **390 × 844** before opening the Page URL. Read the visible phone controls; desktop navigation remains mounted but hidden. `More` in the bottom Views bar opens the More dialog. After Escape, wait for that sheet to close before using `Switch project: cedar-tools`. That button opens the Navigation drawer. Select the project link named `river-docs`; its accessible name also includes its current status. Wait for the drawer to close and the river-docs task card to load before recording the selection. Open `Invoice partner migration` from its main card. Use the task page's `Back` button to return to that list. The bottom Views bar and floating New task link appear on the list and are absent from the task page. Keep screenshots at the phone viewport; scroll only when needed to inspect a task below the visible portion of the list. Navigation drawers and sheets have entrance and exit animations.

For `task-group-folds.md`, use `Collapse groups` and `Expand groups` above the main task groups. The sidebar's identically named Finished group is independent. These are visibility controls: the main caption keeps its task count while rows are folded. A matching search reveals folded rows temporarily. To clear `Search tasks`, focus the field, select all, and press Backspace; wait for the query to leave the URL before recording the folded result. Folding is browser-local, under `cez-task-list-folds`, with separate entries for each project, list view, and group. Keep the same browser context for the reload steps.

For `task-delete.md`, open the named task first, then use `Run actions` and its `Delete task…` menu item. This opens the `Delete task permanently?` dialog. Step 2 leaves that dialog open; Cancel dismisses it. Step 4 opens it again; step 5 uses `Delete task` inside it. Wait for the dialog to close and navigation to finish before checking the main list. These seeded terminal tasks have no worktree, branch, or stored transcript, so the spec checks visible task deletion and project isolation. It does not assert filesystem cleanup. Each spec uses its own fixture, so deletion does not affect another scenario.

For `cockpit-appearance.md`, keep the desktop viewport fixed at **1440 × 900**, with a fresh browser context, default zoom, and normal text scaling. The default theme is Dark, density is Comfortable, and reading width is Narrow. Select the radios named `Light`, `Dark`, and `Compact` in their named groups; `Compact for real` is a separate option. These controls apply immediately, with no Save button. Theme is browser-local (`cez-theme` in local storage). Density and reading width are stored in the isolated workspace's `$RUN_ROOT/home/ui-state.json` and mirrored in browser storage.

**The visual specs require screenshots:** `cockpit-appearance.md`, `desktop-project-rail.md`, and `mobile-navigation.md`. Capture a viewport screenshot and the accessibility tree before step 1 and after every Behavior step. Keep each spec at its prescribed viewport. Keep the initial compact rail image for the rail-width and sidebar-width comparisons. For appearance, keep the initial Comfortable image and the Dark image before Compact for the spacing and text-size comparisons. Wait for fonts, the selected radio, and color transitions to settle before capture. An accessibility-tree-only verifier cannot judge color, spacing, or layout; it must report that capability gap instead of inferring them from radio state. Do not inject styles, set theme keys directly, or replace visible checks with CSS-class checks. Screenshots from the existing app show dark surfaces with light text, near-white surfaces with dark text, and settings navigation left of the main panel. The preview title keeps its text size when Compact reduces gaps. The specs do not prescribe RGB values, pixel positions, or relative ages.

Wait for each visible result before recording the page or taking the next action. In particular, wait for the confirmation dialog to leave the accessibility tree after Cancel or confirmation; its closing animation briefly hides the page behind it. Search renders immediately but writes its query into the URL after a debounce. Do not reload until the URL reflects the intended search, if testing a reload with a search.

Fresh browser storage keeps task groups open. If a reused browser has folded them, the page offers `Expand groups`; prefer a new context so the initial page matches the spec. Keep the task-origin filter on `All`. The task-origin buttons also show counts; those counts describe the selected list before search. Acceptance criteria use the separate results caption, such as `2 tasks matching “INVOICE”`.

## Stop and restart

None of the supplied specs requests a process restart. All except task-search reload browser pages to check persistence, including saved filters, settings, rail width, group folds, and task deletion. The mobile spec checks a direct reload of the selected project’s route.

For a process restart, send SIGINT to the supervised foreground process and wait for it to exit. Run the same Start command with the same `RUN_ROOT`, `BUILD_ROOT`, port and environment. Keep the existing data and browser context; do not run the seed helper again. The SQLite store holds archive choices, saved titles, pins, and read state. Project `ui-state.json` holds templates and sidebar limits. Workspace `ui-state.json` holds density. Browser storage holds theme, rail expansion, and task-group folds; keep that browser context for browser reload checks. To clean up, stop the process and close its browser context before deleting only that run's temporary directory.

## Needs and sources of variation

- No mail, payment, database server, provider key, or GitHub service is needed. SQLite ships with the required Node version. Missing `gh` produces an availability hint and does not block these features.
- `CEZ_DRY_RUN=1` selects bundled mock runners. These specs never submit a new task or resume a task. All seeded tasks are terminal. The prompt-template fixture has no tasks.
- `CEZ_PROJECT_WARMUP=0` keeps other-project startup lazy. The second project is registered and has its own seeded store; warming it is not necessary for the selected project's list.
- `CEZ_AUTOMATIONS=0` keeps the automation scheduler off. There are no seeded schedules, timers, live sessions or webhooks.
- The repositories have no remotes. GitHub refreshes and merge checks have no work to do. Normal optional catalog/update checks are outside these criteria; no external response is needed for any of these thirteen features.
- Seed timestamps are fixed UTC dates. The browser verification build pins its display clock. Do not assert relative ages or localized time strings; the specs do not depend on them.
- The server binds to loopback. A browser in a separate container needs access to that same loopback listener, or both processes must run in the same network namespace. No authentication token is needed on the local listener.
- Keep each run on its own port and `RUN_ROOT`. Do not share the workspace registry, SQLite files, browser context, or fixture Git directories between runs.

## Verification performed

On 2026-11-02, all thirteen scenarios were walked in headless Chromium through `agent-browser` 0.40.0, using this seed helper and the repository's browser verification build. Each scenario used a fresh data directory and browser session. The criteria matched the recorded accessibility trees and, for the three visual specs, screenshots:

| Spec | Criteria | Checked behavior |
|------|----------|------------------|
| `task-search.md` | 20 | Uppercase query, exact empty-state copy, reset, and separate archived list. |
| `task-archive.md` | 20 | Cancellation, confirmation, Active and Archived counts, reload after archiving, restoration, and reload after restoration. |
| `task-rename.md` | 20 | Initial editor value, draft cancellation, saved title, unchanged original request, task count, and reload after saving. |
| `task-pin.md` | 20 | Initial order, pinning across terminal statuses, two pinned tasks, removing each pin, task count, and reload with and without a pin. |
| `workspace-task-filters.md` | 20 | Combined project/status filters, counts, project exclusion, Clear, and reload. |
| `task-read-state.md` | 18 | Row action reveal, read/unread markers, cancelled-task exclusion, unchanged counts, and reload. |
| `sidebar-limits.md` | 20 | Invalid zero, saved cap, sidebar/main-list difference, project isolation, Unlimited, and reload. |
| `prompt-templates.md` | 20 | Add, save, empty-text refusal, discard invalid draft, delete, project exclusion, and reload. |
| `cockpit-appearance.md` | 20 | Dark/light colors, selected radios, preview readability, left navigation, tighter spacing with unchanged title size, and reload. |
| `desktop-project-rail.md` | 20 | Project marks and full names, wider rail, unchanged sidebar width, narrower main content, no overlap, and reload in both states. |
| `mobile-navigation.md` | 20 | Stacked cards, fixed bottom bar, floating New task, bottom sheet order, left drawer, project switch, task-page Back, and reload. |
| `task-group-folds.md` | 18 | Folded rows with unchanged count, separate sidebar, temporary search reveal, clear, expand, and reload. |
| `task-delete.md` | 20 | Exact confirmation, cancellation, deletion, remaining counts, archived and other-project tasks, and reload. |

The seed helper also passed `node --check peck/seed.mjs`. No application source was changed. The Identity text uses the approved exception for this app's account-free local access. The template-only fixture has no task or completion-state model to seed.
