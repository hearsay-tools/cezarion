# Upstream ledger

Generated from `ledger.yaml` by `node .github/scripts/upstream-scan.cjs render`. Do not edit; edit the YAML.

- Upstream: [open-mercato/cezar](https://github.com/open-mercato/cezar) `main`
- Fork point: `feb85666` (2026-08-31)
- Last scan: 2026-09-18 to `4763447f` ([report](scans/2026-09-18.md))
- Entries: 44 · pending: 11 · planned: 13 · ported: 10 · diverged: 3 · n/a: 7

## Pending (11)

| Upstream | Date | Title | Conflicts | Note |
| --- | --- | --- | --- | --- |
| [#954](https://github.com/open-mercato/cezar/pull/954) | 2026-09-13 | feat(tasks): switch runners with persisted context (#954) | 2 | fork still switches runners through the handoff file; 3 hunks in run.ts |
| [#972](https://github.com/open-mercato/cezar/pull/972) | 2026-09-13 | feat(dispatch): a task may dispatch other tasks (replaces the missions experiment) (#972) | 18 | different by design: fork built owned workers with an authenticated controller (CEZ_DELEGATION); upstream dispatch (CEZ_DISPATCH) is an incompatible model. Units specs worth reading for the escalation ladder |
| [#940](https://github.com/open-mercato/cezar/pull/940) | 2026-09-14 | feat(tasks): in-task drafts survive leaving the task (#940) | 9 | fork keeps in-task drafts in memory only; new drafts store + contract, 9 conflicting hunks |
| [#957](https://github.com/open-mercato/cezar/pull/957) | 2026-09-14 | feat(attachments): per-project attachment library (#957) | 7 | fork stores attachments per run under runs/<id>-images; depends on #940 drafts |
| [#985](https://github.com/open-mercato/cezar/pull/985) | 2026-09-15 | feat(automations): scheduled triggers, default-on, redesigned surface, creation from a prompt (#985) | 20 | different by design today: fork automations are GitHub-poll only and opt-in; upstream adds schedule triggers, calendars and default-on. A project, not a port |
| [#774](https://github.com/open-mercato/cezar/pull/774) | 2026-09-15 | feat(workspace): register the boot folder only while the registry is empty (#774) | 5 | fork registers the boot folder unconditionally; backend applies clean, settings UI conflicts with the redesign |
| [#986](https://github.com/open-mercato/cezar/pull/986) | 2026-09-15 | fix(thread): a reply typed into a task that looks done, but is running, lands (#986) | 7 | partially present: ask-answer.ts already refetches on 409 and run-reconcile heals one direction; missing the workspace-stream watchdog and the reverse healing direction |
| [#1015](https://github.com/open-mercato/cezar/pull/1015) | 2026-09-17 | fix(dispatch): tell parents --budget is optional so uncapped trees don't get invented caps (#1015) | 0 |  |
| [#1016](https://github.com/open-mercato/cezar/pull/1016) | 2026-09-18 | feat(automations): PR review triggers, agent account and skill pickers (#1016) | 5 |  |
| [#995](https://github.com/open-mercato/cezar/pull/995) | 2026-09-18 | fix(runs): a turn parked on its own dispatched subagents stops reading as "needs you" (#995) | 1 |  |
| [#1012](https://github.com/open-mercato/cezar/pull/1012) | 2026-09-18 | fix(attachments): file named image uploads in the attachment library too (#1012) | 10 |  |

## Planned (13)

| Upstream | Date | Title | Fork | Decided | Reason / note |
| --- | --- | --- | --- | --- | --- |
| [#967](https://github.com/open-mercato/cezar/pull/967) | 2026-09-12 | fix(runs): make the autonomous auto-continue nudge reachable on both turn-end paths (#967) | [issue #426](https://github.com/hearsay-tools/cezarion/issues/426) | 2026-09-18 | bug present here: runContinuation never sets state.autonomous and runAgentStep has no nudge, so #autonomous parks after the first turn; 1 conflicting file, 4 hunks in run.ts |
| [#809](https://github.com/open-mercato/cezar/pull/809) | 2026-09-14 | fix(composer): scroll skill menu on arrow key navigation (#809) | [issue #433](https://github.com/hearsay-tools/cezarion/issues/433) | 2026-09-18 | absent here, applies clean |
| [#861](https://github.com/open-mercato/cezar/pull/861) | 2026-09-14 | fix(ui): keep CPU/Mem folded on queued task rows (#821) (#861) | [issue #432](https://github.com/hearsay-tools/cezarion/issues/432) | 2026-09-18 | pre-fix code still present at tasks-overview.tsx (queue note reopens folded CPU/Mem); applies clean |
| [#956](https://github.com/open-mercato/cezar/pull/956) | 2026-09-14 | feat(tasks): copy branch name from task header (#956) | [issue #434](https://github.com/hearsay-tools/cezarion/issues/434) | 2026-09-18 | absent here; run header was redesigned in #235, 2 hunks to re-place |
| [#942](https://github.com/open-mercato/cezar/pull/942) | 2026-09-14 | feat(thread): per-message timestamps in the task conversation (#942) | [issue #435](https://github.com/hearsay-tools/cezarion/issues/435) | 2026-09-18 | absent here; new files apply clean, 1 hunk in thread-items |
| [#953](https://github.com/open-mercato/cezar/pull/953) | 2026-09-14 | feat(sidebar): drag project groups to set their order, shared across devices (#952) (#953) | [issue #438](https://github.com/hearsay-tools/cezarion/issues/438) | 2026-09-18 | absent here; needs the contract field plus 4 hunks in project-groups |
| [#973](https://github.com/open-mercato/cezar/pull/973) | 2026-09-14 | feat(ui): filter the new-task base branch picker (#973) | [issue #436](https://github.com/hearsay-tools/cezarion/issues/436) | 2026-09-18 | absent here; 3 hunks in picker-pill |
| [#984](https://github.com/open-mercato/cezar/pull/984) | 2026-09-14 | fix(workflows): park intermediate asks for input (#984) | [issue #427](https://github.com/hearsay-tools/cezarion/issues/427) | 2026-09-18 | bug present here: resolveAskTurn is gated on interactive, so a CEZ:ASK from a non-final workflow step is dropped and the next step runs; upstream patch references dispatch code that must be stripped |
| [#968](https://github.com/open-mercato/cezar/pull/968) | 2026-09-14 | fix(clone): recover from GitHub organization SAML auth (#968) | [issue #437](https://github.com/hearsay-tools/cezarion/issues/437) | 2026-09-18 | absent here; server side applies clean, 1 hunk in the clone dialog |
| [#993](https://github.com/open-mercato/cezar/pull/993) | 2026-09-16 | fix(automations): a stale poll lock no longer silences every project for ten minutes (#993) | [issue #428](https://github.com/hearsay-tools/cezarion/issues/428) | 2026-09-18 |  |
| [#1014](https://github.com/open-mercato/cezar/pull/1014) | 2026-09-17 | fix(providers): a runtime auth rejection verifies itself before it sticks (#1014) | [issue #431](https://github.com/hearsay-tools/cezarion/issues/431) | 2026-09-18 |  |
| [#1009](https://github.com/open-mercato/cezar/pull/1009) | 2026-09-17 | fix(server-deploy): fail the deploy when the service did not actually restart (#1009) | [issue #430](https://github.com/hearsay-tools/cezarion/issues/430) | 2026-09-18 |  |
| [#994](https://github.com/open-mercato/cezar/pull/994) | 2026-09-18 | fix(server-install): ubuntu-vps vhost emits a standalone http2 directive nginx < 1.25.1 rejects (#994) | [issue #429](https://github.com/hearsay-tools/cezarion/issues/429) | 2026-09-18 |  |

## Ported (10)

| Upstream | Date | Title | Fork | Decided | Reason / note |
| --- | --- | --- | --- | --- | --- |
| [#943](https://github.com/open-mercato/cezar/pull/943) | 2026-09-01 | fix(composer): stop the Alt quick replies from eating typed characters (#943) | [PR #95](https://github.com/hearsay-tools/cezarion/pull/95) | 2026-09-05 |  |
| [#946](https://github.com/open-mercato/cezar/pull/946) | 2026-09-03 | fix(runs): stop a task adopting another repository's PR/issue as its reference (#945) (#946) | [PR #94](https://github.com/hearsay-tools/cezarion/pull/94) | 2026-09-06 | follow-ups #105 (cold workspace references) and #106 (repository identity recovery) |
| [#951](https://github.com/open-mercato/cezar/pull/951) | 2026-09-03 | feat(composer): accept PDF, TXT and MD attachments, not just images (#951) | [PR #101](https://github.com/hearsay-tools/cezarion/pull/101) | 2026-09-06 |  |
| [#947](https://github.com/open-mercato/cezar/pull/947) | 2026-09-03 | fix(workflows): expand /skill in a fresh run's opening prompt (#947) | [PR #96](https://github.com/hearsay-tools/cezarion/pull/96) | 2026-09-05 |  |
| [#764](https://github.com/open-mercato/cezar/pull/764) | 2026-09-04 | fix(web): reclaim mobile task history space (#764) | [PR #103](https://github.com/hearsay-tools/cezarion/pull/103) | 2026-09-06 |  |
| [#732](https://github.com/open-mercato/cezar/pull/732) | 2026-09-04 | fix(github): find issues and PRs in any state from the tab's search (#730) (#732) | [PR #100](https://github.com/hearsay-tools/cezarion/pull/100) | 2026-09-06 |  |
| [#938](https://github.com/open-mercato/cezar/pull/938) | 2026-09-04 | feat(tasks): pin tasks to the top of the list — a per-project "Pinned" group (#938) | [PR #104](https://github.com/hearsay-tools/cezarion/pull/104) | 2026-09-06 |  |
| [#937](https://github.com/open-mercato/cezar/pull/937) | 2026-09-04 | fix(ask): recover a CEZ:ASK payload that is only missing its closing brackets (#937) | [PR #98](https://github.com/hearsay-tools/cezarion/pull/98) | 2026-09-05 |  |
| [#841](https://github.com/open-mercato/cezar/pull/841) | 2026-09-04 | fix(models): discover Claude models from the host CLI instead of fixed presets (#841) | [PR #99](https://github.com/hearsay-tools/cezarion/pull/99) | 2026-09-05 |  |
| [#873](https://github.com/open-mercato/cezar/pull/873) | 2026-09-04 | fix(ui): collapse dense run metadata at phone width (#765) (#873) | [PR #103](https://github.com/hearsay-tools/cezarion/pull/103) | 2026-09-06 |  |

## Diverged (3)

| Upstream | Date | Title | Fork | Decided | Reason / note |
| --- | --- | --- | --- | --- | --- |
| [#966](https://github.com/open-mercato/cezar/pull/966) | 2026-09-13 | fix(web): improve task detail rendering performance (#966) | [PR #140](https://github.com/hearsay-tools/cezarion/pull/140) | 2026-09-18 | the fork did its own transcript virtualization and anchor work in #140, #162, #306 and #333; upstream patch is not applicable, ideas only |
| [#965](https://github.com/open-mercato/cezar/pull/965) | 2026-09-14 | fix(ui): keep the task thread readable on a phone while an agent works (#965) | [PR #303](https://github.com/hearsay-tools/cezarion/pull/303) | 2026-09-18 | mobile thread jumps were fixed differently in #303; the throttling helpers here would conflict with the fork virtualizer |
| [#1005](https://github.com/open-mercato/cezar/pull/1005) | 2026-09-16 | fix(opencode): a turn longer than five minutes no longer parks the run under Needs you (#1005) | [PR #24](https://github.com/hearsay-tools/cezarion/pull/24) | 2026-09-18 | the fork already takes the OpenCode turn end from session.idle instead of the 300 s undici long-poll (PR #24, 2026-09-01), which is the same fix |

## N/a (7)

| Upstream | Date | Title | Fork | Decided | Reason / note |
| --- | --- | --- | --- | --- | --- |
| [#962](https://github.com/open-mercato/cezar/pull/962) | 2026-09-04 | chore(release): bump main to 0.10.1 and cut the changelog entry (#962) |  | 2026-09-18 | upstream release bump; the fork has its own version line (cezarion 0.11+) |
| [#839](https://github.com/open-mercato/cezar/pull/839) | 2026-09-14 | docs(specs): a task remembers every PR it has been associated with (#839) |  | 2026-09-18 | upstream-only spec document; nothing to ship here — docs only, applies clean |
| [#963](https://github.com/open-mercato/cezar/pull/963) | 2026-09-14 | docs(changelog): one-line entries for every release, in 0.9.0's format (#963) |  | 2026-09-18 | reformats the upstream CHANGELOG only; the fork keeps its own changelog |
| [#990](https://github.com/open-mercato/cezar/pull/990) | 2026-09-15 | chore(release): bump main to 0.11.0 and cut the changelog entry (#990) |  | 2026-09-18 | upstream release bump; the fork has its own version line (cezarion 0.11+) |
| [#1013](https://github.com/open-mercato/cezar/pull/1013) | 2026-09-16 | docs(readme): shorter README with demo video, screenshots and mobile shots (#1013) |  | 2026-09-18 | upstream README rewrite; the fork keeps its own README |
| [#1022](https://github.com/open-mercato/cezar/pull/1022) | 2026-09-18 | docs(readme): fix the mobile layout of the link row and screenshots (#1022) |  | 2026-09-18 | upstream README layout fix; the fork keeps its own README |
| [#1023](https://github.com/open-mercato/cezar/pull/1023) | 2026-09-18 | chore(release): bump main to 0.11.1 and cut the changelog entry (#1023) |  | 2026-09-18 | upstream release bump; the fork has its own version line (cezarion 0.11+) |

