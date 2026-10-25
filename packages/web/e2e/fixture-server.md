# Spec-owned CLI listener readiness (#795)

A CLI `--port N` is a preference: `pickPort` can advance through 50 ports before the
server listens. A probe that closes an ephemeral listener before spawn does not reserve
that port. Polling the requested URL can therefore poll somebody else's 404, or accept
somebody else's 200. The controlled native proof demonstrates both outcomes. The
historical mobile-tab-bar child used ignored stdio, so its actual listener and phase
were not recorded; the exact cause of that historical 404 remains unproven.

`spawnFixtureServer` returns the child immediately, drains bounded output, and starts
the original health deadline at spawn. `waitForFixtureServer` requires that same live
child's post-listen `cockpit → http://127.0.0.1:<port>` announcement and successful HTTP
health at that origin. Announcement and HTTP health share one wall-clock deadline;
there is no additional retry loop or fresh budget (see the boot budget section below). Invalid announcements, spawn errors,
child exits, or expired startup stop the owned child and retain phase/lifecycle/output
diagnostics. Configuration and environment contents are not serialized.

New fixtures request `--port 0`, so the OS binds atomically. Existing seed writes, POST
requests, browser actions, assertions, timeouts and teardown remain in their original
order. A live returned child lets existing log hooks attach before readiness.

## Complete construction audit

Baseline `ac1d7fee48b201bc0d5c775986b98361648aca6c`: 44 constructions in 37 specs.
`settings-monitoring` reuses its one constructor at initial boot and restart; the
`sidebar-project-header` constructor runs once per local/remote fixture. The executable
source guard inventories every spec-owned CLI `serve` construction, including those
with a separately resolved built CLI path.

The table is the historical audit from hearsay-tools/cezarion#795 and the PRs that
followed it; it is no longer extended. Each spec now declares its own starts (see the
next section).

| Spec | Baseline construction lines | Endpoint/budget exceptions |
| --- | --- | --- |
| agents-dock.e2e.ts | 102 | OS-bound initial port; original 15 s |
| assistant-line-breaks.e2e.ts | 92 | OS-bound initial port; original 15 s |
| chat-code-fence.e2e.ts | 82 | OS-bound initial port; original 15 s |
| commit-list.e2e.ts | 131 | OS-bound initial port; original 15 s |
| composer-defaults.e2e.ts | 73 | OS-bound initial port; original 15 s |
| composer.e2e.ts | 73 | OS-bound initial port; original 15 s |
| diff-scroll.e2e.ts | 119 | OS-bound initial port; original 15 s |
| empty-states.e2e.ts | 53 | OS-bound initial port; original 15 s |
| git-sidebar.e2e.ts | 110 | OS-bound initial port; original 15 s |
| github-sidebar.e2e.ts | 167 | OS-bound initial port; original 15 s |
| markdown-preview.e2e.ts | 64 | OS-bound initial port; original 15 s |
| mobile-tab-bar.e2e.ts | 76 | OS-bound initial port; original 15 s |
| mobile-task-controls.e2e.ts | 43 | Original 20 s retained |
| new-task-hierarchy.e2e.ts | 52 | OS-bound initial port; original 15 s |
| new-task-picker-layout.e2e.ts | 49, 233 | Initial port 0; restart requests SAME prior port and rejects changed origin |
| new-task.e2e.ts | 90 | OS-bound initial port; original 15 s |
| plan-mode.e2e.ts | 67 | OS-bound initial port; original 15 s |
| progressive-history.e2e.ts | 286 | OS-bound initial port; original 15 s |
| queued-stack.e2e.ts | 92 | Original 15 s plus existing shared absolute setup deadline |
| quick-list.e2e.ts | 197, 854, 1257, 1487, 1619, 1723, 1897 | OS-bound initial port; original 15 s |
| repo-git-diff.e2e.ts | 88 | OS-bound initial port; original 15 s |
| review-gate.e2e.ts | 62 | OS-bound initial port; original 15 s |
| selection-states.e2e.ts | 61 | Original 20 s retained |
| settings-monitoring.e2e.ts | 57 | Initial port 0; reused constructor requests SAME prior port on restart, rejects changed origin |
| sidebar-project-header.e2e.ts | 34 | OS-bound initial port; original 15 s |
| sidebar-reference-status.e2e.ts | 54 | OS-bound initial port; original 15 s |
| skill-search-ranking.e2e.ts | 84 | OS-bound initial port; original 15 s |
| task-changes.e2e.ts | 78 | OS-bound initial port; original 15 s |
| task-files.e2e.ts | 78 | OS-bound initial port; original 15 s |
| task-github-items.e2e.ts | 82 | OS-bound initial port; original 15 s |
| task-handoff.e2e.ts | 46 | OS-bound initial port; original 15 s |
| task-thread.e2e.ts | 105 | OS-bound initial port; original 15 s |
| task-views-layout.e2e.ts | 37 | OS-bound initial port; original 15 s |
| thread-scroll.e2e.ts | 182 | OS-bound initial port; original 15 s |
| touch-targets.e2e.ts | 53 | Original 20 s retained |
| variants-compare.e2e.ts | 72 | OS-bound initial port; original 15 s |
| worker-conversation.e2e.ts | 80 | OS-bound initial port; original 15 s |
| worker-relationships.e2e.ts | 63 | Original 20 s retained |
| worktree-setup.e2e.ts | 47 | Initial port 0; original 15 s |

