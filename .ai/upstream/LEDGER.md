# Upstream ledger

Generated from `ledger.yaml` by `node .github/scripts/upstream-scan.cjs render`. Do not edit; edit the YAML.

- Upstream: [open-mercato/cezar](https://github.com/open-mercato/cezar) `main`
- Fork point: `feb85666` (2026-08-31)
- Last scan: 2026-10-05 to `dab947e9` ([report](scans/2026-10-05.md))
- Entries: 130 · pending: 84 · planned: 1 · ported: 27 · partial: 2 · diverged: 9 · n/a: 7

## Pending (84)

| Upstream | Date | Title | Conflicts | Note |
| --- | --- | --- | --- | --- |
| [#954](https://github.com/open-mercato/cezar/pull/954) | 2026-09-13 | feat(tasks): switch runners with persisted context (#954) | 2 | fork still switches runners through the handoff file; 3 hunks in run.ts |
| [#940](https://github.com/open-mercato/cezar/pull/940) | 2026-09-14 | feat(tasks): in-task drafts survive leaving the task (#940) | 9 | fork keeps in-task drafts in memory only; new drafts store + contract, 9 conflicting hunks |
| [#957](https://github.com/open-mercato/cezar/pull/957) | 2026-09-14 | feat(attachments): per-project attachment library (#957) | 7 | fork stores attachments per run under runs/<id>-images; depends on open-mercato/cezar#940 drafts |
| [#774](https://github.com/open-mercato/cezar/pull/774) | 2026-09-15 | feat(workspace): register the boot folder only while the registry is empty (#774) | 5 | fork registers the boot folder unconditionally; backend applies clean, settings UI conflicts with the redesign |
| [#986](https://github.com/open-mercato/cezar/pull/986) | 2026-09-15 | fix(thread): a reply typed into a task that looks done, but is running, lands (#986) | 7 | partially present: ask-answer.ts already refetches on 409 and run-reconcile heals one direction; missing the workspace-stream watchdog and the reverse healing direction |
| [#1016](https://github.com/open-mercato/cezar/pull/1016) | 2026-09-18 | feat(automations): PR review triggers, agent account and skill pickers (#1016) | 5 |  |
| [#1012](https://github.com/open-mercato/cezar/pull/1012) | 2026-09-18 | fix(attachments): file named image uploads in the attachment library too (#1012) | 10 |  |
| [#1063](https://github.com/open-mercato/cezar/pull/1063) | 2026-09-23 | docs(readme): add Open Mercato Cloud banner for 24/7 cloud sandbox (#1063) | 1 |  |
| [#1061](https://github.com/open-mercato/cezar/pull/1061) | 2026-09-23 | fix(claude): detect a native-installer claude that is off the process PATH (#1061) | 5 |  |
| [#1030](https://github.com/open-mercato/cezar/pull/1030) | 2026-09-23 | docs(specs): runner seam native backends — seam de-dup, codex providers, Gemini and Copilot over ACP (#1030) | 0 |  |
| [#1025](https://github.com/open-mercato/cezar/pull/1025) | 2026-09-23 | fix(runs): a save no longer drops the runs another process wrote (#1025) | 2 |  |
| [#1033](https://github.com/open-mercato/cezar/pull/1033) | 2026-09-23 | docs(specs): dispatch admission cap - an opt-in ceiling on dispatch children (#1033) | 0 |  |
| [#1026](https://github.com/open-mercato/cezar/pull/1026) | 2026-09-24 | docs(specs): browse Jira and Linear tasks alongside GitHub (#1026) | 0 |  |
| [#1056](https://github.com/open-mercato/cezar/pull/1056) | 2026-09-24 | fix: dedupe review request automation bursts (#1056) | 2 |  |
| [#1057](https://github.com/open-mercato/cezar/pull/1057) | 2026-09-24 | fix(workspace): stop listing the launch folder as a project once the registry has one (#1057) | 7 |  |
| [#1064](https://github.com/open-mercato/cezar/pull/1064) | 2026-09-24 | fix(claude): keep .cmd shims away from the spawn sites, and validate CEZ_CLAUDE_BIN for the handoff (#1064) | 2 |  |
| [#1069](https://github.com/open-mercato/cezar/pull/1069) | 2026-09-24 | feat(thread): live clock on the Working… indicator (#1069) | 3 |  |
| [#1045](https://github.com/open-mercato/cezar/pull/1045) | 2026-09-25 | feat(trackers): browse Jira and Linear issues and automate tracker events (#1045) | 32 |  |
| [#1088](https://github.com/open-mercato/cezar/pull/1088) | 2026-09-26 | docs(readme): retitle header and rewrite the tagline (#1088) | 1 |  |
| [#1090](https://github.com/open-mercato/cezar/pull/1090) | 2026-09-26 | feat(web): refresh cockpit brand icon and favicon (#1090) | 8 |  |
| [#1083](https://github.com/open-mercato/cezar/pull/1083) | 2026-09-26 | docs(changelog): draft the 0.12.0 entry for PRs merged since 0.11.1 (#1083) | 1 |  |
| [#1042](https://github.com/open-mercato/cezar/pull/1042) | 2026-09-26 | feat(resources): effective host capacity from the process cgroup, with a sidebar glance (#1042) | 7 |  |
| [#1072](https://github.com/open-mercato/cezar/pull/1072) | 2026-09-26 | fix(cockpit): settle the plan dock once the run's session is closed (#1072) | 4 |  |
| [#1086](https://github.com/open-mercato/cezar/pull/1086) | 2026-09-26 | docs: add Simplified and Traditional Chinese READMEs (#1086) | 1 |  |
| [#1010](https://github.com/open-mercato/cezar/pull/1010) | 2026-09-26 | fix(codex): keep a compaction-ended turn working and surface a rejected follow-up (#1010) | 6 |  |
| [#1006](https://github.com/open-mercato/cezar/pull/1006) | 2026-09-26 | test(runs): pin the Continue tool-policy invariant end to end (#1006) | 0 |  |
| [#1091](https://github.com/open-mercato/cezar/pull/1091) | 2026-09-26 | docs: add SECURITY.md with vulnerability reporting policy (#1091) | 0 |  |
| [#1018](https://github.com/open-mercato/cezar/pull/1018) | 2026-09-26 | fix(cockpit): select a project from the sidebar, and carry the composition across a project switch (#1018) | 7 |  |
| [#1075](https://github.com/open-mercato/cezar/pull/1075) | 2026-09-26 | feat(settings): integer stepper for parallel-task and monitoring limits (#1075) | 4 |  |
| [#1060](https://github.com/open-mercato/cezar/pull/1060) | 2026-09-26 | fix(web): keep shell task lists in their project scope (#1060) | 5 |  |
| [#1002](https://github.com/open-mercato/cezar/pull/1002) | 2026-09-26 | fix(automations): a saturated overlap band no longer pins the poll cursor forever (#1002) | 6 |  |
| [#996](https://github.com/open-mercato/cezar/pull/996) | 2026-09-26 | fix(forge): merge state survives an unreadable statusCheckRollup (#969) (#996) | 0 |  |
| [#1035](https://github.com/open-mercato/cezar/pull/1035) | 2026-09-26 | docs(specs): live host resource telemetry - the Machine card (#1035) | 0 |  |
| [#1092](https://github.com/open-mercato/cezar/pull/1092) | 2026-09-26 | ci: add CodeQL advanced-setup workflow (#1092) | 0 |  |
| [#1047](https://github.com/open-mercato/cezar/pull/1047) | 2026-09-26 | feat(dashboard): add workspace overview, reported costs and exports (#1047) | 13 |  |
| [#1100](https://github.com/open-mercato/cezar/pull/1100) | 2026-09-27 | fix(server-install): verify cockpit instance identity (#1100) | 3 |  |
| [#1097](https://github.com/open-mercato/cezar/pull/1097) | 2026-09-27 | test(web): target project disclosure button (#1097) | 0 |  |
| [#1093](https://github.com/open-mercato/cezar/pull/1093) | 2026-09-27 | fix(security): close CodeQL alerts #10, #12 and #18 (#1093) | 2 |  |
| [#1098](https://github.com/open-mercato/cezar/pull/1098) | 2026-09-27 | fix(runs): make cancellation terminal for stale sessions (#1098) | 5 |  |
| [#1099](https://github.com/open-mercato/cezar/pull/1099) | 2026-09-27 | fix(automations): make abandoned lease reclaim exclusive (#1099) | 3 |  |
| [#1101](https://github.com/open-mercato/cezar/pull/1101) | 2026-09-27 | fix(pi): distinguish assistant message item ids (#1101) | 3 |  |
| [#1102](https://github.com/open-mercato/cezar/pull/1102) | 2026-09-27 | fix(runs): preserve non-final monitoring steps (#1102) | 1 |  |
| [#1108](https://github.com/open-mercato/cezar/pull/1108) | 2026-09-27 | docs(changelog): complete the 0.12.0 entry and stamp the release set (#1108) | 6 |  |
| [#1110](https://github.com/open-mercato/cezar/pull/1110) | 2026-09-27 | feat(web): collapsible subtasks in the task lists (#1110) | 3 |  |
| [#1112](https://github.com/open-mercato/cezar/pull/1112) | 2026-09-27 | feat(web): recolour brand icon to a black tile with a white mark (#1112) | 0 |  |
| [#1115](https://github.com/open-mercato/cezar/pull/1115) | 2026-09-27 | feat(release): publish a cezar-run npx alias alongside cezar-cli (#1115) | 21 |  |
| [#1116](https://github.com/open-mercato/cezar/pull/1116) | 2026-09-27 | fix(web): match the sidebar Dashboard row to All tasks (#1116) | 1 |  |
| [#1118](https://github.com/open-mercato/cezar/pull/1118) | 2026-09-27 | fix(web): keep sheet header text clear of the close button (#1118) | 2 |  |
| [#1119](https://github.com/open-mercato/cezar/pull/1119) | 2026-09-27 | fix(web): paint a project row's chevron and name on one background (#1119) | 3 |  |
| [#1120](https://github.com/open-mercato/cezar/pull/1120) | 2026-09-27 | feat(web): labelled CPU/RAM meters for the sidebar usage glance (#1120) | 0 |  |
| [#1121](https://github.com/open-mercato/cezar/pull/1121) | 2026-09-27 | docs(changelog): add the PRs merged after the 0.12.0 draft (#1121) | 1 |  |
| [#1123](https://github.com/open-mercato/cezar/pull/1123) | 2026-09-28 | docs(brand): add brand guidelines and logo files (#1123) | 0 |  |
| [#1130](https://github.com/open-mercato/cezar/pull/1130) | 2026-09-28 | fix(docs): drop the permalink icons from the README hero on mobile (#1130) | 1 |  |
| [#1131](https://github.com/open-mercato/cezar/pull/1131) | 2026-09-28 | fix(docs): put the README hero back on headings, with the black brand icon (#1131) | 1 |  |
| [#1136](https://github.com/open-mercato/cezar/pull/1136) | 2026-09-28 | docs(readme): refresh screenshots and feature coverage for 0.12.0 (#1136) | 1 |  |
| [#1145](https://github.com/open-mercato/cezar/pull/1145) | 2026-09-28 | docs(readme): add a website pill to the badge row (#1145) | 1 |  |
| [#807](https://github.com/open-mercato/cezar/pull/807) | 2026-09-28 | feat: Cursor Agent CLI first-class runner (#807) | 60 |  |
| [#1146](https://github.com/open-mercato/cezar/pull/1146) | 2026-09-28 | chore(release): bump the release set to 0.13.0 and add the changelog entry (#1146) | 6 |  |
| [#1147](https://github.com/open-mercato/cezar/pull/1147) | 2026-09-28 | test(runs): cancel store saves still pending when a case ends (#1147) | 0 |  |
| [#1150](https://github.com/open-mercato/cezar/pull/1150) | 2026-09-30 | fix(runs): preserve monitoring before autonomous nudges (#1150) | 5 |  |
| [#1151](https://github.com/open-mercato/cezar/pull/1151) | 2026-09-30 | fix(runs): preserve multiple task PR references (#1151) | 8 |  |
| [#1122](https://github.com/open-mercato/cezar/pull/1122) | 2026-09-30 | fix(web): give native selects the cockpit focus ring, not the browser's blue one (#1122) | 1 |  |
| [#1125](https://github.com/open-mercato/cezar/pull/1125) | 2026-09-30 | fix(web): preserve renamed task titles (#1125) | 1 |  |
| [#1177](https://github.com/open-mercato/cezar/pull/1177) | 2026-09-30 | fix(contract): strip bidi controls from attachment names (#1177) | 2 |  |
| [#1199](https://github.com/open-mercato/cezar/pull/1199) | 2026-09-30 | fix: fork task worktrees from the freshly fetched base tip (#1199) | 2 |  |
| [efaba0db](https://github.com/open-mercato/cezar/commit/efaba0dbd37eac2144b6f140b9f79392c8a3bc62) | 2026-10-01 | qa evidence pr-1210 | 0 |  |
| [f0fc118a](https://github.com/open-mercato/cezar/commit/f0fc118a9db4887f1fc1806534911f518a4410f7) | 2026-10-01 | remove accidentally uploaded QA evidence from default branch | 0 |  |
| [#1201](https://github.com/open-mercato/cezar/pull/1201) | 2026-10-01 | feat(github): sort the GitHub tab newest or oldest first (#1201) | 2 |  |
| [#1200](https://github.com/open-mercato/cezar/pull/1200) | 2026-10-01 | feat(cockpit): ask for a GitHub star — sidebar chip, one-time toast, banner line (#1200) | 11 |  |
| [#1197](https://github.com/open-mercato/cezar/pull/1197) | 2026-10-01 | feat(dashboard): modern cockpit redesign + delivery, failure, backend and automation insights (#1197) | 2 |  |
| [#1202](https://github.com/open-mercato/cezar/pull/1202) | 2026-10-02 | fix(cockpit): stop counting a skill invocation as a running sub-agent (#1202) | 3 |  |
| [#1176](https://github.com/open-mercato/cezar/pull/1176) | 2026-10-02 | fix(workflows): configure waiting-session idle timeout (#1176) | 5 |  |
| [#1043](https://github.com/open-mercato/cezar/pull/1043) | 2026-10-02 | docs(specs): adaptive admission governor (reduction below the user's dispatch ceiling) (#1043) | 0 |  |
| [#1041](https://github.com/open-mercato/cezar/pull/1041) | 2026-10-02 | docs(specs): container-aware effective host telemetry v2.3 (quota + cpuset + pressure pin) (#1041) | 0 |  |
| [#1178](https://github.com/open-mercato/cezar/pull/1178) | 2026-10-02 | perf(claude): stream assistant text into the cockpit as it is generated (#1178) | 3 |  |
| [#1175](https://github.com/open-mercato/cezar/pull/1175) | 2026-10-02 | fix(web): block local transcript filesystem links (#1175) | 2 |  |
| [#1113](https://github.com/open-mercato/cezar/pull/1113) | 2026-10-02 | feat(runners): GitHub Copilot CLI runner over ACP (#582) (#1113) | 54 |  |
| [#866](https://github.com/open-mercato/cezar/pull/866) | 2026-10-02 | test(e2e): browser-level spec for foldable Tasks-table columns (#866) | 0 |  |
| [#1111](https://github.com/open-mercato/cezar/pull/1111) | 2026-10-02 | feat: add Junie CLI backend (#1111) | 56 |  |
| [#1239](https://github.com/open-mercato/cezar/pull/1239) | 2026-10-02 | feat(cockpit): ask for a star in a dialog, only when the user really uses cezar and is at the screen (#1239) | 2 |  |
| [#1240](https://github.com/open-mercato/cezar/pull/1240) | 2026-10-02 | chore(release): bump the release set to 0.14.0 and add the changelog entry (#1240) | 6 |  |
| [#907](https://github.com/open-mercato/cezar/pull/907) | 2026-10-04 | fix(ui): remember the engine pick on the GitHub and Inbox hand-offs (#906) (#907) | 5 |  |
| [#1255](https://github.com/open-mercato/cezar/pull/1255) | 2026-10-04 | fix(web): preserve drafts on project switch (#1095) (#1255) | 4 |  |
| [#1269](https://github.com/open-mercato/cezar/pull/1269) | 2026-10-04 | fix(web): offer the subtask runner's own models in the Dispatch settings (#1269) | 3 |  |

## Planned (1)

| Upstream | Date | Title | Fork | Decided | Reason / note |
| --- | --- | --- | --- | --- | --- |
| [#953](https://github.com/open-mercato/cezar/pull/953) | 2026-09-14 | feat(sidebar): drag project groups to set their order, shared across devices (#952) (#953) | [issue #438](https://github.com/hearsay-tools/cezarion/issues/438) | 2026-09-18 | absent here; needs the contract field plus 4 hunks in project-groups |

## Ported (27)

| Upstream | Date | Title | Fork | Decided | Reason / note |
| --- | --- | --- | --- | --- | --- |
| [#943](https://github.com/open-mercato/cezar/pull/943) | 2026-09-01 | fix(composer): stop the Alt quick replies from eating typed characters (#943) | [PR #95](https://github.com/hearsay-tools/cezarion/pull/95) | 2026-09-05 |  |
| [#946](https://github.com/open-mercato/cezar/pull/946) | 2026-09-03 | fix(runs): stop a task adopting another repository's PR/issue as its reference (#945) (#946) | [PR #94](https://github.com/hearsay-tools/cezarion/pull/94) | 2026-09-06 | follow-ups hearsay-tools/cezarion#105 (cold workspace references) and hearsay-tools/cezarion#106 (repository identity recovery) |
| [#951](https://github.com/open-mercato/cezar/pull/951) | 2026-09-03 | feat(composer): accept PDF, TXT and MD attachments, not just images (#951) | [PR #101](https://github.com/hearsay-tools/cezarion/pull/101) | 2026-09-06 |  |
| [#947](https://github.com/open-mercato/cezar/pull/947) | 2026-09-03 | fix(workflows): expand /skill in a fresh run's opening prompt (#947) | [PR #96](https://github.com/hearsay-tools/cezarion/pull/96) | 2026-09-05 |  |
| [#764](https://github.com/open-mercato/cezar/pull/764) | 2026-09-04 | fix(web): reclaim mobile task history space (#764) | [PR #103](https://github.com/hearsay-tools/cezarion/pull/103) | 2026-09-06 |  |
| [#732](https://github.com/open-mercato/cezar/pull/732) | 2026-09-04 | fix(github): find issues and PRs in any state from the tab's search (#730) (#732) | [PR #100](https://github.com/hearsay-tools/cezarion/pull/100) | 2026-09-06 |  |
| [#938](https://github.com/open-mercato/cezar/pull/938) | 2026-09-04 | feat(tasks): pin tasks to the top of the list — a per-project "Pinned" group (#938) | [PR #104](https://github.com/hearsay-tools/cezarion/pull/104) | 2026-09-06 |  |
| [#937](https://github.com/open-mercato/cezar/pull/937) | 2026-09-04 | fix(ask): recover a CEZ:ASK payload that is only missing its closing brackets (#937) | [PR #98](https://github.com/hearsay-tools/cezarion/pull/98) | 2026-09-05 |  |
| [#841](https://github.com/open-mercato/cezar/pull/841) | 2026-09-04 | fix(models): discover Claude models from the host CLI instead of fixed presets (#841) | [PR #99](https://github.com/hearsay-tools/cezarion/pull/99) | 2026-09-05 |  |
| [#873](https://github.com/open-mercato/cezar/pull/873) | 2026-09-04 | fix(ui): collapse dense run metadata at phone width (#765) (#873) | [PR #103](https://github.com/hearsay-tools/cezarion/pull/103) | 2026-09-06 |  |
| [#967](https://github.com/open-mercato/cezar/pull/967) | 2026-09-12 | fix(runs): make the autonomous auto-continue nudge reachable on both turn-end paths (#967) | [PR #805](https://github.com/hearsay-tools/cezarion/pull/805), [issue #426](https://github.com/hearsay-tools/cezarion/issues/426) | 2026-10-04 | Ported shared bounded nudging and Continue hydration; adapted portable ASK and delayed acknowledgement recovery to this fork, with native runner parity coverage. |
| [#809](https://github.com/open-mercato/cezar/pull/809) | 2026-09-14 | fix(composer): scroll skill menu on arrow key navigation (#809) | [PR #653](https://github.com/hearsay-tools/cezarion/pull/653), [issue #433](https://github.com/hearsay-tools/cezarion/issues/433), [3c27a8c8](https://github.com/hearsay-tools/cezarion/commit/3c27a8c80d1838de919fd80ad17ca8274e712534) | 2026-09-27 | keyboard selection scroll ported with ArrowUp and ArrowDown regression coverage |
| [#861](https://github.com/open-mercato/cezar/pull/861) | 2026-09-14 | fix(ui): keep CPU/Mem folded on queued task rows (#821) (#861) | [PR #652](https://github.com/hearsay-tools/cezarion/pull/652), [issue #432](https://github.com/hearsay-tools/cezarion/issues/432), [2b66db1d](https://github.com/hearsay-tools/cezarion/commit/2b66db1d) | 2026-09-27 | queued rows honor folded CPU/Mem columns; regression tests cover both folds and either expanded column |
| [#956](https://github.com/open-mercato/cezar/pull/956) | 2026-09-14 | feat(tasks): copy branch name from task header (#956) | [PR #645](https://github.com/hearsay-tools/cezarion/pull/645), [issue #434](https://github.com/hearsay-tools/cezarion/issues/434), [2dbe2799](https://github.com/hearsay-tools/cezarion/commit/2dbe279966c804cf3be2942dc28b8b6dc8871b95) | 2026-09-27 | Branch-adjacent copy control adapted to the fork header, with keyboard and theme coverage |
| [#942](https://github.com/open-mercato/cezar/pull/942) | 2026-09-14 | feat(thread): per-message timestamps in the task conversation (#942) | [PR #588](https://github.com/hearsay-tools/cezarion/pull/588) | 2026-09-25 | absent here; new files apply clean, 1 hunk in thread-items |
| [#973](https://github.com/open-mercato/cezar/pull/973) | 2026-09-14 | feat(ui): filter the new-task base branch picker (#973) | [PR #720](https://github.com/hearsay-tools/cezarion/pull/720), [issue #436](https://github.com/hearsay-tools/cezarion/issues/436) | 2026-10-01 | Ported optional branch-name filtering, preserving fork picker presentation and keyboard query refinement. |
| [#984](https://github.com/open-mercato/cezar/pull/984) | 2026-09-14 | fix(workflows): park intermediate asks for input (#984) | [PR #813](https://github.com/hearsay-tools/cezarion/pull/813), [issue #427](https://github.com/hearsay-tools/cezarion/issues/427), [33aa7462](https://github.com/hearsay-tools/cezarion/commit/33aa7462), [cd0cc36a](https://github.com/hearsay-tools/cezarion/commit/cd0cc36a) | 2026-10-04 | Ported intermediate ASK parking and lifecycle coverage using the fork durable waiting and Continue-tail recovery; upstream dispatch and budget-brake logic excluded. |
| [#968](https://github.com/open-mercato/cezar/pull/968) | 2026-09-14 | fix(clone): recover from GitHub organization SAML auth (#968) | [PR #719](https://github.com/hearsay-tools/cezarion/pull/719), [issue #437](https://github.com/hearsay-tools/cezarion/issues/437), [01e6d382](https://github.com/hearsay-tools/cezarion/commit/01e6d382061c18095793ff256cb247229382a2aa) | 2026-09-30 | Ported SAML recovery, HTTPS credentials, fork-parent HTTPS transport, and unterminated error output. |
| [#993](https://github.com/open-mercato/cezar/pull/993) | 2026-09-16 | fix(automations): a stale poll lock no longer silences every project for ten minutes (#993) | [PR #651](https://github.com/hearsay-tools/cezarion/pull/651), [issue #428](https://github.com/hearsay-tools/cezarion/issues/428), [0f47bdfa](https://github.com/hearsay-tools/cezarion/commit/0f47bdfa), [3ff408df](https://github.com/hearsay-tools/cezarion/commit/3ff408df) | 2026-09-27 |  |
| [#1014](https://github.com/open-mercato/cezar/pull/1014) | 2026-09-17 | fix(providers): a runtime auth rejection verifies itself before it sticks (#1014) | [PR #598](https://github.com/hearsay-tools/cezarion/pull/598), [issue #431](https://github.com/hearsay-tools/cezarion/issues/431) | 2026-09-25 |  |
| [#1009](https://github.com/open-mercato/cezar/pull/1009) | 2026-09-17 | fix(server-deploy): fail the deploy when the service did not actually restart (#1009) | [PR #644](https://github.com/hearsay-tools/cezarion/pull/644), [issue #430](https://github.com/hearsay-tools/cezarion/issues/430), [2d328382](https://github.com/hearsay-tools/cezarion/commit/2d328382), [0dfb93c6](https://github.com/hearsay-tools/cezarion/commit/0dfb93c6), [3e676ecd](https://github.com/hearsay-tools/cezarion/commit/3e676ecd) | 2026-09-27 |  |
| [#994](https://github.com/open-mercato/cezar/pull/994) | 2026-09-18 | fix(server-install): ubuntu-vps vhost emits a standalone http2 directive nginx < 1.25.1 rejects (#994) | [PR #648](https://github.com/hearsay-tools/cezarion/pull/648), [issue #429](https://github.com/hearsay-tools/cezarion/issues/429), [5847c428](https://github.com/hearsay-tools/cezarion/commit/5847c4282c26ba56fb95d833efc4f391e53b8600) | 2026-09-27 |  |
| [#1138](https://github.com/open-mercato/cezar/pull/1138) | 2026-09-28 | chore(desktop-release): macOS builds without a Developer ID are sealed ad-hoc, not left unsigned (#1138) | [PR #847](https://github.com/hearsay-tools/cezarion/pull/847) | 2026-10-05 | Ad-hoc sealing retained for macOS test artifacts; public releases require Developer ID signing and notarization. |
| [#1140](https://github.com/open-mercato/cezar/pull/1140) | 2026-09-28 | feat(desktop-release): an Arch Linux package (Omarchy, Manjaro, EndeavourOS) (#1140) | [PR #847](https://github.com/hearsay-tools/cezarion/pull/847) | 2026-10-05 | Arch package and release dependency validation ported with fork asset names. |
| [#1142](https://github.com/open-mercato/cezar/pull/1142) | 2026-09-28 | desktop-release: a second release of the rolling links no longer tries to move a tag (#1142) | [PR #847](https://github.com/hearsay-tools/cezarion/pull/847) | 2026-10-05 | Rolling release refresh preserves its existing tag and replaces assets. |
| [#1143](https://github.com/open-mercato/cezar/pull/1143) | 2026-09-28 | desktop-release: the .deb gets a permanent link like every other installer (#1143) | [PR #847](https://github.com/hearsay-tools/cezarion/pull/847) | 2026-10-05 | DEB stable download and checksum included in the rolling installer set. |
| [#1195](https://github.com/open-mercato/cezar/pull/1195) | 2026-09-30 | feat(self-update): development channel — run the desktop app on a worktree or a PR build (#1195) | [PR #847](https://github.com/hearsay-tools/cezarion/pull/847) | 2026-10-05 | Development worktrees and fork PR builds, macOS folder privacy handling and all-runner process attribution ported. |

## Partial (2)

| Upstream | Date | Title | Fork | Decided | Reason / note |
| --- | --- | --- | --- | --- | --- |
| [#985](https://github.com/open-mercato/cezar/pull/985) | 2026-09-15 | feat(automations): scheduled triggers, default-on, redesigned surface, creation from a prompt (#985) | [issue #766](https://github.com/hearsay-tools/cezarion/issues/766) | 2026-10-02 | stage 1 (hearsay-tools/cezarion#766) ported the schedule trigger, run-now, the kind-aware editor, list and log; the fork keeps CEZ_AUTOMATIONS=1 opt-in, the hearsay-tools/cezarion#651 lease and governed workers instead of default-on, lock replacement and task.dispatch. The CLI, built-in skill, prompt part, templates, calendars and stats are stages 2 and 3 — Adapt scheduling, prompt-based creation and the redesigned surface in stages; preserve the fork's opt-in default and governed workers instead of upstream dispatch |
| [#1196](https://github.com/open-mercato/cezar/pull/1196) | 2026-09-30 | fix(runs): keep tasks on the account you picked; bump desktop to 0.1.3 (#1196) | [PR #847](https://github.com/hearsay-tools/cezarion/pull/847) | 2026-10-05 | Desktop source snapshot integrated with an independent fork shell version of 0.1.0. The unrelated account-selection and workflow preflight changes remain unported. |

## Diverged (9)

| Upstream | Date | Title | Fork | Decided | Reason / note |
| --- | --- | --- | --- | --- | --- |
| [#966](https://github.com/open-mercato/cezar/pull/966) | 2026-09-13 | fix(web): improve task detail rendering performance (#966) | [PR #140](https://github.com/hearsay-tools/cezarion/pull/140) | 2026-09-18 | the fork did its own transcript virtualization and anchor work in hearsay-tools/cezarion#140, hearsay-tools/cezarion#162, hearsay-tools/cezarion#306 and hearsay-tools/cezarion#333; upstream patch is not applicable, ideas only |
| [#972](https://github.com/open-mercato/cezar/pull/972) | 2026-09-13 | feat(dispatch): a task may dispatch other tasks (replaces the missions experiment) (#972) | [PR #138](https://github.com/hearsay-tools/cezarion/pull/138) | 2026-09-18 | the fork built owned workers behind an authenticated controller (PRs hearsay-tools/cezarion#138, hearsay-tools/cezarion#151, hearsay-tools/cezarion#159, opt-in CEZ_DELEGATION=1) instead of upstream dispatch (cez task, default-on, budget carve-out); same primitive, incompatible control plane. Owner decision 2026-09-18: nothing borrowed — different by design: fork built owned workers with an authenticated controller (CEZ_DELEGATION); upstream dispatch (CEZ_DISPATCH) is an incompatible model. Units specs worth reading for the escalation ladder |
| [#965](https://github.com/open-mercato/cezar/pull/965) | 2026-09-14 | fix(ui): keep the task thread readable on a phone while an agent works (#965) | [PR #303](https://github.com/hearsay-tools/cezarion/pull/303) | 2026-09-18 | mobile thread jumps were fixed differently in hearsay-tools/cezarion#303; the throttling helpers here would conflict with the fork virtualizer |
| [#1005](https://github.com/open-mercato/cezar/pull/1005) | 2026-09-16 | fix(opencode): a turn longer than five minutes no longer parks the run under Needs you (#1005) | [PR #24](https://github.com/hearsay-tools/cezarion/pull/24) | 2026-09-18 | the fork already takes the OpenCode turn end from session.idle instead of the 300 s undici long-poll (PR hearsay-tools/cezarion#24, 2026-09-01), which is the same fix |
| [#1015](https://github.com/open-mercato/cezar/pull/1015) | 2026-09-17 | fix(dispatch): tell parents --budget is optional so uncapped trees don't get invented caps (#1015) | [PR #138](https://github.com/hearsay-tools/cezarion/pull/138) | 2026-09-18 | dispatch prompt fix for --budget; the fork has no dispatch budget and its worker CLI is documented in PR hearsay-tools/cezarion#138 |
| [#995](https://github.com/open-mercato/cezar/pull/995) | 2026-09-18 | fix(runs): a turn parked on its own dispatched subagents stops reading as "needs you" (#995) | [PR #258](https://github.com/hearsay-tools/cezarion/pull/258) | 2026-09-18 | dispatch-specific fix; the fork keeps live worker parents out of human attention in PR hearsay-tools/cezarion#258 |
| [#1132](https://github.com/open-mercato/cezar/pull/1132) | 2026-09-28 | feat: managed install, in-cockpit self-update and desktop app (#1132) | [PR #847](https://github.com/hearsay-tools/cezarion/pull/847) | 2026-10-05 | Ported the managed installer and native shell; added isolated remote windows, retained the fork npm updater, and kept fork branding and title-bar controls. |
| [#1137](https://github.com/open-mercato/cezar/pull/1137) | 2026-09-28 | fix(desktop-release): dry run mode, and three fixes the first run needed (#1137) | [PR #847](https://github.com/hearsay-tools/cezarion/pull/847) | 2026-10-05 | Ported dry-run and packaging fixes; public releases now require platform and updater signing instead of publishing unsigned installers. |
| [#1144](https://github.com/open-mercato/cezar/pull/1144) | 2026-09-28 | fix(desktop): the version chip landed on the brand row (shell 0.1.2) (#1144) | [PR #847](https://github.com/hearsay-tools/cezarion/pull/847) | 2026-10-05 | Retained the legacy shell overlay correction; the fork cockpit renders its own dedicated title band and update controls. |

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

