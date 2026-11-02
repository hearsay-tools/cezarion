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

This existing build script compiles the actual service and cockpit into an ignored directory. It links the installed dependencies and bundled mock runners. It builds the cockpit with `VITE_CEZ_E2E=1`, the repository's browser verification mode, which pins its display clock and background polling. It does not replace task search, archive, rename, or pin behavior. Allow up to three minutes for the build on a loaded host. Keep the checkout and its dependencies in place while this build runs.

## Fresh data

Give **each spec run** a new directory outside any `.ai/cezar/worktrees/` path. Do not serve the source checkout itself. The following commands create an isolated fixture for any supplied spec:

```sh
RUN_ROOT="$(mktemp -d /tmp/cezar-peck-XXXXXX)"
node peck/seed.mjs peck/fixtures/project-tasks.json "$RUN_ROOT"
```

All four specs have the same Given tables. The supplied JSON is their exact normalized form. For other Given rows, generate a JSON file from those rows and pass that file as the first argument to `seed.mjs`. The helper accepts JSON, not Markdown. Every cell must be a string, including `"true"` and `"false"`.

Each run has these separate stores:

- `$RUN_ROOT/home/config.json`: the workspace registry and preferences, selected through `CEZ_HOME`.
- `$RUN_ROOT/projects/cedar-tools/.ai/cezar/`: the selected project's run store.
- `$RUN_ROOT/projects/river-docs/.ai/cezar/`: the other project's run store.
- `$RUN_ROOT/tmp/`: process temporary files.

The helper refuses a nonempty destination. It creates two local Git repositories with a `main` branch and one commit each. Neither has a remote. Start with a fresh browser context and empty cookies, local storage and session storage for each spec. Use a **1440 × 900 desktop viewport**. Unfiltered result counts are hidden on phone layouts.

## Seed mapping

The JSON has three arrays: `people`, `projects`, and `tasks`. Table headings become these lowercase keys; column spaces become underscores.

| Given table | Given key | App representation |
|-------------|-----------|--------------------|
| People | `name`, `role` | Narrative actor only. The app has no human identity or password model, so these rows do not create accounts. |
| Projects | `name` | Git directory name, workspace registry `id` and `name`, and `/p/<name>` route segment. The fixture names are lowercase slugs. |
| Tasks | `title` | Run `title` and original `task` text. No generated `titleSummary` replaces it. |
| Tasks | `project` | Selects the project's separate run store; must match one Projects name. |
| Tasks | `status` | Run `status`, exactly `done` or `cancelled` for these fixtures. Both are terminal states. |
| Tasks | `archived` | Run `archived`, converting the string `"true"` or `"false"` to a boolean. |
| Tasks | `created_date`, `created_time` | Run `createdAt`, joined as UTC with seconds `00`. |

Task titles are the seed keys and must be unique within their project. The helper derives each run ID as `peck-` plus the first 20 hex characters of SHA-256 over `<project>`, a NUL byte, and `<title>`. It sets `workflow` to the built-in `quick-task`, `steps` to an empty array, and `tokensUsed` to zero. It sets `finishedAt` one minute after `createdAt`, and sets `archivedAt` to that finish time for an already archived task. Every task starts unpinned, using the app's default for an absent `pinned` field. There is no worktree, PR, transcript, automation, or pending question to seed.

The helper writes the records to each project's `.ai/cezar/runs.json` before first boot. This is the app's existing legacy import path, also used by its browser fixtures. On first opening a project, the app imports it into `.ai/cezar/runs.db`. **After import, `runs.db` is authoritative**: editing `runs.json` does not reset the run. Create another fresh directory to reseed. Do not write into a live database.

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

Wait for the heading `Project tasks` and the three task rows before recording the initial page. No install or build command is part of startup. For a given port, use the same origin spelling throughout; `localhost` and `127.0.0.1` have different browser storage.

## Drive and observe

Use the page's accessibility tree. The named controls are `Search tasks`, `Show all tasks`, `Active`, `Archived`, `Archive task`, `Cancel`, and `Unarchive`. The Active and Archived buttons include their counts, such as `Active · 3` and `Archived · 1`.

For `task-rename.md`, use `Rename task` in the named main-list row. The editor's field is `Task title`. Its buttons show `Save` and `Cancel`, with accessible names `Save title` and `Cancel rename`. Keep focus in the title field while entering a draft: Enter or leaving the field saves it. Use the editor's Cancel button to discard the draft. The task-page header has a separate editor with no Save or Cancel buttons, so perform this spec's edits in the main list. Opening the renamed task shows its new heading and the unchanged original request in the `Your message` entry.

