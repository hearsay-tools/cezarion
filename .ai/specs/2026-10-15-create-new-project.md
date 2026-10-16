# Create a new project from the cockpit

> Status: implemented · Date: 2026-10-15 · Extends: `2026-07-20-multi-project-workspace`
> Issue: hearsay-tools/cezarion#1014 · Ports: open-mercato/cezar#1402 (`0504ec91`), adapted

## Problem

**Add project** could open an existing folder or clone an existing GitHub repository, but it
could not start a project from nothing. Starting one meant leaving the cockpit to `git init`,
maybe `gh repo create`, and then registering the folder.

## What it does

**Add project → New project…** (the rail's **+**, the mobile drawer, and the Tools page) creates
`<checkout root>/<name>` as a git repository on `main` with one empty commit (`Initial commit`),
registers it, and opens it.

- **GitHub only when asked.** "Also create a private GitHub repository" is **off when the dialog
  opens**, even with `gh` signed in (upstream defaults it on). The repository is always private:
  `--private` is a constant in `create-project.ts`, the request has no visibility field, and one
  must never be added.
- **Owner.** The signed-in account first, then its organisations, as cards (native radios).
- **Start with** an empty repository, or — with GitHub on — a GitHub template: any `owner/repo` or
  URL, or one of the curated suggestions in `packages/web/src/lib/github-templates.ts` (each
  checked as a live, non-archived template repository; re-check when editing).
- **Name** must be a valid GitHub repository name starting with a letter or digit, even for a
  local project, because it names the folder and (now or later) the repository. A typed space
  becomes `-`.

## API

Workspace-level, chained beside `/projects/checkout`, schemas in `packages/contract/src/projects.ts`:

- `POST /api/v1/projects/create` `{ name, github?: { owner, template? }, checkoutId? }` → the
  register shape `{ project }` plus an optional `warning`. Errors `{ error }` (400/409/500) or
  `{ error, reason }` (503, `gh` missing or signed out).
- `GET /api/v1/projects/github-owners` → `{ available: true, owners }` or `{ available: false,
  reason }`, never an error status.
- Progress reuses the `checkout-progress` workspace event and the clone dialog's recovery route
  (`GET /api/v1/projects/checkout/:checkoutId/progress`); the terminal `done` event carries the
  additive `warning?`.

## Order of operations, and what a failure leaves

Everything checkable is checked before the folder exists: the name; with GitHub, `gh` present
and signed in (503), `<owner>/<name>` free on GitHub (409), the template a live template (400).
Then the checkout root is created on demand and the target with the clone flow's
ownership-token `mkdir` (an existing folder is a 409 and is never touched).

| Path | Steps |
| --- | --- |
| Local | `git init -b main`, `git commit --allow-empty` |
| GitHub, empty | the local steps, `gh repo create <owner>/<name> --private`, HTTPS `origin`, the `gh` credential helper (open-mercato/cezar#968), `git push -u origin main` |
| GitHub, template | `gh repo create … --private --template`, wait (≤ 30 s) for the generated commit, `gh repo clone <https url>`, the credential helper |

| Failure | Outcome |
| --- | --- |
| Before `gh repo create` (including a closed tab) | Local folder removed; nothing exists anywhere |
| Initial commit (usually no git identity) | Local folder removed; the error says how to set `user.name`/`user.email`. **Diverges from upstream**, which registered a repo without a base commit; a task worktree needs one |
| `gh repo create` itself | Local folder removed; gh's message shown. A failure does not prove GitHub did nothing (a timeout or dropped connection can land after it acted), so the name is checked again and the error says whether the repository exists now and how to recover |
| After it: remote, credentials or push | **Kept and registered**; `warning` names the repository and every remaining command. The dialog stays open to show it. Deleting the folder would leave a GitHub name a retry could never take |
| Template clone, or a clone with no commit (generation outlasted the wait) | Local folder removed (nothing to keep); the error names the repository and says to use **Clone from GitHub** |
| Registration | The repository is kept; the error names its path |

From `gh repo create` on, the request's abort signal is no longer passed down, so the run never
stops somewhere it cannot report on. cezar never deletes a GitHub repository, and never adopts
one it cannot prove it made.

Every `gh` command runs with `GH_HOST=github.com`: every URL, remote and command this flow names
is github.com, and an ambient `GH_HOST` (GitHub Enterprise) would otherwise list owners on, and
create the repository on, another server.

## Hosted mode

A hosted cockpit (`localHandoff: false`) creates **local projects only**: create with `github`
answers 409, and the owners route answers `available: false` without running `gh`, so a remote
viewer neither acts with the host's GitHub account nor sees its login and organisations. The
target is checked against the browse root (lexically, then by realpath of its nearest existing
ancestor) before anything is created.

## Not included

Upstream's telemetry events; public or internal repositories; other forges; scaffolding files;
templates without GitHub. `CEZ_DRY_RUN=1` runs real `git` and fakes `gh` (and `git push`).