## Declaring a spec's starts (hearsay-tools/cezarion#1084)

A spec that starts its own CLI `serve` declares how many constructions it has, on one
line of its own directly after its import block:

```ts
// fixture-server starts: 2
```

`src/test/fixture-server-start.test.ts` finds the constructions with the same source
pattern that checks their readiness and compares the count with the declaration. It
counts source sites, not boots: a constructor reused for a restart counts once. Any
`//` line that reads `fixture-server starts`, at any indentation or spacing, counts as a
declaration, so a near-miss is reported instead of ignored. The guard names the spec and
the line to add, change, move or remove when:

- the spec starts a fixture server but has no declaration;
- the spec has a declaration but starts no fixture server;
- the declared count differs from the constructions the guard finds;
- the declaration appears more than once;
- the declaration is malformed: not exactly `// fixture-server starts: N` at column 0
  with N a positive integer (`0`, `//fixture-server starts: 1` and an indented line
  included);
- the declaration is misplaced: the line before it does not end an import statement, or
  an import follows it. This also rejects a copy inside a string or a block comment.

The count lives in the spec because every shared form of it conflicted. A pinned total
changed on every PR that added a fixture-server spec, so any two such PRs in flight
conflicted (hearsay-tools/cezarion#1076 resolved one by hand). A shared sorted list of
specs still conflicts when two new names sort into the same gap. A spec that adds or
drops a fixture server edits only itself, and nothing in this document changes.

## Boot budget (hearsay-tools/cezarion#986)

The original per-site budget was `tries: 60` × 250 ms, about 15 s, carried over from the
health poll of an already-running server. Since spawn-time readiness, that budget also
covers the whole cockpit boot (detectEnvironment, store open, worktree reconcile,
recovery), which is CPU-bound. Under load it ran out with the child alive and stdout
empty: four-lane run `1791923143645-2565641` (load about 30) failed touch-targets,
task-thread, github-sidebar and quick-list at 14.7 to 14.8 s, and Squeal's slow tier in
the main checkout failed task-github-items and task-handoff the same way. The attempt
cap also overrode explicit budgets, because an attempt that finds no announcement costs
no time: touch-targets asked for 20 s and still failed at 14.8 s.

The budget is now wall-clock only: `FIXTURE_BOOT_BUDGET_MS` (45 s) by default, or the
caller's `timeoutMs`. The four `timeoutMs: 20_000` overrides above were removed, since the
default is now larger. 45 s fits inside the default 60 s hook timeout with room for fixture
setup. A child that exits still fails at once.

## Stopping the whole process group (hearsay-tools/cezarion#1764)

`spawnFixtureServer` starts the server in its own process group (`detached`, except on
Windows), and `stopFixtureServer` waits until no process in that group runs. The server's
git children outlive its exit. A teardown `rmSync` that runs right after the server exits
can therefore meet a `git status` that writes `.git/index.lock` into the tree it removes.
Main CI failed this way with `ENOTEMPTY` in `git-sidebar` (hearsay-tools/cezarion#1764) and
`variants-compare` (hearsay-tools/cezarion#1731), and a PR run failed this way in `new-task`.

Evidence: a server-only probe (`.ai/qa/1765/probe.mjs`, not tracked) with a git wrapper that
adds 400 ms per call. After a leader-only stop, 18 to 24 git processes still ran in the
fixture root (5 of 6 runs). After a group stop, none ran (3 of 3 runs).
`src/test/fixture-server-stop.test.ts` fails against the leader-only stop.

Children that `spawnFixtureServer` did not start (Vite servers, the fault proxy) keep the
leader-only stop: their pid does not name a process group.

### Process exits

| Case | What stops it | Behavior at shipped defaults |
| --- | --- | --- |
| Normal stop | `stopFixtureServer` sends SIGTERM to the group, then SIGKILL after the grace (5 s) to whatever still runs, the server or any child. | Resolves once the server has exited and no group member runs. Rejects when a member still runs after SIGKILL plus the grace. |
| Test process interrupted by SIGINT, SIGTERM or SIGHUP after the spawn | A handler that `spawnFixtureServer` installs once per process sends SIGKILL to every group it still owns. | The signal is raised again when no other listener handles it, so the process still ends by it. |
| Test process interrupted before the spawn | Nothing to stop. | No group exists. The spawn and its registration run in one synchronous step, so no signal handler runs between them. |
| Test process exits without `afterAll` | The same handler, on `exit`, sends SIGKILL to every group still running. | The server and its children end. |
| Test process killed by SIGKILL | Nothing can run. | The server and its children keep running, as before this change: children of a SIGKILLed process were never stopped. Only the terminal's Ctrl-C reached them directly before, and the signal handler above replaces it. |
| Server exits before its children | The same stop, whether the server exited by itself or by the stop. | The stop waits for the remaining members and signals them. |
| A member ignores SIGTERM | SIGKILL after the grace. | Covered by a test. |
| Members stay zombies because their new parent never reaps them | Zombies do not count as running: Linux reads `/proc/<pid>/stat`, macOS reads `ps`. | The stop resolves. |
| The start identity cannot be read | Not used. Node reaps the server before its `exit` event, and the kernel never reuses a pid that still names a group. | Cannot happen. |
| The server's pid is reused | After the server's `exit`, a live process with its pid means the group ended. | The stop and the handler signal nothing. |
| The handle the stop reads is deleted or forged | The handle is the in-memory `ChildProcess`; there is no descriptor or lock file. | Cannot happen. |

## Other server classes audited

- `task-views-layout` fault proxy uses a direct Node HTTP listener; it does not run
  CLI port fallback. Its original port probe, requested origin and 40-attempt health
  gate remain unchanged. Its upstream CLI fixture uses the new ownership helper.
- `run-header-ci-wait` starts Vite with `--strictPort`; a bind conflict fails instead
  of selecting another port. Its construction and readiness remain unchanged.
- `live-preview` starts its cockpit through the ownership helper, but the preview
  application it drives keeps its separate explicit port and native lifecycle, and its
  browser wait override is unchanged.
- Service node tests use other ownership mechanisms: `cockpit-ownership` already
  requests port 0 and adopts its own stdout listener; `task-cli` deliberately tests
  zero-config repo-identity discovery rather than a requested health endpoint.
  Application-update tests use their own IPC actual-listener acknowledgement with
  exact-restart identity checks, or packaged mock servers with fixed explicit binds.
  They are distinct from the cockpit-spec CLI preference/health constructions.
- In-process Hono/server tests use their returned listener or app and do not spawn
  an adaptive CLI port. Browser mock API fixtures do not spawn this CLI.

## Focused verification

The native controlled proof uses the unchanged built CLI in a private temporary Git
repo/home, an owned foreign listener and the ORIGINAL 15-second health budget. It
records requested versus child-announced URL and actual health/seed identity before
cleanup. The first diagnostic attempt's wrong runs-array decoding is retained as a
diagnostic failure and excluded from causal proof.

`src/test/fixture-server-start.test.ts` exercises real Node HTTP children: foreign
404/200, partial stdout chunks including split UTF-8 arrow bytes, invalid URL, spawn error, early exit, no announcement,
spawn-time budget, slow health headers/body, unhealthy status, exit during HTTP,
restart origin fidelity, bounded stderr and refusal of an unrelated child. Existing
shutdown, diagnostic, environment and wait-discipline guards remain intact.

Focused command (no build):

```sh
npm test -- --project web packages/web/src/test/fixture-server-start.test.ts packages/web/src/test/fixture-server-diagnostics.test.ts packages/web/src/test/fixture-server-stop.test.ts packages/web/src/test/fixture-serve-env.test.ts packages/web/src/test/e2e-wait-discipline.test.ts
```

Exact final behavior rollback restores the health request target to the child's
requested `--port` and removes UTF-8 stream decoding. All parser/deadline/restart/error/cleanup guards, migrated
specs and assertions remain present; the foreign 404 and foreign 200 regressions must
fail; the split UTF-8 announcement guard must also fail. Full suite and 24-CPU 3+5 acceptance remain parent-owned. Ignored raw logs and
per-site preservation audit are under `.ai/qa/issue-795/local-flake-loop/fixture-health-*`.
