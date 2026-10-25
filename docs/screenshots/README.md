# README screenshots

The README's "A look inside" gallery links four images in this directory. One command
regenerates them from a build of the current checkout:

```bash
npm run build
node .ai/scripts/readme-screenshots/capture.mjs
```

| Image | View | Viewport (CSS px) |
| --- | --- | --- |
| `task-view.png` | Tasks, with **Columns → Resource columns** on and the Finished group folded | 1920×1000 |
| `live-run.png` | A running task's session | 1600×1000 |
| `workflow-builder.png` | Workflows, with `implement-and-review` loaded | 1600×1000 |
| `github-issues.png` | GitHub, with the first open issue selected | 1600×1000 |

Every image uses device pixel ratio 2 and the dark theme. The task view is wider than the
others, so its toolbar stays on one row and every resource column fits. Its Finished group
is folded, because the table lists it before the running and queued tasks.

## What the command needs

- A build: `npm run build` writes `packages/cezar/dist` and `packages/cezar/web/dist`.
- `agent-browser`, on `PATH` or in the cache that
  [ensure-installed](../../.ai/browsers/agent-browser.md#ensure-installed) fills.
  `npm run test:e2e` installs it too.
- A `gh` login, for `github-issues.png` only. That image shows the public open issues of
  `hearsay-tools/cezarion`, so it changes with each capture.
- Linux or macOS. The command runs its agent through a shell launcher.

No agent login and no running cockpit are needed.

## What it does

1. It creates a scratch directory under `/tmp`. The scratch HOME in it holds two demo
   repositories: `code/cezarion` (this checkout's committed files, without `docs/` and
   `.ai/`) and `code/storefront`.
   It never reads or writes the live cockpit's `.ai/cezar`.
2. It boots a cockpit without dry run, with no tasks, and captures the GitHub tab.
3. It boots a `CEZ_DRY_RUN=1` cockpit whose agent is
   [`demo-agent.mjs`](../../.ai/scripts/readme-screenshots/demo-agent.mjs). Each seeded task
   plays a scripted turn from
   [`scenarios.mjs`](../../.ai/scripts/readme-screenshots/scenarios.mjs), with real tool
   calls and a real edit in its worktree. The tasks finish, fail, ask for input, keep
   running, or wait in the queue.
4. Before each image, it checks the page text for dry-run giveaways such as `mock:` or
   `dry run`, and stops when it finds one.
5. It replaces the images only when every selected image was captured. Then it stops both
   cockpits and removes the scratch directory.

Both cockpits use a scratch `HOME` and `CEZ_HOME`, so the host's global skills, settings
and other projects do not appear in an image.

## Options

| Option | Effect |
| --- | --- |
| `--only <image>` | Capture only this image, by name without `.png`; repeat for more |
| `--out <dir>` | Write the images to another directory |
| `--keep` | Keep the scratch directory, with both cockpit logs, and print its path |

`variants-compare.png` and `skills-autonomous.png` are older images that the README no
longer links. The command does not capture them.