For `task-pin.md`, use `Pin task` or `Unpin task` within the named main-list row. Hover over the row or focus its controls with the keyboard to reveal an unpinned row's controls. A pinned row keeps its Unpin control visible. Wait for the row's updated control and position after each change. Read task order from top to bottom in the main `Finished` group. Pins do not create another group. With this fixture, unpinned rows start as `Review invoice totals`, `Audit invoice export`, then `Polish settings labels`. Pinning the cancelled task moves it ahead of the unpinned done tasks. If both it and `Audit invoice export` are pinned, the done task comes first within that pinned pair.

The sidebar repeats active task links. Criteria about task presence, absence and counts refer to the **main Project tasks results**, under the main heading, not the sidebar. On a task page, `Archive task` is visible beside the disabled reply composer. Requesting archive opens an `Archive task?` confirmation. When a step says to confirm, confirm inside that dialog. `Unarchive` acts without a second confirmation.

Wait for each visible result before recording the page or taking the next action. In particular, wait for the confirmation dialog to leave the accessibility tree after Cancel or confirmation; its closing animation briefly hides the page behind it. Search renders immediately but writes its query into the URL after a debounce. Do not reload until the URL reflects the intended search, if testing a reload with a search.

Fresh browser storage keeps task groups open. If a reused browser has folded them, the page offers `Expand groups`; prefer a new context so the initial page matches the spec. Keep the task-origin filter on `All`. The task-origin buttons also show counts; those counts describe the selected list before search. Acceptance criteria use the separate results caption, such as `2 tasks matching “INVOICE”`.

## Stop and restart

None of the supplied specs requests a process restart. The archive, rename, and pin specs reload browser pages to check persistence.

For a process restart, send SIGINT to the supervised foreground process and wait for it to exit. Run the same Start command with the same `RUN_ROOT`, `BUILD_ROOT`, port and environment. Keep the existing data and browser context; do not run the seed helper again. The SQLite store holds archive choices, saved titles, and pins. To clean up, stop the process and close its browser context before deleting only that run's temporary directory.

## Needs and sources of variation

- No mail, payment, database server, provider key, or GitHub service is needed. SQLite ships with the required Node version. Missing `gh` produces an availability hint and does not block these features.
- `CEZ_DRY_RUN=1` selects bundled mock runners. These specs never submit a new task or resume a task. All seeded tasks are terminal.
- `CEZ_PROJECT_WARMUP=0` keeps other-project startup lazy. The second project is registered and has its own seeded store; warming it is not necessary for the selected project's list.
- `CEZ_AUTOMATIONS=0` keeps the automation scheduler off. There are no seeded schedules, timers, live sessions or webhooks.
- The repositories have no remotes. GitHub refreshes and merge checks have no work to do. Normal optional catalog/update checks are outside these criteria; no external response is needed for any of these four features.
- Seed timestamps are fixed UTC dates. The browser verification build pins its display clock. Do not assert relative ages or localized time strings; the specs do not depend on them.
- The server binds to loopback. A browser in a separate container needs access to that same loopback listener, or both processes must run in the same network namespace. No authentication token is needed on the local listener.
- Keep each run on its own port and `RUN_ROOT`. Do not share the workspace registry, SQLite files, browser context, or fixture Git directories between runs.

## Verification performed

On 2026-11-02, all four scenarios were walked in headless Chromium through `agent-browser` 0.40.0, using this seed helper and the repository's browser verification build. Each scenario used a fresh data directory and browser session. All 80 criteria matched the recorded accessibility trees:

| Spec | Criteria | Checked behavior |
|------|----------|------------------|
| `task-search.md` | 20 | Uppercase query, exact empty-state copy, reset, and separate archived list. |
| `task-archive.md` | 20 | Cancellation, confirmation, Active and Archived counts, reload after archiving, restoration, and reload after restoration. |
| `task-rename.md` | 20 | Initial editor value, draft cancellation, saved title, unchanged original request, task count, and reload after saving. |
| `task-pin.md` | 20 | Initial order, pinning across terminal statuses, two pinned tasks, removing each pin, task count, and reload with and without a pin. |

The seed helper also passed `node --check peck/seed.mjs`. No application source was changed. The only template exception is the approved Identity text for this app's account-free local access.
