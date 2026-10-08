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
health at that origin. Announcement and HTTP health share one deadline and attempt cap;
there is no additional retry loop or fresh budget. Invalid announcements, spawn errors,
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

The merge of main adds two fixtures to this class: `automations.e2e.ts` (the
opted-in schedule server) and `live-preview.e2e.ts` (the opted-in cockpit server).
Both now request port 0 and adopt their owned listener within the original 15 s
health budget. The preview application itself keeps its separate explicit port
and native lifecycle; its browser wait override is unchanged. The complete
construction guard pins those 46 starts across 39 spec files.

Main commit `12875135` adds `artifact-project-links.e2e.ts`, whose single CLI
construction also requests port 0 and adopts its owned listener within the original
15 s health budget. Its publication, cross-project browser assertions and 120 s setup
timeout are unchanged. The complete guard now pins 47 starts across 40 spec files.

Issue #810 adds `sidebar-limits.e2e.ts`: one CLI construction with port 0,
owned listener readiness within the original 15 s health budget, and awaited
shutdown before fixture removal. The guard now pins 48 starts across 41 specs.

The OMP sub-agent case in `agents-dock.e2e.ts` (#595) adds a second CLI construction to an
existing spec: port 0, owned listener readiness, awaited shutdown before fixture removal.
The guard now pins 49 starts across 41 specs.

hearsay-tools/cezarion#845 adds `sidebar-ellipsis-click.e2e.ts`: one CLI
construction with port 0, owned listener readiness within the original 15 s
health budget, and awaited shutdown before fixture removal. The guard now pins
50 starts across 42 specs.

hearsay-tools/cezarion#917 adds `worktree-setup.e2e.ts`: one CLI construction with
port 0 over its own fixture repo, owned listener readiness within the original 15 s
health budget, and awaited shutdown before fixture removal. The guard now pins 51
starts across 43 specs.

hearsay-tools/cezarion#927 adds `assistant-reply-copy.e2e.ts`: one CLI construction
with port 0 over its own fixture repo, owned listener readiness within the original
15 s health budget, and awaited shutdown before fixture removal. The guard now pins
52 starts across 44 specs.

## Other server classes audited

- `task-views-layout` fault proxy uses a direct Node HTTP listener; it does not run
  CLI port fallback. Its original port probe, requested origin and 40-attempt health
  gate remain unchanged. Its upstream CLI fixture uses the new ownership helper.
- `run-header-ci-wait` starts Vite with `--strictPort`; a bind conflict fails instead
  of selecting another port. Its construction and readiness remain unchanged.
- Service node tests use other ownership mechanisms: `cockpit-ownership` already
  requests port 0 and adopts its own stdout listener; `task-cli` deliberately tests
  zero-config repo-identity discovery rather than a requested health endpoint.
  Application-update tests use their own IPC actual-listener acknowledgement with
  exact-restart identity checks, or packaged mock servers with fixed explicit binds.
  They are distinct from the 52 cockpit-spec CLI preference/health constructions.
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
