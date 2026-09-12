# Isolated runtime fixture

This directory contains QA-only fixture tools. It makes no application source changes. The original iteration-2 design audit is historical and superseded by the user's new 193-frame upload. Do not use its screenshots to accept current design parity.

The current confirmed one-frame export is in the parent worktree at `.ai/design-reference/iteration-3/design/19A-inbox-desktop-light.png`, with adjacent proof JSON. Source SHA256: `56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8`. It was exported in a fresh pen.dev session by exact frame name, `19A. Inbox · Follow-up review` (`e8wQer`), at 2× (2880×2240). Visual work is on hold for the user's source confirmation.

## Reproduce the fixture

Run from the target source worktree. Use a separate browser session when multiple workers share a machine. The browser wrapper expects the existing agent-browser binary at `/home/agent/.cache/agent-tools/agent-browser/agent-browser-linux-x64`.

```sh
npm ci
npm run build
node .ai/qa/runtime-verified/serve-fixture.mjs "$PWD" 44629
```

Keep that command running in its own terminal. In another terminal, from the same worktree:

```sh
export RUNTIME_BROWSER_SESSION=runtime-e2fa-short
.ai/qa/runtime-verified/browser.sh open http://127.0.0.1:44629/p/default/new
.ai/qa/runtime-verified/browser.sh wait 1000
node .ai/qa/runtime-verified/verify-proof.mjs
node .ai/qa/runtime-verified/verify-fixture.mjs
node .ai/qa/runtime-verified/mock-api.mjs
```

Use absolute screenshot destinations with agent-browser. Its CLI can interpret a relative path as a selector and save elsewhere.

```sh
.ai/qa/runtime-verified/browser.sh set viewport 1440 1120
.ai/qa/runtime-verified/browser.sh screenshot "$PWD/.ai/qa/runtime-verified/example.png"
```

`serve-fixture.mjs` seeds a real isolated Git repository under `fixture-repo-v2/`: four completed/review tasks, a parent/worker relationship, PR links and resource totals, a short transcript, historical rich transcript fixtures, a saved workflow, a local skill, two task variants, follow-up inbox data, branches, committed changes and a dirty README. It runs the **target source's built CLI**, never a global installed server. `CEZ_HOME` and vendor configuration locations are isolated beneath this directory. Its child environment contains PATH and explicit fixture flags/paths; no credentials are forwarded. Dry-run mode avoids launching real coding agents. It does not perform external Git operations.

`verify-proof.mjs` checks the live PID's command, repo health identity, served HTML and every built JS/CSS/font asset against disk SHA256. It writes `server-proof.json` and browser-observed font/theme information. `verify-fixture.mjs` validates all four live run records through the built Zod contract, checks the real parent/worker relationship, ensures generated state is untracked in the fixture and confirms application source is unchanged.

`mock-api.mjs` installs nine contract-validated **browser response fixtures** for GitHub lists/checks/reference state/comments/merge eligibility/changes and automation list/detail/log. It intercepts both the unscoped boot alias and fixture project routes. Mocking only scoped routes is insufficient: the current client also uses unscoped aliases. The requirements-unknown PR has passing checks but a disabled merge button. No real merge or automation launch is performed.

The server itself also has built-in dry-run GitHub data. Browser fixtures override selected responses; do not confuse the two when interpreting evidence. The fixtures are for visual inspection, not a simulation of every write route.

## State and limitations

The serve command reseeds its own fixture records on every start; use it only with this QA directory. Stop the exact PID recorded in `server-proof.json` when finished. The process check in `verify-proof.mjs` uses Linux `/proc`, matching this worker environment.

Historical capture scripts, `frames.json`, reference metadata and the old gallery are not part of the reusable fixture's acceptance. They retain the assigned old 158-frame IDs; the user replaced that reference mid-audit. Some original composite frames contain multiple states and were not fully verified. They must not be reused for the new design.

Validation logs live under `validation/`. The first suite exposed inherited TMPDIR/CEZ_AUTOMATIONS contamination. Isolated runs use `TMPDIR=/tmp TMP=/tmp TEMP=/tmp` and clear `CEZ_AUTOMATIONS`/`CEZ_FOLLOWUPS`. Timing-sensitive delegation tests also need their existing timeout raised in this loaded worker environment; retain the failing-run logs rather than claiming an unqualified clean full-suite pass.
