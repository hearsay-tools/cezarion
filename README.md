<div align="center">

# cezar ⚡

**Parallel coding agents orchestrator** — a local cockpit for running and
tracking AI coding-agent tasks in your repo.

Type a task, pick a workflow and an agent — **Claude Code, Codex, OpenCode, pi or OMP
(OpenCode, pi and OMP experimental), or a mix of them per step** — and watch it work live: steps, tool calls,
tokens, diffs, in a browser cockpit that runs entirely on your machine.
Your CLI logins, your `gh`, your files. No accounts, no database server, no cloud.

🔥 **Fire and forget.** Queue a stack of autonomous coding and maintenance
tasks and let them run — cezar orchestrates them across isolated worktrees,
in parallel. Flip the **Autonomous** flag
and a run never stops to ask; it just finishes. Leave it on a VPS and you get
a dev team that's *always on* — a mobile-friendly cockpit you can check from
your phone, working your backlog while you're away.

[A look inside](#a-look-inside) · [What cezar does best](#what-cezar-does-best) · [What it solves](#what-it-solves) · [Who it's for](#who-its-for) · [Quick start](#quick-start) · [How it works](#how-it-works) · [Core concepts](#core-concepts) · [Cockpit tour](#cockpit-tour) · [Agent backends](#coding-agent-backends) · [Remote access](#remote-access-host-cezar-on-a-server)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node 24.15+](https://img.shields.io/badge/Node-24.15%2B-339933)
![TypeScript 7.x](https://img.shields.io/badge/TypeScript-7.x-3178c6)
![Zero config](https://img.shields.io/badge/config-zero-success)
![Embedded SQLite](https://img.shields.io/badge/database-embedded%20SQLite-success)

</div>

---

```bash
cd your-repo
npx cezarion         # → cockpit at http://localhost:4321
```

That's the whole setup. If your `claude` CLI is logged in (Pro/Max) and `gh` is
authenticated, there is nothing else to configure. State lives in `.ai/cezar/`
inside your repo: your runs in one embedded SQLite file (`runs.db`, built into
Node: no server, no install, no config), event logs in NDJSON and journals in
Markdown. Everything except the run file you can `cat` and fix by hand.

Local npm installations have a workspace update API. `POST
/api/v1/workspace/application-update/apply` with `{}` prepares the release
advertised by health while the current server keeps running; `POST
/api/v1/workspace/application-update/restart` with `{}` then restarts it. A
successful restart updates the original global installation or ordinary npx
cache entry, so the same command uses the new version on its next launch.
Update preparation and recovery state is generated under
`~/.cezar/application-updates/` (or `CEZ_HOME`).
Pinned npx invocations, source checkouts, npm links, and hosted deployments use
their existing manual update paths. Cezar holds its own installation lock and
npm's npx lock during promotion; a separate manual `npm install` does not honor
those locks, so avoid one while an update is preparing or restarting.

## A look inside

Click any thumbnail for the full-size screenshot.

| Orchestrate parallel agents | Watch a run live | Parallel variants |
|:--:|:--:|:--:|
| [![The Tasks view — parallel runs, a queue with positions, per-run cost and peak memory, and a variants compare card](docs/screenshots/task-view.png)](docs/screenshots/task-view.png) | [![A running task streaming agent text, tool calls and screenshots live](docs/screenshots/live-run.png)](docs/screenshots/live-run.png) | [![Two competing variants of the same task compared side by side — pick the winner](docs/screenshots/variants-compare.png)](docs/screenshots/variants-compare.png) |
| *Run and queue many tasks at once — each in its own worktree — with live status, cost and peak memory per run.* | *Every step, tool call, token and screenshot — streamed as it happens.* | *Run a task ×2/×3 in isolated worktrees, compare the diffs, keep one.* |
| **Workflow builder** | **GitHub, one click away** | **Skills + fire-and-forget** |
| [![The workflow builder — drag skills into an ordered chain of agent steps and shell checks](docs/screenshots/workflow-builder.png)](docs/screenshots/workflow-builder.png) | [![The GitHub tab — hand an open issue to the agent with a workflow and skills](docs/screenshots/github-issues.png)](docs/screenshots/github-issues.png) | [![The task composer — pick a skill playbook and flip the Autonomous flag to run unattended](docs/screenshots/skills-autonomous.png)](docs/screenshots/skills-autonomous.png) |
| *Stitch skills and shell checks into a reusable YAML chain, no code.* | *Open issues and PRs via your `gh` — run the agent straight on an issue.* | *Pick a Markdown skill and flip **Autonomous** — the run never stops to ask, so you can walk away.* |

---

## What cezar does best 🏆

Plenty of tools wrap a single coding agent in a nicer window — a "Codex GUI", a
conductor-style app, one-agent front-ends. cezar's bet is different. Three things
it does better than any of them:

- 🪶 **Genuinely zero config.** `npx cezarion` in your repo and you're running —
  no wizard, no API keys, no env vars, no schema, no database server. It rides the
  `claude` / `codex` / `opencode` / `pi` / `omp` logins and the `gh` you already have, and every
  missing piece degrades gracefully instead of blocking you.
- 🖥️ **Built for a server (VPS mode).** cezar is made to live on a **VPS, cloud,
  or dedicated box** as an always-on janitor for your repo — headless-first, with
  a mobile-friendly cockpit you drive from anywhere. It's a coding server you can
  actually watch, not a desktop app bolted onto one machine.
- 🔀 **Parallel + autonomous orchestration.** The real edge: cezar runs **many
  agents at once** in isolated worktrees, **queues** the overflow, and pushes each
  one **autonomously** through skill playbooks — fire-and-forget. This is exactly
  what single-agent GUIs don't do well: they babysit one agent, while cezar
  orchestrates a whole team and drains your backlog while you're away.

---

## What it solves

Most "AI coding agent" tooling makes you choose between a **terminal** you can't
see into once it's running, and a **cloud product** that wants your API key, your
code on their servers, and an account. cezar is the third option: the agents run
locally under *your* subscription, a cockpit shows you exactly what they're doing,
and an orchestrator keeps a whole queue of them moving.

- 👀 **No visibility into a running agent.** A headless `claude` run is a black box
  until it finishes. cezar streams every step — agent text, each tool call and
  its result, tokens and cost per step — live, and keeps the full replay.
- 🧩 **One agent, one working tree, one thing at a time.** Kick off a second task and
  it fights the first over your files. cezar runs each task in its **own git
  worktree**, so two (or three) agents work in parallel without stepping on
  each other — or on the branch you're editing.
- 🗂️ **A backlog that needs babysitting.** Queue a stack of tasks and cezar
  **orchestrates** them: it runs up to your parallel limit and holds the rest in
  an ordered queue. Point it at a GitHub issue and it runs straight on that, so
  working the tracker down stops being a manual chore. Turn on the opt-in
  **Inbox** (`CEZ_FOLLOWUPS=1`) and an agent's leftover follow-ups become the
  next tasks too — one click each.
- 🤖 **"Autonomous" means you still have to sit there.** Flip the **Autonomous**
  flag and a run never parks to ask — it keeps going until the task is done. Pair
  it with a **skill** (a Markdown playbook) and you've got fire-and-forget
  automation: hand off "fix this", "upgrade that", "triage these" and walk away.
- ✅ **The agent finishes and you have to trust it.** cezar ends non-trivial runs at
  a **review gate**: inspect the diff, send notes back into the same session, or
  push a **draft PR** — never an auto-merge.
- ♻️ **Losing a session when it fails.** Every run records its `claude` session id.
  Take it over interactively in one click (`claude --resume <id>`), or continue it
  in-process from the cockpit.
- 🔀 **Locked into one agent vendor.** Most tools wed you to a single CLI. cezar
  drives **Claude Code, Codex and OpenCode (experimental)** through one runner seam — set a
  default, pick a backend per task, or mix them inside one workflow (implement
  with one agent, review with another) — and through **OpenCode** you can point
  a run at **open-source or local models**, not just the big vendors. See
  [Agent backends](#coding-agent-backends).
- 🖥️ **Close the laptop and the work stops.** A local agent only runs while your
  machine is on and awake. Put cezar on a **VPS, cloud box, or dedicated server**
  and the cockpit becomes the GUI for an **always-on AI coding team** — kick off,
  watch and steer tasks from your laptop or **phone**, on the train or between
  meetings, while the agents keep grinding through the backlog back on the server.
- ⚡ **Setup tax.** No wizard, no env vars, no schema. Skills are Markdown, workflows
  are short YAML, and everything degrades: no `gh` → works without PRs, no network
  → local skills still load, no `.ai/skills` → the bare prompt still runs.

---

## Who it's for

- **Solo devs and small teams** who want the leverage of coding agents without
  handing their code and keys to a SaaS — the agent runs on your subscription,
  on your machine.
- **`claude` CLI power users** who love headless runs but want to *see* them,
  compare a few attempts side by side, and review a diff before it lands.
- **Anyone with a backlog** who'd rather queue three tasks into isolated worktrees
  and pick the winners than babysit one terminal.
- **Teams with shared conventions** who want their playbooks (skills) pulled from
  a git repo, applied consistently, with zero per-project setup.

---

## Quick start

**Prerequisites:** Node 24.15+, at least one logged-in agent CLI — the
[`claude` CLI](https://github.com/anthropics/claude-code) (Pro/Max subscription),
the [`codex` CLI](https://github.com/openai/codex), or
[OpenCode](https://opencode.ai) — and, optionally, `git` and the `gh` CLI.

```bash
cd your-repo
npx cezarion               # start the cockpit for the current repo
#   or: npx @wjarka/cezarion
```

The cockpit opens at `http://localhost:4321`. If the requested port is occupied,
startup exits with an actionable error before recovering tasks. Automatic port
bounce has been removed (hearsay-tools/cezarion#722): open the existing cockpit,
stop the process using that port, or choose `cez --port <free-port>` deliberately.
Use `cez --port 0` to ask the OS for an ephemeral port. If another cockpit already
serves this repository, the command prints its URL and exits with an error,
even with a different port. Different repositories can run side by side on
explicitly different ports; after a cockpit exits or crashes, its repository
can start again without cleanup.
Type a task, pick a workflow, hit **Start**. That's it.

```bash
npx cezarion run "add a --json flag to the export command"   # headless, CI-friendly
npx cezarion init                                            # scaffold .ai/cezar/
```

Both the `cezarion` and `cez` commands are installed, so once it's on your PATH you
can run either. No API key is ever used — cezar shells out to whichever agent
CLIs you are already logged into, `claude` by default.

> **Contributing?** [Local development](#local-development) shows how to get a
> global `cez` command straight off your checkout (`npm run install-as-command`)
> — no publish needed.

> **Just kicking the tires?** Set `CEZ_DRY_RUN=1` to run against a bundled mock
> instead of the real CLI — the whole cockpit works with no `claude` login, so
> you can explore runs, diffs, variants and the review gate offline.

### Nightly builds — help us shape cezar 🌙

Every night we publish the trunk to npm, so the features landing in the next
release are one command away:

```bash
npx cezarion@nightly       # everything merged as of last night
```

**Come build this with us.** cezar is shaped by the people who run it on real
repos: if you try a nightly and something feels wrong — a workflow that stalls, a
diff that reads badly, a runner that should exist — [open an
issue](https://github.com/wjarka/cezar/issues) and tell us. That feedback,
early, is worth more than a bug report six weeks after a release, and it is how
most of the features here got their final shape.

**Know what you're installing.** A nightly is verified (typecheck, unit suites,
packaged-CLI e2e — the same gate a release runs) but it is *not* a release: it
can be rough, a flag or a screen may change under you, and something occasionally
breaks in a way no test caught. Nothing is at risk beyond your patience — every
task runs in its own git worktree and cezar never auto-merges — but if you need a
boring day, stay on the stable release. Pin a nightly you liked with its exact
version (`npx cezarion@0.9.2-nightly.20260813.126` — the cockpit prints the
version it booted, and the date in it tells you how old the build is), and drop
back to stable any time with a plain `npx cezarion`.

### Preview builds

Every green CI run also publishes an installable npm snapshot
([how it works](docs/publishing.md)), so you can try code that has not even
merged yet:

```bash
npx cezarion@dev           # current main head
```

Every pull request gets its own preview too — the CI bot posts a sticky comment
on the PR with the exact pinned version to copy-paste
(`npx cezarion@<version>-pr<N>.<run>`). Nightlies and previews are all
prerelease versions under their own dist-tags; a plain `npx cezarion` always
resolves to the latest stable release.

---

## How it works

You describe a task. cezar runs it as a **workflow** — an ordered list of agent
steps and shell checks — shelling out to your locally installed agent CLI
(Claude Code by default; Codex and OpenCode are drop-in alternatives, per task
or per step). Each task gets its own git worktree; the cockpit streams every
event live and parks the run at a review gate when there's a diff to inspect.

```
   you type a task
        │
        ▼
   ┌─────────────┐   optional: Plan → AI drafts a chain of steps you approve
   │  workflow   │   (agent steps + shell checks, with bounded onFail retries)
   └─────────────┘
        │
        ▼
   ┌──────────────────────────────┐     ┌───────────────────────────────┐
   │  git worktree per task       │     │  agent CLI  (your login)      │
   │  (isolated branch, parallel) │◄───►│ claude · codex · opencode · pi│
   └──────────────────────────────┘     │  Bash open · no prompts       │
        │                                 └───────────────────────────────┘
        │  agent text · tool calls · tool results · tokens · cost
        ▼
   ┌─────────────┐   SSE (replay + live)   ┌──────────────────────────┐
   │ .ai/cezar/  │ ──────────────────────► │  cockpit  localhost:4321 │
   │SQLite·NDJSON│                         │  Tasks · Git · GitHub ·  │
   │ ·Markdown   │                         │  Skills · Workflows      │
   └─────────────┘                         └──────────────────────────┘
                                                  │
                                          review gate: read the diff →
                                          send notes back · draft PR · finish
```

When a check fails, the workflow can loop back to an earlier step (bounded by
`max`) with the failing output appended to the retried agent's prompt. Nothing
auto-merges: a run with changes rests in `review` until you act on it.

---

## Core concepts

Three words, no jargon — **task**, **skill**, **chain**:

- 📋 **Tasks** are the unit of work. Every task is a **run**: `queued → running →
  review / done / failed / cancelled`, with a live event log, per-step token and
  cost usage, cancel/delete, and — for anything with a diff — a review gate. Attach
  screenshots, PDFs, `.txt` or `.md` files to the task (paperclip, ⌘V or drag-drop;
  the agent gets each one as a real file on disk), or send follow-up messages into
  the live session while it works.
- 📖 **Skills** are Markdown playbooks. Drop them in `.ai/skills/` or
  `.ai/cezar/skills/`, or pull them from a shared **team skills repo** (a bare
  git clone cached globally in `~/.cache/cez/`). A workflow step references one by
  `skill: <name>` and its body becomes the agent's extra system prompt — so you
  shape *how* the agent reasons without touching code.
- 🔗 **Chains (workflows)** stitch steps into a pipeline: agent steps plus shell
  checks, with bounded `onFail` retry loops. Write the YAML yourself, build one by
  drag-ordering skills in the **Workflows** tab, or press **Plan first** and let the
  AI draft a chain for your task that you review, trim and start. The built-in
  `quick-task` (one agent step) works with zero setup.

Five moves that make the cockpit worth the browser tab:

- 🗃️ **Queue + orchestration.** Start as many tasks as you like: cezar runs up to
  `maxParallel` at once across every project (default **2**; a non-git directory
  always runs one) and
  holds the rest in a FIFO queue with visible positions (`#1`, `#2`, …). Cancel a
  queued task before it starts; the queue even survives a cockpit restart —
  everything still `queued` is re-enqueued in order. It's the orchestration layer
  that turns "one agent at a time" into a backlog that drains itself.
- 🧠 **Memory-aware runs.** Each run's whole process tree is sampled (~2 s) for CPU
  and RSS, and its **peak memory** is recorded and shown in the task table. Set an
  optional per-task **memory ceiling** (`memoryLimitMb`) and a run that crosses it
  is *paused* — freeing its tree so the queue keeps advancing — and resumes on
  demand. Event logs are append-only NDJSON and streamed rather than re-serialized,
  and live UI deltas are coalesced so they never hit disk.
- 🪞 **Parallel variants (×2 / ×3).** Run the same task as competing agents in
  separate worktrees, then compare their diffs side by side and **pick** one —
  the losers are archived and their worktrees cleaned up.
- 🧹 **Bounded worktree disk.** Each task runs in its own full checkout, so a busy
  cockpit would otherwise grow without limit. cezar keeps only the last
  `worktreeRetention` **finished** worktrees on disk (default **10**; `0` =
  unlimited) and reclaims the rest — directory only, the `cez/<id8>` branch is
  always kept, so the work stays recoverable. Settings → Resources shows every
  worktree's disk use with per-row delete and a **Reclaim now** button.
- 🛡️ **Review gate.** A finished run with changes waits in `review`. Read the diff,
  type notes that go straight back into the agent's session, or push a
  `gh pr create --draft`. You stay the merge button.
- 📱 **Runs on your coding server, drives from your pocket.** The cockpit is a
  responsive web app streaming over SSE, so the box running cezar can be a
  **VPS, cloud, or dedicated server** you never sit in front of. Point a browser
  — laptop or **phone** — at it and run an **always-on coding team** on the move:
  start tasks, watch them live, and hit the review gate from anywhere.

---

## Cockpit tour

Eight views, one browser window, all live over Server-Sent Events (seven until you opt into the Inbox):

| View | What's in it |
|---|---|
| **Tasks** | Every task with its status, live event stream (agent text · tool calls · tool results · pasted/generated screenshots and file attachments), tokens and cost. Continue, cancel, open in terminal (`claude --resume`), review the diff, or push a draft PR. |
| **All tasks** | Every *registered project's* tasks in one table, filtered and grouped by tag, project, status or workflow — see [Grouping connected repositories](#grouping-connected-repositories-tags-and-the-all-tasks-page). Appears once a second project is registered. |
| **Inbox** | **Opt-in** (`CEZ_FOLLOWUPS=1`; hidden by default). Follow-ups an agent left behind (`todos.json`) — one click turns a suggestion into the next task, pre-wired to its suggested skill. Off, agents are never asked to leave follow-ups; each task's own **Notes** handoff journal is unaffected. |
| **Git** | Branch, working-tree status, diff vs HEAD, recent commits (click one for its inline patch + GitHub link), and the configurable base branch that worktrees fork from and PRs target. |
| **GitHub** | Open issues and PRs of the repo's origin, read through your logged-in `gh`. Hand an issue straight to the agent — pick a workflow and skills, one click runs it. |
| **Skills** | Local skills plus the team skills repo, with a rendered body + prompt preview. Refresh pulls the latest from the remote. |
| **Workflows** | Build a chain by drag-ordering skills, save it as portable YAML, import/export, or delete. Built-ins always come back. |
| **Settings** | Appearance (dark/light theme, accent, density), agent backends, notifications, and the skills catalog. |

The cockpit is a React app served pre-built from the package — `npx cezarion`
still means no build step and no dev server on your machine — with a dark/light
theme, a ⌘K command palette, and bookmarklets that launch a task straight from
a GitHub page.

GitHub issue and PR lists refresh every 60 seconds while mounted in a foreground browser tab.
Automatic reads retain the server's 60-second cache: while online and visible, upstream edits
appear within 120 seconds plus request time. Revisiting or focusing stale data fetches again;
server reconnects invalidate cached lists. Hidden and unmounted lists do not poll. **Refresh**
bypasses the server cache immediately and refreshes the selected thread too.

---

## Multiple projects, one cockpit

One `cez serve` hosts **every repo you work in**, not just the one you started
it in. Each repo cezar boots in registers itself in a per-user registry at
`~/.cezar/config.json` — the workspace file that also holds the global knobs
(the parallel cap, the memory ceiling, the browse root, and the checkout root). Nothing is added to
the repo: per-project state stays exactly where it was, in that repo's
`.ai/cezar/`.

Every view is project-scoped:

```
/p/<projectId>/            tasks · git · github · skills · workflows · settings
```

`<projectId>` is a slug derived from the folder name (`my-app`, then `my-app-2`
on a collision), and `/p/default/…` always means the project cezar was started
in. The desktop rail selects the project. Its sidebar shows the project header,
view tabs and task list, ordered **Needs you → Finished → Working**.
Pins stay first within their status section and do not spend the default ten-row
budget; Finished takes priority over Working when that budget fills up. Each
section starts expanded and folds independently using its heading (click, Enter
or Space). Folding is remembered per browser, project and section, separately
from folding a project. Folded headings keep full task counts and attention
indicators, including tasks outside the visible row limit. These controls work
in the mobile drawer too. **Archive all** appears only on Finished and archives
all eligible unpinned tasks, including hidden rows; individual archive actions
and Undo remain available. Archived keeps its existing history view.
Inbox and Automations appear in More views when enabled. The project menu
offers Mark all read and project settings; local mode also offers Open in and
Copy path. Active/Archived remains below the Tasks heading. The new-task
composer names the project it will run in.

**Adding a project** — the **+** button on the desktop rail (or in the mobile
navigation drawer):

- 📂 **Open local folder…** browses from the configured browse root
  (**Settings → Projects**, default `~/`) in a folder picker and
  registers the folder you pick.
- ⬇️ **Clone from GitHub…** clones with your logged-in `gh` into the checkout
  root (**Settings → Projects**, default `~/cezar/projects`) with live progress,
  then registers the clone. Close the dialog and the clone is killed and its
  partial directory removed. For a SAML-protected organization, follow **Authorize
  this GitHub organization**, authorize in GitHub, then return to retry once (or
  choose **Retry clone**). Original errors remain available under **Error details**.
  Clones use HTTPS and save the GitHub CLI credential helper in the new repository
  so later pushes use the same organization grant, even if `gh` prefers SSH.

Removing a project (**Settings → Projects**) drops the registry entry only — the
repo and its `.ai/cezar/` are never touched, so re-adding it later finds all its
tasks intact. The project cezar is currently serving can't be removed: it
re-registers itself at the next start.

**From the terminal** — the same registry, no cockpit required (handy over ssh):

```bash
cez projects                      # list: id, branch or status, path, tags
cez projects add ~/code/api       # register a folder (defaults to the current repo)
cez projects remove api           # drop the registry entry; the repo is untouched
cez projects tag api storefront backend     # set the grouping tags (no tags clears them)
```

These read and write `~/.cezar/config.json` directly, so they work with the
server stopped, and `CEZ_HOME` selects which workspace they operate on.

Settings split along the same line: **General** (the project's folder, its
registry facts, its parallel-task ceiling, and Remove), **Agents**, **Agent config**,
**Worktrees**, **Sidebar**, **Bookmarklets** and **Prompt templates** describe one
repo and live under `/p/<projectId>/settings`; **Appearance**,
**Notifications**, **Resources**, **Skills**, **Agent accounts** and **Projects**
are yours or the machine's and live at `/settings/global`.

**Settings → Sidebar** controls this project's task rows on desktop and mobile.
Set **Overall**, **Needs You**, **Finished**, and **Working** to a positive whole
number or **Unlimited**. Defaults are 10 overall and Unlimited for each section.
The overall budget is allocated in section order (Needs You, Finished, Working),
and each section must also fit its own limit. Unlimited removes only its selected
constraint. Pinned rows and groups containing pins bypass both budgets; a grouped
task counts as one row. Archived uses only the overall limit, with no pin exemption.
Save applies the preferences to this project and keeps them after a reload.
Refreshed preferences update an untouched form; unsaved edits stay in place.
Malformed stored sidebar limits fall back field by field to these defaults,
while valid limits and unrelated preferences are preserved.

On desktop, Settings replaces the sidebar task list with two groups: **This project**
and **Global · every project**. Each group includes General and its available sections;
the current section is highlighted, and the main page shows its content. On mobile,
the section picker and General page's section cards provide navigation.

The GitHub sidebar groups **Issues** (Assigned to me, No task yet, Has a task,
All open) and **Pull requests** (Review requested, Mine, Checks failing, All open).
Selecting a filter updates the URL, so reloading keeps that selection. The issue
list, detail pane and Hand to agent action stay in the main area. On mobile, the
GitHub tab opens the filter screen; selecting a row opens its list.

Has a task and No task yet use issue references from this project's non-archived
tasks, excluding references to other repositories. Counts show a `+` when the
underlying list or search reaches its result limit; an unavailable count is not
shown as zero. Views without their own navigation still show tasks in the sidebar.

Open an issue to see **Linked tasks (N)** beneath its heading. Each row opens a task
in the current project and shows its title, status and date, newest first. Archived
tasks remain listed with an **Archived** label, so diagnosis and implementation
sessions are both reachable.

The Git sidebar lists **Task worktrees** that still exist on disk, including retained
worktrees from finished tasks. Each row shows its branch, task title, status and
available diff counts, and opens that task's Changes tab. Reclaimed worktrees disappear
from the list. Changes, Commits and Branches remain tabs in the main repository header.
On mobile, the Git tab opens the worktree list; **Open repository** opens the repository
view, and **Back to worktrees** returns to the list.

### Grouping connected repositories: tags and the All tasks page

Work rarely stops at a repo boundary. A storefront is an API, a web app and a
design system; a platform is a handful of services plus the infra that runs
them. **Tags** are how you say so, and **All tasks** is where saying so pays off.

**Tag a repo** in **Settings → Projects**: type into the *Tags* cell on its row
and press Enter (comma works too; the × on a chip, or Backspace in an empty
field, removes one). The field **autocompletes from the tags already used in the
workspace** — click the field to see them all, arrow keys and Enter to pick —
which is what keeps the second repo landing on the first one's spelling instead
of inventing `store-front` next to `storefront`. Anything not on the list is
just typed. A tag is a free-form label — `storefront`, `infra`, `client-acme` —
and a project can carry several, because a repo can belong to more than one
piece of work. Tags are trimmed, deduplicated case-insensitively (`API` and
`api` are one tag) and stored in `~/.cezar/config.json` beside the rest of the
registry, so they are yours and this machine's, never something added to the
repo.

**All tasks** — the layers icon on the desktop rail, `/tasks`, or `⌘K → All tasks` —
then shows every registered project's work in one table:

- **Filter** by tag, status and workflow. Tags are one-click chips; status and
  workflow are searchable multi-selects. Every facet ORs inside itself and ANDs
  across, so *"anything running or waiting in storefront or infra"* is one set
  of clicks. Each option carries how many tasks it would leave, so a filter that
  would empty the table says so before you click it. The search box matches
  title, project, workflow, branch and tags.
- **Group by** tag, project, status or workflow — click the pressed one again to
  ungroup. Grouping by tag is the reason tags exist: three repos tagged
  `storefront` become one section, and a repo tagged twice appears under both —
  it genuinely belongs to both.

The filters, the grouping and the Active/Archived tab live in the **URL**, so a
filtered view survives a refresh, pastes into a chat, and sits in a bookmark —
`/tasks?tag=storefront&status=running&group=tag` is a link to exactly what you
were looking at. Only what you changed shows up: Active is the default, so the
Archived view is `?archived=1` and a normal link carries no key for it.

Each row shows **every** PR and issue it references — a task opened on an issue
that landed a PR shows both — plus its cost and live CPU/memory, and can be
marked **read/unread** (the eye) or **archived** (or restored) right there. Every task title, project name and project group heading links into that
project, so the thread, its diff and its worktree are one click away and stay
exactly where they were. Returning to a long thread restores its saved row measurements
once the replay has rebuilt the same ordered messages, keeping the same content in view.
Scrolling, jumping to the latest message, or loading different history takes ownership
from that restoration; a thread left at its live tail follows the current tail.

There is deliberately **no project filter**: narrowing this page to one project
is that project's own Tasks page, which is a better version of the same answer
(live updates, the full column set, the composer). So picking a project *leaves*
for it rather than turning the global view into a worse local one.

Nothing else in cezar reads tags, on purpose: a tag is a lens, not a permission,
a queue or a routing rule. Removing one changes what you see and nothing else.

> The page reads a workspace-wide index capped at the newest 200 tasks per
> project — it says so, and names the projects it capped, rather than showing a
> short list as if it were complete. Older tasks are always in that project's own
> Tasks page.

**Old page URLs keep working.** Every unprefixed page path — `/`, `/tasks/<id>`,
`/settings` — still answers, bound to the project cezar was started in; the
cockpit redirects flat paths to their `/p/<boot>/…` twin, so existing bookmarks
and bookmarklets need no change. The HTTP API is the exception: it moved to
`/api/v1/…` (see the CHANGELOG), so a script that calls it needs the extra
segment.

> **Hosted cockpit?** The folder picker is confined to the independent browse
> root. Set `CEZ_BROWSE_ROOT` narrowly before first boot (or save it in
> **Settings → Projects**) when a remote viewer should not enumerate the host's
> whole home. Clones continue to use the separate checkout root.

---

## Waiting for PR checks

An agent can call `cezar_wait_for_ci` with a GitHub PR URL to ask Cezar to watch CI
outside the model. The optional `timeout_seconds` defaults to 1,800 and accepts
1–7,200. No authored configuration or worker delegation permission is needed.
Registration requires `gh`, access to the repository, and a supported GitHub host;
GitHub Enterprise hosts must already be recognized by the forge/auth configuration.
Tool startup itself makes no GitHub request.

A successful registration returns a durable receipt and an absolute deadline. The
agent ends its turn to wait, with no marker required. The header keeps the active
run status during registration, then shows Monitoring with **Waiting for CI —
owner/repo#N**, a PR link and the deadline. **CI result ready — waiting for capacity**
means the observation is queued for the agent to resume. Ordinary monitoring keeps
its existing automatic-check schedule when no CI wait is registered.

Cezar reports passed, failed, cancelled or skipped checks, no checks, changed head,
timeout or an operational error. It watches the registered commit: a new PR head
is reported separately, and the agent decides whether to wait again. The first
observation runs immediately. Later check-status and PR-head polls run every 30
seconds, and no setting changes that interval. Four watchers run concurrently;
queued waits retain their original deadline. Results are bounded
observations, not merge approval or evidence that every expected workflow appeared.
The agent still decides its next action; CI success never completes the task or
accepts review. A human message cancels the current wait, and CI never answers a
pending human question. Controller recovery can replay an observation after an
ambiguous delivery checkpoint, identified by its stable lifecycle input ID.

The adapters are bundled for Claude (including `claude-cli`), Codex, OpenCode,
Cursor, Pi and OMP. Internal socket/capability environment values are runtime wiring,
not settings to create or share. If the tool is unavailable or denied, its error
is surfaced while ordinary tasks continue. See [the CI-wait protocol](AGENT_PROTOCOL.md#ci-wait-tool-contract-474)
for limits and the executable harness verification required before release.

## Discover runners and models

Inspect the same host catalog the cockpit uses before selecting a runner or model:

```sh
cez discover runners
cez discover models --runner=codex
```

Both commands return JSON. `runners` lists connection status (`connected`, `disconnected`, `not-installed`, or `unknown`) and enablement, with `scope: "host-default-account"`. Model rows include `effortLevels` when the runner advertises them: an absent field means unknown; an empty array means no advertised levels. Omit `--effort` when spawning to keep the existing default. Model responses retain `source`, `stale`, and any unavailable `reason`; discovery never invents model IDs or effort support.

For operators, the command finds the running cockpit for the current checkout; `--repo`, `--url`, and `CEZ_URL` work as they do for `cez task`. A missing cockpit returns an error and never starts a server. Inside a parent delegation session, the same command uses that session's authenticated controller, including headless runs. It rejects `--url` and `--repo` in that context and never falls back to a public cockpit after an authentication failure. Owned workers cannot use the private discovery route.

The catalog describes host default accounts, not every named account or the selections permitted by a task's model locks and workflow pins. Existing `cez task start` and `cez worker spawn` still call their runner flag `--backend`; discovery uses `--runner`.

## Owned workers (opt-in)

Start the cockpit or a headless task with `CEZ_DELEGATION=1`. Each eligible parent session receives the absolute bundled Node/CLI invocation and its own environment credentials; no `cez` installation on the agent's PATH, config file, separate daemon, or remembered port is needed. If the private listener cannot start, ordinary tasks keep working without delegation tools. `.env` is never loaded automatically.

The provisioned command has these forms (the session instructions supply the absolute invocation):

```sh
cez worker spawn --baseline parent-head --request-id <UUID> 'Implement the assigned change'
cez worker spawn --baseline parent-head --request-id <UUID> --backend codex --effort high --context-file ./selected-context.txt 'Review the parser'
cez worker spawn --baseline parent-head --request-id <UUID> --workflow review 'Review the parser change'
cez worker inspect <worker-id>
cez worker steer <worker-id> 'Consider this additional constraint'
cez worker diff <worker-id>
cez worker collect <worker-id>
cez worker wait <worker-id> --mode one --timeout-seconds 600
cez worker wait <first-id> <second-id> --mode any --timeout-seconds 600
cez worker wait <first-id> <second-id> --mode all --timeout-seconds 600
cez worker cancel-wait <wait-id>
cez worker send <recipient-run-id> 'Please check this decision' --id <message-UUID> --kind request
cez worker send <worker-id> 'Correct the returned result' --id <new-message-UUID> --kind request --resume
cez worker progress <recipient-run-id> 'Parser tests pass' --id <message-UUID>
cez worker follow-up <recipient-run-id> 'Include empty input' --id <message-UUID> --request-id <request-UUID>
cez worker reply <recipient-run-id> 'Checked; empty input is covered' --id <message-UUID> --request-id <request-UUID>
cez worker conversation <recipient-run-id>
cez worker wait --request <request-UUID> --request <another-request-UUID> --mode all
cez worker wait-requests <request-UUID> --mode one
cez worker cancel-request <request-UUID>
cez worker stop <worker-id>
cez worker destroy <worker-id>
```

Use `cez worker --help` to list operations and flags, or `cez worker <operation> --help` for one operation. Explicit help prints human-readable text and exits successfully without an active delegation session. Commands otherwise return bounded JSON and a nonzero exit on failure or incomplete cleanup. Spawn requires a committed baseline (`parent-head` or an explicit ref) and pins its SHA at acceptance; dirty parent edits are excluded. Optional `--context '<text>'` or `--context-file <UTF-8-file>` supplies selected context, not the parent's conversation. The two flags are mutually exclusive, and combined task/context text is limited to 100,000 characters. The API also accepts up to 32 pinned-baseline file or parent-attachment references, with at most 8 MiB of copied attachments. Inspect reports worker-local input locations. Reuse a request ID only with the same task, baseline, context, backend, model, effort and workflow when retrying a lost response. A parent holds at most 32 outstanding workers: accepted, live, or not yet verifiably destroyed. A verified destroy (`cez worker destroy`, or **Clean up** on a finished worker in the cockpit's Workers list) frees a slot; incomplete cleanup keeps its slot until a retry completes. A parent can create at most 1,024 workers in total; past that, start a new task. These limits bound disk resources and runaway spawning, not spending: a worker can be resumed with Continue, and destroying it does not undo charges already made. Cost stays bounded by `maxParallel` and by stopping the parent. There are at most 32 undelivered steering messages per worker.

An incomplete destroy reports the remaining resources and a reason. Cezar retries that recorded request after a delay, including after the project's context recovers on server restart. It removes the owned checkout only after process termination and ownership are verified. If the reason persists, inspect the worker process, Git worktree lock and ownership receipt; correct the blocker and use `cez worker destroy <worker-id>` or the cockpit Destroy action to retry immediately. Cezar leaves ambiguous or replaced resources in place for operator review.

`--workflow <name>` runs a catalog workflow inside the worker: the built-in `quick-task` or any `.ai/cezar/workflows/*.yaml` by name, with its agent and check steps, `skill:` bodies and `onFail` loops, so a repo's `review.yaml` becomes a dedicated reviewer. Omitted `--workflow` runs `quick-task` exactly as before. `--backend`, `--model` and `--effort` fill only the steps that leave those fields unset; a step's own `allowedTools`/`bashAllowlist` narrow the parent's grants and never widen them. An unknown name is refused. Agent steps may mix runners: at spawn every agent step is resolved and pinned separately, so an implement-with-codex, review-with-claude chain runs each step under its own runner, account, model, effort and grants. A step's optional `agentProfile` names the account it runs under (an id the registry does not know is refused); same-backend steps otherwise inherit the parent's account and other runners resolve their project/default one. Run-level columns show the first agent step.

Explicit default-account model pins are checked against a fresh, nonempty host catalog after account/model resolution and before a worker is created. Named accounts retain existing validation because a default-account catalog cannot disprove their model access. A miss returns `invalid_input`, available models with advertised efforts, and other runners listing the requested ID in `modelChoices`. Empty, stale, or unavailable discovery leaves existing selection validation in place. Accepted retries and omitted model defaults are unchanged.

Omitted `--backend` inherits the parent's active backend. Same-backend workers inherit omitted model/account/effort; `--backend <claude|codex|opencode|pi|cursor|omp>` selecting another backend resolves that backend's project/default account and model without forwarding another provider's settings. `--model <model>` selects a supported model, subject to existing locks. `--effort <low|medium|high|xhigh|max>` pins reasoning effort on same-backend and mixed-backend spawn; omitted `--effort` still inherits the parent pin on same-backend spawn and drops it on mixed-backend spawn. Accepted identity and grants remain fixed across queuing, restart and Continue, including explicit empty grants. Changing or deleting an account registry entry does not rebind a worker. Missing accepted identity evidence or account homes, incompatible Claude state-file layouts, and conflicting later model locks refuse execution explicitly. Credentials and vendor configuration are never copied; each worker receives its own delegation credential, and unspecified native models stay unspecified.

Wait registers immediately. End the parent turn to release scheduler capacity; Cezar resumes it on a selected settled outcome or the finite deadline. `any` is the default, `one` requires exactly one worker, and `all` waits for every selected worker. Review, completion, failure, cancellation with proven termination, and destruction are outcomes. Timeout defaults to 600 seconds (1–1800 accepted). `cancel-wait` is idempotent for the retained wait ID and cannot cancel a newer wait. Timeout and wait cancellation report partial outcomes and unresolved workers, never cancel workers, and never automatically re-wait. Steering is attributed agent input and cannot answer a pending human question.

Parents and owned workers can converse in both directions; a worker may address only its parent. `send --kind request` opens a reply obligation whose ID is the message ID; `send --kind progress` (or `progress`) does not. Follow-ups clarify an existing request; only an explicit correlated `reply` settles it as replied. Retry a message with the same ID and exact payload, including deadline duration; changed payloads are rejected. Acceptance, provider delivery, reply, and task completion are separate facts, visible in the task transcript and `conversation` JSON.

Messages allow 100,000 characters each, with at most 32 undelivered inputs per recipient, 1,024 messages per family, and 32 pending requests. Request deadlines default to 600 seconds, configurable per message with `--timeout-seconds 1–1800`. Request waits use the same limits and `one`/`any`/`all` modes as worker waits, and each run has one active wait. Incoming conversation can interrupt a parked wait without settling its requests. `cancel-request` cancels an obligation; `cancel-wait` only stops waiting. Completion without a reply, failure, cancellation, destruction, timeout, or sender closure settle obligations distinctly. Late replies remain visible without reopening them.

Messages reach a live recipient as soon as they are accepted, including mid-turn: Claude, Codex, Pi, OMP and OpenCode steer them into the running turn, and the model reads them at its next step. Cursor delivers at the turn boundary, because a second prompt would cancel its running turn. Pending conversations go together, in order, up to 32 messages and 100,000 formatted characters per batch; a single valid message is never split. Every message keeps its ID, sender, delivery receipt and request outcome; receipts show queued, delivered and read (when the agent's harness can tell) separately. A pending human question holds messages until it is answered, then they follow right behind the answer. The thread's Details distinguish creation, delivery confirmation and event-recording times.

Sending to a review or terminal participant without `--resume` reports `not-delivered` and `continuation-required`, with the reason and next command; the CLI exits 1. An active parent can use `worker send --resume` (request or progress) to continue its settled done/review/failed worker with that message as the new instruction. No human Continue is needed for this parent-controlled action. A retry with the same payload and ID never creates another continuation; changing a rejected send to use `--resume` requires a new ID. Stopped or destroyed workers need a new worker. Workers cannot resume parents, and conversation never answers a pending human question. Durable IDs deduplicate accepted queue entries and event replay, but a crash between provider acceptance and its durable delivery checkpoint can leave transport delivery ambiguous; this is not an exactly-once execution guarantee.


Collect returns the worker's execution revision, status/outcome, `settled` and `partial` flags, and typed availability for assistant summary, HEAD, bounded diff and artifact descriptors. Missing evidence is explicit; running output is partial. An available `diff.path` points to a **JSON result file** containing `{ result, diffSnapshot }`; its `diffSnapshot` field holds the patch. Read and review that field before applying any changes. The latest collected result is stored under the parent and survives restart. Collection acknowledges observation, not Git integration or successful work. Review desired worker commits and deliberately integrate them into the parent before destroying their worktrees/branches; there is no automatic merge.

Parent completion requires collection of every worker's latest settled execution revision. A worker Continue invalidates older readiness. An early completion attempt waits for outstanding workers and wakes the parent to inspect/collect; it does not silently finish on wake. While workers remain live, markerless replies, completion timeouts, and repeated premature completion park the parent as monitoring with the existing capped wakeups. Once workers settle, repeated completion without collecting their results retains attention. Human Finish also refuses unresolved/uncollected workers. If the parent is already under review, Continue the parent first, then Continue its worker. Human questions remain authoritative.

Stop requests cancellation; `stopping` does not prove termination. Destroy checkpoints obtainable results, waits up to 30 seconds for proven termination, and removes only verified owned resources. An `incomplete` response lists remaining resources; resolve the cause and retry explicitly. Cleanup order is: collect/integrate desired results, destroy owned resources, explicitly delete child histories through the cockpit/API, then delete parent history. Parent-owned summaries and bounded diff snapshots remain until parent deletion, including after child-history deletion; general artifact bytes are not archived. Branch/path strings and SHAs become historical descriptors after removal, not promises of available Git objects or files. The human cleanup endpoint `POST /api/v1/p/<projectId>/runs/<worker-id>/worker-destroy` stays available when delegation is disabled. The CLI bounds each HTTP request to 45 seconds and rejects endpoint/auth/origin overrides and redirects.

Provisioned sessions prefer cezar workers and suppress verified native delegation entry points through per-run adapter controls: Claude `Agent`/legacy `Task` denies, Codex multi-agent feature overrides, OpenCode session `task` denies, and pi's known `subagent` extension exclusion. See [the backend capability table](AGENT_PROTOCOL.md#governed-delegation-controls-d1) for tested versions and exemptions. Native workers are not tracked by cezar. Pi has no native delegation primitive or universal identifier for arbitrary custom delegation extensions; guidance does not enforce those cases. With delegation disabled or unavailable, ordinary tools/settings stay unchanged. The listener binds to `127.0.0.1`, including hosted cockpit mode. Its credentials authorize only the parent's own workers through that listener. This is cooperative local-agent supervision; same-user unrestricted shell and custom tools are not hard isolation. Workers cannot delegate or message peers through cezar. Review remains a human gate with no automatic acceptance. Never read, echo, forward, or persist the generated token.


## From the terminal: `cez task`

`cez task` starts, watches and steers tasks **in the running cockpit** from a shell — for you, or
for a bot driving one. Every command prints one JSON object and exits with a code the caller can
branch on, so nothing has to parse prose. It never starts a server: it finds the cockpit whose
project registry holds this checkout (ports 4321–4370; a task worktree resolves to its parent
project), or you point it at one with `--url` / `CEZ_URL`.

```bash
id=$(cez task start --task-file - <<'EOF' | jq -r .id
Fix the `cez task` docs. Keep $(example) and "quotes" literal.
EOF
)
cez task wait "$id" --timeout-seconds 900                     # 0 done/review/needs you · 1 failed · 3 timeout
cez task list                                                # currentStepId (running), pullRequestUrl (done/review), capped error (failed)
cez task status "$id"                                       # slim JSON: status, attention, question, branch, handoffUrl…
cez task send "$id" 'Use the retry helper instead'            # delivered live, queued before start
cez task send "$id" --resume 'Continue with the next step'    # resumed: reopen a settled session
cez task log "$id" --follow --timeout-seconds 300             # JSON lines until it ends
```

`list --status` accepts comma-separated values: `queued`, `running`, `waiting`, `review`,
`done`, `failed`, `cancelled`. Default rows include only the next-action field for their status
when defined; errors use the first line, at most 200 characters including `…` when cut.
Default `status` includes `handoffUrl`, a URL to the existing handoff endpoint even before
contents are seeded, and keeps the full error. `--full` still prints the contract unchanged.
To answer a pending `question`, use the same `send` with the answer text. Without `--resume`,
a closed session returns `delivery: not-delivered` and the `next` command. For multi-line or
shell-sensitive messages use `send <id> --text-file <path|->` (`-` reads stdin); the quoting
rules below apply to messages too.

Use `--task-file PATH` to read a saved task (for example, `cez task start --task-file task.md`),
or `--task-file -` to read stdin as above. The quoted heredoc delimiter (`<<'EOF'`) keeps
backticks and `$()` literal in the task text.

POSIX shells, including Bash, expand backticks and `$()` in double-quoted arguments before
cez receives the text. **Do not put raw backticks in double-quoted task arguments.** This can
execute parts of your prompt as shell commands and leave holes in the stored task, including
when starting tasks through SSH and `bash -lc`. Prefer a task file or stdin with a quoted
heredoc delimiter. A single-quoted positional argument still works for short tasks:
`cez task start 'Fix the typo'`.

`cez task start --task-file task.md --skill <name>` names one skill as the task's agent step;
`--skill` and `--workflow` are mutually exclusive. The CLI checks `GET /skills` first and
includes a `warning` in its JSON result if the skill is missing or the catalog cannot be
checked; it still starts the run. Like a cockpit skill start, if the skill is missing at
execution, the agent uses the plain prompt and the run logs a note. CLI starts do not change
the cockpit composer's recent picks or skill-usage ranking.
Without either flag, `start` still runs `quick-task`.

`start` is retry-safe: it sends a request id (`--request-id <UUID>` to pick your own), and a
retry with the same id and task answers with the run the first one created (`created: false`)
instead of starting a second. Also: `list`, `stop`, `finish`, `diff [--stat]`, `open`.
Use `archive <id>` to hide a task from `list`, `unarchive <id>` to restore it, and
`list --all` to include archived tasks. `list` never shows owned workers, with or without
`--all`: they are steer targets of their parent task. Id-addressed commands (`status`, `wait`,
`send`, `log`, `stop`, …) still accept a worker's id. `archive-finished` sweeps finished tasks (not scheduled runs waiting on a usage limit, and not owned workers, which leave with their parent) and prints
`{"archived": count, "ids": [...], "pinnedIds": [...]}`. The single-task commands print `{"id": "…", "archived": true|false}`.
Exit codes:
`0` ok (`wait`/`start --wait`: the task ended `done`/`review` or stopped for attention), `1` task
failed/cancelled or a message was not delivered, `2` no cockpit or the cockpit refused (its `error`
is passed through), `3` timed out, `64` usage error. `cez task --help` lists every flag.

**When a task needs you.** `status`, `list` and `wait` carry `attention` and `attentionLabel`,
derived by the same function the cockpit's Needs You uses, so the CLI and the cockpit cannot
disagree. Read those rather than the raw status:

- `attention: waiting` (`attentionLabel` "needs you" / "needs review"), `error` or `permission`
  means the task wants a human. A `waiting` task is attention **even when `hasPendingHumanAsk`
  is false** — a finished turn parks the task for follow-up without a structured question. Never
  clear a task on `hasPendingHumanAsk` alone.
- `attention: running` with `attentionLabel` "monitoring" (`status: running`,
  `activity: monitoring`) is neither settled nor attention: the agent is still working on its own
  sub-agents or a watched command, whatever its last log line says.
- `attention: none` with "waiting on 2 workers" is a task parked on its own workers; it will wake
  by itself.

`wait` and `start --wait` stop as soon as a task needs you or ends (`--until attention`, the
default); `--until settled` waits for a terminal status only — for `--autonomous` runs, or a bot
that wants an outcome:

```bash
cez task wait "$id"                                        # stops when the task needs you, or ends
cez task wait "$id" --until settled                        # done/review/failed/cancelled only
cez task start --task-file task.md --wait                  # returns as soon as the agent parks
cez task start --task-file task.md --wait --autonomous --until settled   # runs to completion
```

*Migrating from `--until settled`.* Before 0.16, `wait` and `start --wait` defaulted to
`settled`, so an ordinary interactive task ran out the timeout (exit 3) although the agent had
parked within seconds. The default is now `attention`. A bot that polls for terminal state adds
`--until settled` to its `wait` / `start --wait` calls; nothing else about `settled` changed. Each
run in the `wait` output (and the `start --wait` object) now carries `attention` +
`attentionLabel`, and the output's top level says which `until` was in force, so a caller can tell
"parked for follow-up" (`status: waiting`, `attention: waiting`) from "finished" (`status: done`,
`attention: none`) without knowing cezar's status vocabulary.

**A bot that lives behind an HTTP endpoint** does not have to poll. Set a **Task webhook** (URL
and an optional Bearer token) in the project's **Settings → General**, and every task that opts
in POSTs `task.status` on each status change, `task.question` when it asks something,
`task.activity` when monitoring starts or ends, and `task.subscribed` when it opts in (at start, or when it is handed off). Each
body carries the same slim projection `cez task status` prints, under `task`. `cez task start`
opts in whenever the project has a webhook (`--no-notify` to skip it); the cockpit's New task form
has a **Notify webhook** toggle; and a running task's **Hand off** button (or
`cez task notify <id> --message '…'`) turns it on later with a note for the bot. `notify` (and
`send --notify`) on a worker's id is a usage error that names the parent to notify instead;
`notify --off` still works on one. The note goes to
the webhook only, never to the agent. Delivery is best-effort: 10 s timeout, 3 attempts, and a
failure shows in the thread without touching the task. The token is stored in `~/.cezar` and never
sent back to a browser. Under `CEZ_DRY_RUN=1` nothing is sent; the payload is logged in the thread.

## Workflow format

A workflow is a small YAML file in `.ai/cezar/workflows/`:

```yaml
name: fix-and-verify
description: Implement the task, then verify; retry with failing output on red.
steps:
  - id: implement
    name: Implement
    prompt: "{{task}}"
    skill: project-conventions   # optional — from .ai/skills or .ai/cezar/skills
    # model: opus                # optional per-step model override
    # effort: high               # optional per-step effort: low · medium · high · xhigh · max
    # runner: codex              # optional per-step backend: claude · codex · opencode · pi
    # timeoutMs: 7200000          # optional agent-step wall-clock cap (2 hours); 0 = no limit
    # allowedTools: [Read, Edit, Write, Grep, Glob, Bash]
  - id: verify
    name: Verify
    command: "npm test"          # a check step: exit 0 passes
    onFail:
      retry: implement           # loop back to an earlier step…
      max: 2                     # …at most twice
```

`{{task}}` is replaced with the task text you typed. When a check fails and loops
back, its failing output is appended to the retried agent's prompt so the next
attempt can see what broke.

Agent steps have no wall-clock limit by default, including steps before a check or
another agent. This applies to cockpit tasks, owned workers and `cez run`, on every
runner. Non-final agent steps still close after their turn and advance the chain.
An authored agent step may opt into `timeoutMs`: an integer from `0` to `2147483647`
milliseconds, with `0` disabling the cap. A positive limit measures the entire
session from startup, including waiting; expiry fails the step and stops the chain.
It does not add workflow retry/resume behavior. Check steps reject this field.
Skill shorthand, default tasks and free-form Continue have no wall-clock cap.
All managed sessions have a separate 30-minute no-progress safeguard: while a turn
is open, native stream, tool or heartbeat activity refreshes it. A silent turn
fails and its process is terminated, with SIGKILL escalation if needed. Busy turns
can run longer than 30 minutes. Waiting at a turn boundary or for a human answer
pauses this safeguard; the next turn or answer rearms it. Standalone runner calls
keep their 30-minute wall-clock default. Startup protection and the existing
parked-session lifecycle still apply.

Prefer skills over steps? A workflow can also be written in the portable
shorthand — an ordered list of skill names, each becoming one agent step:

```yaml
name: triage-and-fix
skills: [reproduce, root-cause, implement, self-review]
```

---

## How it runs agents

cezar shells out to your locally installed, logged-in agent CLI —
**your subscription, no API key**. With the default Claude Code backend that
means headless `stream-json` mode, tool access via `--allowedTools`, with
unapproved tools denied without prompting (`--permission-mode dontAsk`) inside
the task's worktree — but note the zero-config default list (`Read`, `Edit`,
`Write`, `Grep`, `Glob`, `Bash`) grants unrestricted `Bash` unless a step sets
`bashAllowlist`, so treat a run as having full shell access in its worktree,
not a sandboxed allowlist. Set `CEZ_APPROVAL_GATE=1` to opt into Claude's
interactive approval UI. Codex and OpenCode are driven through their own
native protocols and don't honor `allowedTools` at all — see
[Coding agent backends](#coding-agent-backends) for what each one actually
locks down. Nothing runs on a server you don't own.

Useful environment variables:

| Var | Effect |
|---|---|
| `CEZ_DELEGATION=1` | Enable owned workers and the private loopback listener for this controller. Off by default; works with the cockpit and headless `cez run`. When disabled, terminal cleanup checkpoints skip conversation/wait history reconciliation; explicit recovery and cleanup termination safeguards remain active. Session instructions and credentials are automatic. |
| `CEZ_DELEGATION_URL`, `CEZ_DELEGATION_TOKEN` | Internal generated session values; do not configure or copy them. Tokens rotate on Continue/restart and are revoked when the session/controller closes. |
| `CEZ_URL` | Cockpit origin for `cez task` and operator `cez discover` (e.g. a hosted `CEZ_REMOTE` cockpit). Unset, they find the local cockpit serving this checkout on ports 4321–4370. Parent discovery uses its delegation controller instead. |
| `CEZ_DRY_RUN=1` | Use bundled mocks for all five agent backends — the cockpit works offline for demos and development. Explicit backend binary overrides still win. |
| `CEZ_AGENT_MODELS_LOCKED=1` | Globally lock each runner to the model configured in its native Claude/Codex/OpenCode settings while keeping runner selection available. Exact `1` also delegates authentication and provider enablement to those native agents, so Cezar skips its credential probes and provider-disable preferences. Existing Cezar presets are preserved but ignored, and an environment change requires a restart. The config-file equivalent is `"modelsLocked": true` in global `~/.cezar/config.json` or one repository's `.ai/cezar/config.json`; config-file locks do not disable provider checks. |
| `CEZ_APPROVAL_GATE=1` | Opt into Claude's interactive approval UI; by default, unapproved tools are denied without interrupting the run. Ignored when `CEZ_CLAUDE_PERMISSION_MODE` is a recognized value (`dontAsk`, `acceptEdits`, or `bypass`). |
| `CEZ_CLAUDE_PERMISSION_MODE` | Claude agent-run permission flag: `dontAsk` (default), `acceptEdits`, or `bypass`. `bypass` passes `--dangerously-skip-permissions` and omits `--permission-mode`. Unset or unknown keeps today's `dontAsk` / `CEZ_APPROVAL_GATE` path. Provider verification commands are never given this flag. |
| `CEZ_CLAUDE_SETTING_SOURCES` | When set, Claude agent runs also pass `--setting-sources <value>` (e.g. `user,project,local`). Unset or empty omits the flag. Provider verification is never given this flag. |
| `CEZ_FOLLOWUPS=1` | Turn on the global follow-up **Inbox**: agents are asked to leave follow-ups in `todos.json` when they finish, and the Inbox view appears. Off by default — each task's own **Notes** handoff journal runs either way. |
| `CEZ_AUTOMATIONS=1` | Turn on **automations** (GitHub polls and schedules): the Automations view appears and cezar runs each enabled automation while it is open, launching an ordinary task per match or per occurrence. A schedule (daily, weekdays, weekly, every N hours, in the server's time zone) needs no GitHub remote; a GitHub automation polls on its interval. Off by default, and only the exact value `1` enables it — without it nothing polls or fires, the automations endpoints answer `409`, and the nav item is absent. Read at boot, so restart after changing it; definitions, receipts and high-watermarks are retained, so unsetting it and restarting restores the feature without migration or data loss. |
| `CEZ_PREVIEW=1` | Turn on **live preview** (experimental): agents register a dev server with the `cezar_preview_serve` tool, and the cockpit opens it in a headless Chromium on the host, docked next to the task. cezar first runs a registered command after you press Run and open. Agents can then use `cezar_preview_stop({ port, restart?: boolean })` to stop or restart their own Cezar-started server with that unchanged approval; changed command, cwd or path needs Run and open again. Adopted servers cannot be stopped by this tool. Off by default, and only the exact value `1` enables it — without it the tool is not listed, its route and the preview WebSocket refuse, and `capabilities.preview` is `false`. Read at boot, so restart after changing it. |
| `CEZ_PREVIEW_NO_SANDBOX=1` | Launch the preview's Chromium with `--no-sandbox`. Off by default and never added automatically, not even for root or in a container; use it only where Chromium's sandbox cannot start, and only for pages you trust. Only the exact value `1` applies. Read at boot. |
| `CEZ_AUTOSAVE=1` | Re-enable the periodic (90 s) autosave commit in task worktrees. Off by default (open-mercato/cezar#471) — turn-end and pre-PR flushes always run, so branches still end complete. Every autosave names its trigger in the commit subject (`cezar autosave (periodic)` vs `(turn end)` / `(run finalize)` / `(pre-PR)`), so the flushes you keep are distinguishable from the timer you disabled. |
| `CEZ_CLAUDE_BIN=/path/to/claude` | Override which `claude` binary is used. |
| `CEZ_CODEX_BIN=/path/to/codex` | Override which `codex` binary is used. |
| `CEZ_OPENCODE_BIN=/path/to/opencode` | Override which `opencode` binary is used. |
| `CEZ_PI_BIN=/path/to/pi` | Override which `pi` binary is used. |
| `CEZ_OMP_BIN=/path/to/omp` | Override which `omp` (Oh My Pi) binary is used. |
| `CEZ_CURSOR_BIN=/path/to/agent` | Override the Cursor CLI (`agent`) executable. |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME` | The agents' **own** variables, honoured where the vendor documents one. Setting one moves that agent's **default account** — the config folder cezar discovers. A *second* login of the same CLI is deliberately not an environment setting, since one process-wide value cannot differ per project: add it under **Settings → Agent accounts** and pick it per project. |
| `CEZ_BROWSE_ROOT=~/` | Default root for **Add project → Open local folder…**. The picker cannot navigate above it; a saved workspace value overrides the environment default and must name an existing folder. |
| `CEZ_PROJECTS_DIR=~/cezar/projects` | Default destination for **Clone from GitHub**. Saved workspace settings override it, and missing directories are created recursively. |
| `CEZ_SKILLS_AUTO_UPDATE=0` | Disable automatic checks and updates for upstream-CLI-tracked Open Mercato skill installations. On by default; a saved global Skills setting overrides this environment default. Checks are delayed, bounded, cached, and non-blocking. |
| `CEZ_AUTONOMOUS_DEFAULT=0` | Seed the New Task Autonomous default (`0` or `1`). Without a seed, skills default on and workflows off; a saved global Resources setting overrides it. |
| `CEZ_WORKTREE_DEFAULT=1` | Seed the New Task Worktree default (`0` or `1`). Without a seed, eligible runs default on; a saved global Resources setting overrides it. |
| `CEZ_DISABLE_REPO_LOCK=1` | **Dangerous escape hatch:** allow any run executing in the repository root — an explicit `worktree=false` run, non-Git degradation, or a continuation whose worktree cannot be restored — to proceed without Cezar’s repository-root lease. Agents can overwrite each other’s files or Git state; isolated worktree runs are unaffected. Off by default; only the exact value `1` enables it. |
| `CEZ_SINGLE_PROJECT=1` | Opt into a launch-project-only cockpit: only the exact value `1` enables it. Project add, edit, checkout, folder browsing, and removal are refused and only the launch project is shown. Off by default; stored registry rows are retained, so unsetting it and restarting restores the full multi-project workspace without migration or data loss. |
| `CEZ_HIDE_TOKEN_USAGE=1` | Hide raw input/output token counts throughout the browser cockpit while leaving backend-reported cost visible. Only the exact value `1` enables it; telemetry and API payloads are unchanged, and a restart is required after changing it. |
| `CEZ_HIDE_COST=1` | Hide backend-reported monetary cost throughout the browser cockpit while leaving raw input/output token counts visible. Only the exact value `1` enables it; telemetry and API payloads are unchanged, and a restart is required after changing it. |
| `CEZ_HIDE_TOKEN_METRICS=1` | Legacy master switch that hides both token usage and cost. It takes precedence over the two independent flags; only the exact value `1` enables it, payloads are unchanged, and a restart is required. |
| `GITHUB_TOKEN` | Fallback for GitHub reads/PRs when `gh` isn't authenticated. |
| `CEZ_ENV_PASSTHROUGH=A,B` | Forward these extra host env vars to spawned agents. By default agents get a least-privilege env (safe shell/toolchain vars + the backend's own auth + `GITHUB_TOKEN` + `CEZ_*`), not your full environment — use this to add a var an agent needs. A dev server live preview starts gets the same env without the backend's auth and `GITHUB_TOKEN`, plus these names. |
| `CEZ_AGENT_ENV_FULL=1` | Escape hatch: give spawned agents, and dev servers live preview starts, the full host environment (pre-hardening behavior). Off by default; only set it if you understand that this hands every host secret to the agent process. |
| `CEZ_AGENT_TMPDIR=0` | Stop giving each task its own temp directory and hand agents the host `TMPDIR` again (pre-open-mercato/cezar#785 behavior). On by default: every run gets `TMPDIR`/`TEMP`/`TMP` pointing at `.ai/cezar/tmp/<task-id>`, created and write-probed before the agent spawns, kept across session close, Continue, and restart while the task is live, and reaped at terminal completion or history deletion (hearsay-tools/cezarion#515) — and kept short enough for unix-socket paths: a checkout so deep that `.ai/cezar/tmp/<task-id>` would cross the kernel's socket-path limit resolves it to a `cez-agent-…` directory under the system temp dir instead (hearsay-tools/cezarion#387), with its location recorded so host temp-environment changes cannot move live scratch. So concurrent tasks stop sharing one directory and a task refuses to start rather than run against a temp directory that silently swallows its shell output (see Troubleshooting below). Only an exact `0` disables it, and it disables the whole thing — the pre-spawn check included, so this stays an escape hatch you can actually take. |
| `CEZ_REDACT_SECRETS=0` | Disable scrubbing of credential values/token shapes from the on-disk state (the NDJSON transcript and the free-text fields of the run records in `runs.db`). On by default; leave it on. Controller-generated delegation tokens are always scrubbed. Best-effort defense-in-depth, not a guarantee: it catches known token shapes and the values of your own secret-named env vars, so a credential in neither category can still get through. |
| `CEZ_TITLE_UPDATES=0` | Turn off the live task-title refresh (namer re-runs on each turn end). The Settings → Agents toggle overrides this default. |
| `CEZ_AUTONAME=0` | Disable ALL LLM task naming (creation + live) — titles stay heuristic (`437: /om-auto-review-pr`). Under `CEZ_DRY_RUN=1` naming is already off unless forced with `CEZ_AUTONAME=1`. |
| `CEZ_REVIEW_GATE=1` | Turn ON the optional diff-first review gate (open-mercato/cezar#489): a successful, non-autonomous run with changes parks at `review` (Accept / Send back / Draft PR) instead of finishing. Off by default — changed runs settle to `done` with the diff left in the worktree. Only `1` enables. The Settings → Agents toggle overrides this; autonomous runs always skip it. |
| `CEZ_NO_BANNER=1` | Skip the `open-mercato/skills` banner on `cez serve` startup. (The cockpit no longer shows a banner — its skills now live on the Skills page's Manage panel — so this env var is the terminal banner's only switch.) |
| `VITE_CEZ_API_BASE=http://localhost:4321` | **Build time only**, and only when the cockpit bundle is deployed apart from the service it talks to. Empty (the default) means "the origin that served this page", which is right for both normal cases: the CLI serves the bundle itself, and `npm run dev` proxies `/api` to the local service. A deployment that must be configured without a rebuild can put `<meta name="cez-api-base" content="…">` in the served HTML instead, which wins over this. |
| `VITE_CEZ_E2E=1` | **Build time only.** The cockpit e2e suite sets this when it builds the bundle it drives. It pins `useNow` and every `refetchInterval` so a wait cannot span a 30s tick or a 4s poll. Leave unset for production. |

### Troubleshooting: the agent's shell returns nothing

**Symptom.** A task on the Claude backend keeps working, but every shell command
comes back with no output and a spurious non-zero exit status — `echo hello`
included. Redirecting into a file inside the worktree still produces the right
content, so the commands genuinely run; only the *capture* is lost. Codex tasks
on the same machine are unaffected, because that backend streams over stdio
pipes instead of round-tripping a command's output through a temp file.

**Diagnosis.** The temp directory the agent was given is out of space or out of
quota. One line tells you:

```bash
echo probe > "${TMPDIR:-/tmp}/probe"   # "Disk quota exceeded" / "No space left on device"
df -i "${TMPDIR:-/tmp}"                # a tmpfs can exhaust inodes long before bytes
```

Under quota the file is *created* and the write then fails, so the backend reads
back a zero-byte capture file and hands the agent an empty result.

**Fix.** Since open-mercato/cezar#785 cezar gives each task its own `TMPDIR` under
`.ai/cezar/tmp/<task-id>` and write-probes it before spawning, so a broken temp
directory fails the task with `agent temp directory is not writable: …` on the
task thread instead of corrupting its work. If you see that error, free space on
the disk holding the repo. `CEZ_AGENT_TMPDIR=0` turns the whole mechanism off —
per-task directory and pre-spawn check alike — and hands agents the host
`TMPDIR` again, which is the way out if the check itself is wrong on your
platform.

### Troubleshooting: tools inside a task fail with a socket-path error

**Symptom.** Inside a task, `npm install`, `npm run typecheck`, or another tool
dies with `listen EINVAL` or a "socket path too long" / `ENAMETOOLONG` error —
with `TMPDIR=/tmp` set by hand, the same commands succeed. Tools like `tsx` bind
*named* unix sockets under `TMPDIR` (its IPC server builds
`<tmpdir>/tsx-<uid>/<pid>.pipe`), and the kernel caps a socket path at 104–108
bytes — a temp directory near that length leaves no room for the name.

**Fix.** Since hearsay-tools/cezarion#387 cezar keeps each task's temp directory at most 78 bytes. A
checkout deep enough to push `.ai/cezar/tmp/<task-id>` past that limit gets a
short `cez-agent-…` directory under the system temp directory instead — still
per-task, still write-probed before the agent spawns, still reaped when the run
ends. Checkouts whose path already fits keep the repo-local directory.
`CEZ_AGENT_TMPDIR=0` reverts the whole mechanism to the host `TMPDIR`.

---

## Coding agent backends

cezar is not married to one vendor. Every agent step runs through a single
`AgentRunner` seam with six built-in backends:

| Backend | CLI | How cezar drives it | Tool access |
|---|---|---|---|
| **Claude Code** (default) | [`claude`](https://github.com/anthropics/claude-code) | Headless `stream-json` mode. | Per-tool `--allowedTools` (`bashAllowlist` scopes `Bash`); `dontAsk` denies unapproved tools without prompting (`CEZ_APPROVAL_GATE=1` → `acceptEdits` + approval UI; `CEZ_CLAUDE_PERMISSION_MODE=bypass` → `--dangerously-skip-permissions`). |
| **Codex** | [`codex`](https://github.com/openai/codex) | `codex app-server` — JSON-RPC over stdio, the same transport the Codex IDE extensions use. | Ignores `allowedTools`; inherits managed permissions and Codex approval defaults. Confirmed unmanaged sessions use `danger-full-access`. `CEZ_CODEX_NETWORK=0` requires network restriction: unmanaged sessions use network-blocked `workspace-write`; managed filesystem rules remain intact, and an unconfirmed network restriction stops before any turn. If requirements discovery is unavailable, Codex permission defaults apply. |
| **OpenCode** _(experimental)_ | [`opencode`](https://opencode.ai) | `opencode serve` — a local HTTP server with an SSE event stream. | Ignores `allowedTools` entirely; every permission is auto-approved. |
| **Cursor** | [`agent`](https://cursor.com/docs/cli/installation) | Qualified builds use resumable `--print --output-format stream-json` turns; other builds and legacy sessions use ACP. | Print mode admits marketplace plugins, including user and team plugins, and narrows known native delegation tools for governed runs. Per-run `allowedTools` and `bashAllowlist` are unsupported. |
| **pi** _(experimental)_ | [`pi`](https://github.com/badlogic/pi-mono) | Persistent `--mode rpc` over JSONL; models are picked with the `provider/model` convention. | Maps `allowedTools` onto pi's `--tools` allowlist; default sessions also pass harness extras (`Subagent`, `SubagentSupervisor`, `SubagentWait`) through `--tools`, and an explicit `allowedTools` still restricts. A configured `bashAllowlist` disables Bash because pi cannot express command-prefix rules. |
| **OMP** _(experimental)_ | [`omp`](https://github.com/can1357/oh-my-pi) | Persistent `--mode rpc` over JSONL (Oh My Pi, a pi fork); models use the `provider/model` convention and are discovered from `omp models --json`. | Maps `allowedTools` onto OMP's `--tools` allowlist (`[]` becomes `--no-tools`); default sessions also pass `todo`, `lsp`, `ast_edit`, `task` and `wait`. A configured `bashAllowlist` disables `bash` because OMP cannot express command-prefix rules. |

> ⚠️ **OpenCode, pi and OMP support are experimental.** These runners work but are less
> battle-tested than the Claude Code and Codex backends, and OpenCode auto-approves
> every permission (it ignores `allowedTools`). Treat them as previews and expect
> rough edges.

On startup cezar probes which CLIs are installed and the cockpit only offers
the backends it found — install any one of the six and you're operational.

### Cursor CLI

Install [Cursor CLI](https://cursor.com/docs/cli/installation) and run `agent login`,
or set `CURSOR_API_KEY`. Cezar discovers `agent` on PATH; `CEZ_CURSOR_BIN` overrides
its location. Select **Cursor** in the runner picker. On the qualified
`2026.10.01-e373342` build, new sessions use print mode so marketplace plugins
are available. Cezar checks `agent --version` and the native tool catalog before
the first turn; `agent --version` is also the quick way to check your installation.
Other builds use ACP, which may not see marketplace plugins. Existing ACP
sessions continue on ACP so their conversation history is preserved.
A missing CLI leaves the other backends available. `CEZ_DRY_RUN=1` uses the mock.
Cursor questions from a plugin may be automatically skipped by print mode. Cezar's
own `CEZ:ASK` questions remain answerable in the cockpit; plugins that require
native questions may not work fully. Project-local Claude plugin settings may
not disable a user or team marketplace copy. A previously confirmed Cursor
session ID can also lose history inside Cursor without an error; Cezar resumes
the recorded ID and checks that Cursor returns the same ID.
Cursor provides no qualified token-usage telemetry; Cezar leaves usage unavailable
instead of estimating it. In ACP mode, Cezar negotiates Cursor’s parameterized model picker and
shows only the effort levels the selected model advertises. The runner applies
`effort` or `reasoning` through ACP session config options before prompting;
unsupported explicit values fail instead of silently using a default. Initial models
are pinned with `--model`; opaque parameterized IDs and legacy model discovery
remain compatibility paths for older CLIs.

Settings → Agent config exposes Cursor’s global `cli-config.json`, project
`.cursor/cli.json` permissions, `.cursor/mcp.json`, and shared `AGENTS.md`.
[Cursor’s configuration reference](https://cursor.com/docs/cli/reference/configuration)
documents `CURSOR_CONFIG_DIR` and the Linux/BSD `XDG_CONFIG_HOME/cursor` override.
These select configuration; Cezar does not offer alternate Cursor account profiles
because a complete credential-and-session home override has not been verified.


### OMP (Oh My Pi)

Install [OMP](https://github.com/can1357/oh-my-pi) (`curl -fsSL https://omp.sh/install | sh`
installs a prebuilt binary; Bun is needed only for `--source`) and run `omp login`. Cezar discovers `omp` on PATH;
`CEZ_OMP_BIN` overrides its location. `omp` is a separate backend from `pi`: a host with
both binaries keeps both, and `CEZ_PI_BIN` never selects OMP. Select **OMP** in the runner
picker to use a persistent `--mode rpc` session. A missing CLI leaves the other backends
available and shows OMP as unavailable. `CEZ_DRY_RUN=1` uses the mock.

Agents ask questions through cezar's `CEZ:ASK` marker, and OMP's own sub-agents appear in the
Agents drawer. Settings → Agent config exposes OMP's `config.yml`, `mcp.json` and
`AGENTS.md` files. Named OMP profiles and accounts are not supported yet.

**Pick a backend at three levels** (most specific wins):

1. **Config default** — `"defaultRunner": "codex"` in `.ai/cezar/config.json`.
2. **Per task** — the backend picker next to the task box in the cockpit.
3. **Per workflow step** — `runner:` on any step in the YAML.

Per-step overrides are what make **mixed-agent strategies** a one-liner:
implement with one agent, review with another, and let a shell check referee:

```yaml
name: implement-and-cross-review
steps:
  - id: implement
    name: Implement
    prompt: "{{task}}"
    runner: codex                # one vendor writes the code…
    effort: medium               # …with a cheaper reasoning pass
  - id: review
    name: Cross-review
    prompt: "Review the diff produced for: {{task}}. Fix real issues only."
    runner: claude               # …another one reviews it
    effort: high                 # …with more reasoning for review
  - id: verify
    name: Verify
    command: "npm test"
    onFail: { retry: implement, max: 2 }
```

Parallel variants (×2/×3) of one task share that task's backend — mixing
happens per task and per step, not inside a variant group.

**Models come from your own machine.** For Claude, Codex, OpenCode, and Pi, the model picker
is not a list cezar ships — it asks the installed CLI what it can actually run
(Claude stream-json `list_models`, `codex app-server`'s `model/list`,
`opencode models`, and `pi --list-models`), caches the answer in
memory for five minutes, and shows it. A model your provider rolled out
yesterday is selectable without a cezar release, and one it retired stops being
offered. Claude discovery starts no model turn and uses safe mode with no session
persistence. It has a 15-second deadline and a 200-model cap, with child cleanup
on every outcome. Unsupported or unavailable Claude CLIs fall back to the
`opus`, `sonnet`, and `haiku` aliases. `auto` (let the agent decide) is always
available, including when the CLI is missing, logged out, or slow — discovery
never blocks the cockpit, and a model you pinned yourself stays selectable even
if it is absent from the discovered list.

The seam is deliberately small: a backend is one class implementing the
`AgentRunner` interface (`packages/cezar/src/core/agent-runner.ts`) that turns a prompt into
a stream of normalized events. Other CLIs — pi, aider, whatever ships next —
can slot in the same way.

---

## Remote access (host cezar on a server)

cezar runs on `localhost` by default. To reach the cockpit from another machine —
a shared team box, a VPS, your phone — put an **authenticated public front** in
front of it. The built-in installer does this interactively, per **platform
strategy**, and never escalates silently: every privileged command is printed
and verified, and it ends with a real authenticated end-to-end check.

```bash
npx cezarion server-install   --platform ubuntu-vps   # stand it up
npx cezarion server-deploy    --platform ubuntu-vps   # roll out a new version (reload the service)
npx cezarion server-uninstall --platform ubuntu-vps   # reverse it

# host a SECOND cockpit for another domain on the same box (ubuntu-vps):
npx cezarion server-install   --platform ubuntu-vps --domain shop.example.com
```

On `ubuntu-vps` a single host can run several independent cockpits — add
`--domain <host>` and each gets its own port, nginx site, login and service; a
new domain never resumes or clobbers the first install.

**Already running a reverse proxy?** If Dokploy, Coolify, Caddy or your own
nginx already owns `:80/:443`, cezar's would fight it for the ports. Install the
service only and let your proxy front it:

```bash
npx cezarion server-install --platform ubuntu-vps \
  --external-proxy --domain cezar.example.com --bind-host 172.17.0.1
```

`--bind-host` is only needed when the proxy runs in a **container** (Traefik
can't reach the host's loopback); a host-installed proxy uses the `127.0.0.1`
default. In this mode **your proxy must enforce authentication** — cezar has
none of its own. [Details →](docs/server-install/ubuntu-vps.md#the-box-already-has-a-reverse-proxy-dokploy-coolify-caddy)

| Provider | `--platform` | Public front | Guide |
|----------|--------------|--------------|-------|
| Ubuntu / Debian VPS | `ubuntu-vps` | nginx + Let's Encrypt HTTPS, htpasswd login, systemd | [Step-by-step →](docs/server-install/ubuntu-vps.md) |
| Ubuntu + existing proxy | `ubuntu-vps --external-proxy` | your Dokploy/Traefik/Caddy front; cezar ships the service only | [Step-by-step →](docs/server-install/ubuntu-vps.md#the-box-already-has-a-reverse-proxy-dokploy-coolify-caddy) |
| macOS + ngrok | `macosx-ngrok` | ngrok tunnel + `--basic-auth`, launchd | [Step-by-step →](docs/server-install/macosx-ngrok.md) |

See the **[Remote access overview](docs/server-install/README.md)** for how it
works and how to redeploy new versions.

---

## Reviewing task files

File links in task messages open the Files tab at the selected file, rather than
navigating to a host path under the cockpit URL. The selection stays in the URL,
so bookmarks and browser Back work. This works with local and remote cockpits.

For a deliverable outside the project, an agent must explicitly publish a snapshot:

```sh
cez artifact publish /tmp/decision.md
```

Cezar supplies the bundled command and task context to agent sessions automatically
(`CEZ_TASK_ID` and `CEZ_ARTIFACTS_DIR`; do not configure these yourself). The command
returns JSON with a Markdown link for the agent to share. When the owning project
is registered, the link keeps that project when copied or opened from another
project. If ownership cannot be discovered, publication keeps the legacy task link.
The Files tab also lists published artifacts. It previews text, Markdown and raster
images; other formats can be downloaded. HTML/scripts never execute inside the cockpit, and embedded
images in Markdown documents do not load automatically.

Snapshots do not change when the original file changes. They survive worktree
removal and are removed with task history, including normal history retention.
Publication is limited to 10 MiB per file, 64 snapshots and 64 MiB per task; reaching
a limit refuses the new publication without evicting earlier files. There is no
arbitrary host-file reader or automatic collection of mentioned paths. Publish
only intended review material, never credentials or unrelated private files.

## Configuration (optional)

Zero config is the default — everything below is opt-in via
`.ai/cezar/config.json` (a missing or invalid file simply uses the defaults, and
never blocks startup):

```jsonc
{
  "skillsRepos": [{ "repo": "open-mercato/skills", "ref": "main" }], // team skills; [] disables
  // Team-skill repos are code-trusted: a skill body becomes an agent system prompt.
  // Only owner/name, https/ssh URLs, or local paths (`/abs`, `./rel`, `~/dir`,
  // `C:\dir`) are accepted — no ext::/fd:: transport helpers. Write a relative
  // path as `./name`, not a bare `name`. Pin `ref` to a full commit SHA to freeze
  // the source against a moving branch head — cezar verifies it resolves to
  // exactly that commit, and reports it as `team.commit`.
  "worktreeRetention": 10,   // keep the last N finished worktrees on disk; 0 = unlimited (branch always kept)
  "defaultRunner": "claude", // agent backend: "claude" (default) · "codex" · "opencode" · "pi"
  "modelsLocked": true,      // optional: native per-runner model is fixed/read-only; runner stays selectable
  "plannerModel": "sonnet",  // model the "Plan first" button uses to draft chains
  "baseBranch": "develop"    // branch worktrees fork from + PRs target (also settable in the Git tab)
}
```

Put the same `"modelsLocked": true` key in `~/.cezar/config.json` to apply it
to every registered project. When the key is absent or `false` in both config
files (and `CEZ_AGENT_MODELS_LOCKED` is not `1`), each runner's normal model
selector uses that runner's discovered model list. While locked, the model is
shown read-only and follows the selected runner's native settings; the runner
itself remains selectable.

Run data (`runs.db` and its `-wal`/`-shm` files, the `runs.json.pre-sqlite*.bak`
backups, NDJSON event logs, worktrees, `todos.json`) is git-ignored
automatically; your workflows and skills stay committable.

Settings that belong to *you* rather than to a repo — the parallel cap
(`maxParallel`, default **2**), the per-task memory ceiling and the checkout
root — live once in `~/.cezar/config.json`, alongside the
[project registry](#multiple-projects-one-cockpit), and are edited from
**Settings → Resources** and **Settings → Projects**. A `maxParallel` left over
in a repo's `.ai/cezar/config.json` is imported into the workspace file the
first time cezar boots there, and ignored afterwards.

### Editing the agents' own config (Settings → Agent config)

cezar picks *which* agent runs; **Settings → Agent config** lets you edit *how* it
behaves — the raw config files Claude, Codex and OpenCode read for settings,
MCP, and memory. In the multi-project cockpit the section is project-scoped:
repo-relative files resolve from the selected project's root, while user-scope
files continue to resolve from the agent's home.

Each file keeps its native format and vendor-documented precedence. Tracked
files reach task worktrees after commit; Claude's gitignored personal layer is
seeded into each run's worktree. Editing is a local-machine capability, so a
hosted cockpit (`CEZ_REMOTE=1`) is read-only and never serves home-file contents.

---

## Local development

End-to-end, from a fresh clone to a global `cez` command you can run in **any**
repo on your machine — no npm publish required.

**1. Prerequisites** — Node 24.15+ and `git` (plus at least one logged-in agent CLI,
as in [Quick start](#quick-start)).

**2. Clone & install**

```bash
git clone https://github.com/wjarka/cezar.git
cd cezar
npm install
```

**3. Build** — compiles the api-client and the server (`tsc → packages/cezar/dist/`) and the cockpit
(`vite build → packages/cezar/web/dist/`), then runs the pack gate:

```bash
npm run build
```

**4. Install as a global command** — build + put `cezarion` / `cez` on
your PATH pointing at *this checkout*:

```bash
npm run install-as-command            # live link (default) — see the change loop below
#   or: npm run install-as-command:global   # self-contained snapshot copy
```

Now `cd` into any other repo and run it:

```bash
cd ~/some-other-project
cez              # cockpit for that repo, straight off your checkout
cezarion --help  # same binary; the name matches `npx cezarion`
```

**5. The change loop**

- **Link mode** (default): edit source → `npm run build` → the global command
  reflects it immediately. No relink needed. (It is a live symlink into this
  checkout — don't move or delete the checkout while it's linked.)
- **Snapshot mode** (`:global`): re-run `npm run install-as-command:global` to
  refresh the installed copy. It survives moving/deleting the checkout.

**6. Uninstall**

```bash
npm run uninstall-as-command    # removes cezarion / cez (either flavor)
```

**7. Troubleshooting**

- **`cez: command not found`** after install → your npm global bin dir isn't on
  PATH. The script prints the exact dir; add it to your shell profile
  (`export PATH="$(npm prefix -g)/bin:$PATH"`).
- **`EACCES` / permission denied** → your global prefix is root-owned. Point npm
  at a user-writable one and retry — **never** sudo:
  `npm config set prefix ~/.npm-global`.
- **Already installed the published `@wjarka/cezarion` globally?** The
  link/snapshot install replaces it; `uninstall-as-command` removes ours, and
  `npm i -g @wjarka/cezarion` brings the published one back.

### In-checkout scripts

```bash
npm run dev          # server (API :4321) + Vite dev server, opens the cockpit in the browser
npm run dev:server   # tsx packages/cezar/src/index.ts — the API server alone
npm run dev:web      # Vite dev server alone (proxies /api to :4321)
npm run build        # tsc → packages/cezar/dist/, vite build → packages/cezar/web/dist/, then the pack gate
npm run typecheck    # refresh server declarations, then check all four workspaces
npm run typecheck:web # refresh server declarations, then check web sources
npm test             # vitest — server + cockpit unit suites
npm run test:changed # iteration only: tests related to branch + working-tree changes
npm run test:unit    # node:test — fast core-module tests
npm run test:package # pack/install and exercise the built CLI
npm run test:e2e     # real-browser cockpit suite (agent-browser)
npm run test:e2e:local # full browser suite in four isolated, concurrent lanes
```

The four-lane local browser run needs roughly 8 GiB of RAM at peak. It keeps CI's
serial-per-shard policy unchanged. See [cockpit E2E testing](packages/web/e2e/README.md#full-local-suite-in-four-lanes)
for lane isolation, logs, and cleanup.

For iteration, run affected test files or `npm run test:changed` (inspect with
`-- --plan`; override the local main comparison with `-- --base=<ref>`).
The changed-test command includes staged, unstaged and untracked changes and
falls back to full Vitest on shared/configuration/unknown input or missing Git
history. It is not a substitute for final verification. See `AGENTS.md` § Validation
for targeted browser commands and the final-gate/evidence-reuse policy.

Both `npm run typecheck:web` and
`npm run typecheck -w @open-mercato/cezar-web` rebuild server declarations from
the current checkout before checking web sources. Run `npm ci` in each new
worktree first. The full `npm run typecheck` starts with the web check, so it
prepares declarations once before checking the remaining workspaces. Calling
`tsc --noEmit` directly skips this preparation and can consume stale declarations.

CI runs two duration-balanced Vitest shards alongside the build and package checks.
See [CI verification](docs/sdlc/ci.md) for the job graph and local commands.

The stack is deliberately small: **TypeScript** (strict, ESM), **Hono** + SSE for
the server, **Zod** at every boundary, **YAML** for workflows, and a **React 19 +
Vite + Tailwind v4 + shadcn/ui** cockpit shipped pre-built in `packages/cezar/web/dist/` — the
published package carries the built app, so `npx` users never run a bundler.
Every module is meant to be read in one sitting.

---

## License

**MIT** © Patryk Lewczuk — full text in [LICENSE](LICENSE).
