# Upstream ledger

Generated from `ledger.yaml` by `node .github/scripts/upstream-scan.cjs render`. Do not edit; edit the YAML.

- Upstream: [open-mercato/cezar](https://github.com/open-mercato/cezar) `main`
- Fork point: `feb85666` (2026-08-31)
- Last scan: 2026-10-26 to `f6b910f3` ([report](scans/2026-10-26.md))
- Entries: 366 · pending: 316 · planned: 7 · ported: 29 · partial: 1 · diverged: 6 · n/a: 7

## Pending (316)

| Upstream | Date | Title | Conflicts | Note |
| --- | --- | --- | --- | --- |
| [#954](https://github.com/open-mercato/cezar/pull/954) | 2026-09-13 | feat(tasks): switch runners with persisted context (#954) | 2 | fork still switches runners through the handoff file; 3 hunks in run.ts |
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
| [#1132](https://github.com/open-mercato/cezar/pull/1132) | 2026-09-28 | feat: managed install, in-cockpit self-update and desktop app (#1132) | 12 |  |
| [#1136](https://github.com/open-mercato/cezar/pull/1136) | 2026-09-28 | docs(readme): refresh screenshots and feature coverage for 0.12.0 (#1136) | 1 |  |
| [#1137](https://github.com/open-mercato/cezar/pull/1137) | 2026-09-28 | fix(desktop-release): dry run mode, and three fixes the first run needed (#1137) | 0 |  |
| [#1138](https://github.com/open-mercato/cezar/pull/1138) | 2026-09-28 | chore(desktop-release): macOS builds without a Developer ID are sealed ad-hoc, not left unsigned (#1138) | 0 |  |
| [#1140](https://github.com/open-mercato/cezar/pull/1140) | 2026-09-28 | feat(desktop-release): an Arch Linux package (Omarchy, Manjaro, EndeavourOS) (#1140) | 0 |  |
| [#1142](https://github.com/open-mercato/cezar/pull/1142) | 2026-09-28 | desktop-release: a second release of the rolling links no longer tries to move a tag (#1142) | 0 |  |
| [#1143](https://github.com/open-mercato/cezar/pull/1143) | 2026-09-28 | desktop-release: the .deb gets a permanent link like every other installer (#1143) | 0 |  |
| [#1144](https://github.com/open-mercato/cezar/pull/1144) | 2026-09-28 | fix(desktop): the version chip landed on the brand row (shell 0.1.2) (#1144) | 0 |  |
| [#1145](https://github.com/open-mercato/cezar/pull/1145) | 2026-09-28 | docs(readme): add a website pill to the badge row (#1145) | 1 |  |
| [#807](https://github.com/open-mercato/cezar/pull/807) | 2026-09-28 | feat: Cursor Agent CLI first-class runner (#807) | 60 |  |
| [#1146](https://github.com/open-mercato/cezar/pull/1146) | 2026-09-28 | chore(release): bump the release set to 0.13.0 and add the changelog entry (#1146) | 6 |  |
| [#1147](https://github.com/open-mercato/cezar/pull/1147) | 2026-09-28 | test(runs): cancel store saves still pending when a case ends (#1147) | 0 |  |
| [#1150](https://github.com/open-mercato/cezar/pull/1150) | 2026-09-30 | fix(runs): preserve monitoring before autonomous nudges (#1150) | 5 |  |
| [#1151](https://github.com/open-mercato/cezar/pull/1151) | 2026-09-30 | fix(runs): preserve multiple task PR references (#1151) | 8 |  |
| [#1122](https://github.com/open-mercato/cezar/pull/1122) | 2026-09-30 | fix(web): give native selects the cockpit focus ring, not the browser's blue one (#1122) | 1 |  |
| [#1125](https://github.com/open-mercato/cezar/pull/1125) | 2026-09-30 | fix(web): preserve renamed task titles (#1125) | 1 |  |
| [#1195](https://github.com/open-mercato/cezar/pull/1195) | 2026-09-30 | feat(self-update): development channel — run the desktop app on a worktree or a PR build (#1195) | 11 |  |
| [#1196](https://github.com/open-mercato/cezar/pull/1196) | 2026-09-30 | fix(runs): keep tasks on the account you picked; bump desktop to 0.1.3 (#1196) | 1 |  |
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
| [#1282](https://github.com/open-mercato/cezar/pull/1282) | 2026-10-05 | fix(runs): retire a stale workflow park when a later turn does not park (#1282) | 2 |  |
| [#1290](https://github.com/open-mercato/cezar/pull/1290) | 2026-10-06 | fix(runs): keep an unanswered CEZ:ASK under needs you after the idle close (#1290) | 11 |  |
| [#1280](https://github.com/open-mercato/cezar/pull/1280) | 2026-10-06 | docs(specs): repository file browser on the Git tab (#1280) | 0 |  |
| [#1278](https://github.com/open-mercato/cezar/pull/1278) | 2026-10-06 | fix(dispatch): derive runner lists in task and automation help (#1236) (#1278) | 0 |  |
| [#1258](https://github.com/open-mercato/cezar/pull/1258) | 2026-10-06 | fix: explain unsupported agent identities (#1258) | 1 |  |
| [#1246](https://github.com/open-mercato/cezar/pull/1246) | 2026-10-06 | test: cover screenshots queued before task startup (#1246) | 1 |  |
| [#1297](https://github.com/open-mercato/cezar/pull/1297) | 2026-10-06 | fix(test): stabilize issue-804 teardown and template races (#1297) | 2 |  |
| [#1294](https://github.com/open-mercato/cezar/pull/1294) | 2026-10-06 | fix(browser): support rootless staged agent-browser deps (#1294) | 2 |  |
| [#1298](https://github.com/open-mercato/cezar/pull/1298) | 2026-10-06 | fix(web): wrap long model-picker descriptions (#1298) | 1 |  |
| [#1244](https://github.com/open-mercato/cezar/pull/1244) | 2026-10-06 | fix(web): enlarge mobile step-rail touch target (#1244) | 2 |  |
| [#1242](https://github.com/open-mercato/cezar/pull/1242) | 2026-10-06 | fix(settings): persist idle timeout configuration (#1242) | 1 |  |
| [#1127](https://github.com/open-mercato/cezar/pull/1127) | 2026-10-06 | fix(automations): normalize legacy receipt identities (#1127) | 2 |  |
| [#1230](https://github.com/open-mercato/cezar/pull/1230) | 2026-10-06 | fix(codex): quiesce events after teardown (#1230) | 3 |  |
| [#1228](https://github.com/open-mercato/cezar/pull/1228) | 2026-10-06 | fix(core): gate cloud credentials by backend identity (#1228) | 1 |  |
| [#1210](https://github.com/open-mercato/cezar/pull/1210) | 2026-10-06 | fix(web): keep invalid bookmark runners in composer (#1210) | 1 |  |
| [#1229](https://github.com/open-mercato/cezar/pull/1229) | 2026-10-06 | fix(new-task): preserve attachments when discarding plans (#1229) | 1 |  |
| [#1256](https://github.com/open-mercato/cezar/pull/1256) | 2026-10-06 | fix(claude): explain headless permission denials (#1248) (#1256) | 3 |  |
| [#1312](https://github.com/open-mercato/cezar/pull/1312) | 2026-10-06 | fix(ask): lift the CEZ:ASK question and option caps (#1312) | 5 |  |
| [#1271](https://github.com/open-mercato/cezar/pull/1271) | 2026-10-06 | fix(auth): recognize OpenCode 2.x credential rows (#1271) | 0 |  |
| [#1153](https://github.com/open-mercato/cezar/pull/1153) | 2026-10-06 | fix(server): reject directories as launchers (#1153) | 1 |  |
| [#1208](https://github.com/open-mercato/cezar/pull/1208) | 2026-10-06 | fix(pi): preserve markers across content parts (#1208) | 1 |  |
| [#1273](https://github.com/open-mercato/cezar/pull/1273) | 2026-10-06 | fix(ui): allow longer reusable prompt templates (#1273) | 2 |  |
| [#1149](https://github.com/open-mercato/cezar/pull/1149) | 2026-10-06 | fix(server-install): fail macOS redeploy on restart errors (#1149) | 2 |  |
| [#1174](https://github.com/open-mercato/cezar/pull/1174) | 2026-10-06 | fix(server-install): expose terminal nginx parse failures (#1174) | 2 |  |
| [#1313](https://github.com/open-mercato/cezar/pull/1313) | 2026-10-07 | fix(web): jump to latest without reloading the thread (#1313) | 4 |  |
| [#1328](https://github.com/open-mercato/cezar/pull/1328) | 2026-10-07 | Remove plan mode from task composer (#1328) | 8 |  |
| [#1003](https://github.com/open-mercato/cezar/pull/1003) | 2026-10-08 | fix(server-install): allocate an instance's loopback port machine-wide, not per unix user (#1003) | 1 |  |
| [#1322](https://github.com/open-mercato/cezar/pull/1322) | 2026-10-08 | feat: workflow node editor and graph execution (#1322) | 22 |  |
| [#1327](https://github.com/open-mercato/cezar/pull/1327) | 2026-10-08 | feat: customizable cockpit branding (#1327) | 16 |  |
| [#1339](https://github.com/open-mercato/cezar/pull/1339) | 2026-10-08 | test(e2e): repair four assertions that had gone stale against the UI (#1339) | 2 |  |
| [#1299](https://github.com/open-mercato/cezar/pull/1299) | 2026-10-09 | feat(cockpit): browse the repository from the Git tab — tree, viewer and path filter (#1299) | 10 |  |
| [#1336](https://github.com/open-mercato/cezar/pull/1336) | 2026-10-09 | feat(web): filter tasks by origin (Regular \| Automations \| All) + Tasks facets (#1336) | 12 |  |
| [#1305](https://github.com/open-mercato/cezar/pull/1305) | 2026-10-09 | fix(cockpit): scroll the Changes tree and diff in their own columns (#1305) | 11 |  |
| [#1311](https://github.com/open-mercato/cezar/pull/1311) | 2026-10-09 | fix(web): fit nested sidebar rows at minimum width; mark unread by weight only (#1311) | 8 |  |
| [#1134](https://github.com/open-mercato/cezar/pull/1134) | 2026-10-09 | fix(runs): start a queued run with the workflow as it is at dequeue (#1134) | 2 |  |
| [#1051](https://github.com/open-mercato/cezar/pull/1051) | 2026-10-09 | fix(task-thread): the Subtasks panel collapses and scrolls instead of owning the header (#1051) | 2 |  |
| [#1254](https://github.com/open-mercato/cezar/pull/1254) | 2026-10-09 | test(cezar): turn LLM task naming off for the whole vitest run (#1254) | 1 |  |
| [#1348](https://github.com/open-mercato/cezar/pull/1348) | 2026-10-09 | test(graph): carry mock:done in the task so #1078's quick-task refresh keeps it (#1348) | 0 |  |
| [#1179](https://github.com/open-mercato/cezar/pull/1179) | 2026-10-09 | fix(runners): OpenCode port 0, string Codex RPC ids, dead Claude stdin (#1179) | 4 |  |
| [#1329](https://github.com/open-mercato/cezar/pull/1329) | 2026-10-09 | fix(git): keep SHA-pinned task diffs fresh (#1329) | 0 |  |
| [#1331](https://github.com/open-mercato/cezar/pull/1331) | 2026-10-09 | fix(dispatch): defer reports for unanswered child asks (#1331) | 1 |  |
| [#1257](https://github.com/open-mercato/cezar/pull/1257) | 2026-10-09 | fix: grant attachment library to live sessions (#1257) | 2 |  |
| [#1330](https://github.com/open-mercato/cezar/pull/1330) | 2026-10-09 | fix(tests): make automation gate warm-up deterministic (#1330) | 1 |  |
| [#1342](https://github.com/open-mercato/cezar/pull/1342) | 2026-10-09 | fix(server): share SSE event and deletion subscriptions (#1342) | 1 |  |
| [#1343](https://github.com/open-mercato/cezar/pull/1343) | 2026-10-09 | fix: refresh runner model catalogs in background (#1343) | 2 |  |
| [#1333](https://github.com/open-mercato/cezar/pull/1333) | 2026-10-09 | fix(process-usage): reuse indexes per sample (#1214) (#1333) | 1 |  |
| [#1332](https://github.com/open-mercato/cezar/pull/1332) | 2026-10-09 | fix(handoff): bound repeated heartbeat entries (#1332) | 0 |  |
| [#1133](https://github.com/open-mercato/cezar/pull/1133) | 2026-10-10 | fix(cli): explain a missing CEZ_API_URL to a person, add `cez runs list`, document the /api/v1 API (#1133) | 4 |  |
| [#1320](https://github.com/open-mercato/cezar/pull/1320) | 2026-10-10 | fix(github): keep PRs out of numeric issue search (#1320) | 1 |  |
| [#1334](https://github.com/open-mercato/cezar/pull/1334) | 2026-10-10 | fix(windows): accept native absolute paths in the project registry, checkout and workspace settings (#1334) | 1 |  |
| [#1360](https://github.com/open-mercato/cezar/pull/1360) | 2026-10-10 | chore(release): bump the release set to 0.15.0 and add the changelog entry (#1360) | 5 |  |
| [#1361](https://github.com/open-mercato/cezar/pull/1361) | 2026-10-10 | docs(agents): keep comments, PR bodies and changelog entries short (#1361) | 0 |  |
| [#1126](https://github.com/open-mercato/cezar/pull/1126) | 2026-10-10 | fix(workflows): keep check artifacts out of autosave commits (#1126) | 3 |  |
| [#1363](https://github.com/open-mercato/cezar/pull/1363) | 2026-10-10 | fix(resources): Activity-Monitor RAM on macOS and a host glance that keeps updating (#1363) | 1 |  |
| [#1364](https://github.com/open-mercato/cezar/pull/1364) | 2026-10-10 | chore: set up e2e browser tests (#1364) | 2 |  |
| [#1291](https://github.com/open-mercato/cezar/pull/1291) | 2026-10-10 | feat(secrets): encrypted project/workspace secrets for check steps and cezar, never for agents (#1291) | 21 |  |
| [#1365](https://github.com/open-mercato/cezar/pull/1365) | 2026-10-10 | docs(changelog): add the changes merged since 0.15.0 under Unreleased (#1365) | 1 |  |
| [#1373](https://github.com/open-mercato/cezar/pull/1373) | 2026-10-11 | fix(redaction): an sk- key never follows a letter, so task-… stays a word (#1373) | 0 |  |
| [#1357](https://github.com/open-mercato/cezar/pull/1357) | 2026-10-11 | fix queued follow-up visibility without worktrees (#1357) | 1 |  |
| [#1355](https://github.com/open-mercato/cezar/pull/1355) | 2026-10-11 | fix(automations): survive contended lease guard stalls (#1355) | 2 |  |
| [#1353](https://github.com/open-mercato/cezar/pull/1353) | 2026-10-11 | fix: preserve per-step model identity (#545) (#1353) | 1 |  |
| [#1350](https://github.com/open-mercato/cezar/pull/1350) | 2026-10-11 | fix(web): collapse Agents dock after completion (#1350) | 3 |  |
| [#1375](https://github.com/open-mercato/cezar/pull/1375) | 2026-10-11 | docs(changelog): add the changes merged since #1365 under Unreleased (#1375) | 1 |  |
| [#1347](https://github.com/open-mercato/cezar/pull/1347) | 2026-10-11 | docs(changelog): draft weekly changes for October 9 (#1347) | 0 |  |
| [#1376](https://github.com/open-mercato/cezar/pull/1376) | 2026-10-11 | docs(changelog): fold everything shipped in v0.15.0 into the 0.15.0 entry (#1376) | 1 |  |
| [#1380](https://github.com/open-mercato/cezar/pull/1380) | 2026-10-11 | fix(cockpit): Changes file jumps scroll only the diff (#1380) | 3 |  |
| [#1379](https://github.com/open-mercato/cezar/pull/1379) | 2026-10-11 | feat(web): refresh the ⭐ star count every 10 seconds (#1379) | 5 |  |
| [#916](https://github.com/open-mercato/cezar/pull/916) | 2026-10-11 | fix(automations): filter the timeline before validating it (#914) (#916) | 0 |  |
| [#1337](https://github.com/open-mercato/cezar/pull/1337) | 2026-10-11 | feat(web): regroup the run header around one next-step git button (#1337) | 20 |  |
| [#1187](https://github.com/open-mercato/cezar/pull/1187) | 2026-10-11 | perf(history): cheap task reopen, streamed replay, tail seq resume (#1187) | 10 |  |
| [#1310](https://github.com/open-mercato/cezar/pull/1310) | 2026-10-11 | feat(web): show the full command an agent ran in an expanded tool card (#1306) (#1310) | 1 |  |
| [#1154](https://github.com/open-mercato/cezar/pull/1154) | 2026-10-12 | fix(runs): preserve DONE and ASK before task references (#1154) | 3 |  |
| [#1381](https://github.com/open-mercato/cezar/pull/1381) | 2026-10-12 | feat: anonymous telemetry — usage metrics and error reports to improve cezar (#1381) | 21 |  |
| [#1395](https://github.com/open-mercato/cezar/pull/1395) | 2026-10-12 | test(telemetry): key sends by endpoint, not arrival order (#1395) | 0 |  |
| [#1404](https://github.com/open-mercato/cezar/pull/1404) | 2026-10-12 | fix(desktop): find Node 20+ wherever an installer or version manager put it (shell 0.1.4) (#1404) | 0 |  |
| [#1405](https://github.com/open-mercato/cezar/pull/1405) | 2026-10-12 | feat(desktop): managed Node.js runtime, so the app has no prerequisite (shell 0.1.5) (#1405) | 0 |  |
| [#1406](https://github.com/open-mercato/cezar/pull/1406) | 2026-10-12 | feat(desktop): the shell reports its own failures, or offers a button to (shell 0.1.6) (#1406) | 2 |  |
| [#1407](https://github.com/open-mercato/cezar/pull/1407) | 2026-10-12 | fix(desktop): macOS privacy prompts name the agent, not "2.1.295" or "node" (#1407) | 0 |  |
| [#1409](https://github.com/open-mercato/cezar/pull/1409) | 2026-10-12 | ci(desktop): give the macOS release legs room for Apple notarization (#1409) | 0 |  |
| [#1383](https://github.com/open-mercato/cezar/pull/1383) | 2026-10-12 | fix(git): fork tasks from and open PRs on the PR-target remote, not a hard-coded origin (#1383) | 8 |  |
| [#1384](https://github.com/open-mercato/cezar/pull/1384) | 2026-10-12 | fix(web): keep multi-line code fences on separate lines in the thread (#1384) | 1 |  |
| [#1408](https://github.com/open-mercato/cezar/pull/1408) | 2026-10-12 | fix: error popup should be reported (#1408) | 2 |  |
| [#1356](https://github.com/open-mercato/cezar/pull/1356) | 2026-10-12 | fix(web): contain oversized Markdown in task threads (#1356) | 1 |  |
| [#1398](https://github.com/open-mercato/cezar/pull/1398) | 2026-10-12 | feat: branch naming instructions and project settings regrouping (#1398) | 15 |  |
| [#1415](https://github.com/open-mercato/cezar/pull/1415) | 2026-10-13 | feat(automations): pull_request.closed and pull_request.merged GitHub triggers (#1415) | 10 |  |
| [#1416](https://github.com/open-mercato/cezar/pull/1416) | 2026-10-13 | ci: shard the vitest suites and drop the mock's demo pacing in tests (#1416) | 6 |  |
| [#1414](https://github.com/open-mercato/cezar/pull/1414) | 2026-10-13 | fix(web): show the pointer cursor on buttons and menu items (#1414) | 2 |  |
| [#1401](https://github.com/open-mercato/cezar/pull/1401) | 2026-10-14 | docs(specs): outbound webhooks — signed task events per project (#1401) | 0 |  |
| [#1418](https://github.com/open-mercato/cezar/pull/1418) | 2026-10-14 | chore(release): bump the release set to 0.15.1 and add the changelog entry (#1418) | 8 |  |
| [#1417](https://github.com/open-mercato/cezar/pull/1417) | 2026-10-14 | feat(web): sidebar pin + archive row actions, Pinned section in the Tasks table (#1417) | 7 |  |
| [#1428](https://github.com/open-mercato/cezar/pull/1428) | 2026-10-14 | fix(server): gate runs on the selected agent account, not only the default login (#1428) | 3 |  |
| [#1430](https://github.com/open-mercato/cezar/pull/1430) | 2026-10-14 | fix(server): adopt an existing PR and retry transient gh pr create failures (#1430) | 2 |  |
| [#1431](https://github.com/open-mercato/cezar/pull/1431) | 2026-10-14 | fix(server): open the login when Connect cannot read an agent's auth state, and observe sign-in (#1431) | 10 |  |
| [#1436](https://github.com/open-mercato/cezar/pull/1436) | 2026-10-14 | fix(server): outlive the browser's keep-alive pool so a POST never lands on a closed socket (#1436) | 1 |  |
| [#1429](https://github.com/open-mercato/cezar/pull/1429) | 2026-10-14 | fix(skills): install a task's selected skill and its companions into its worktree (#1429) | 5 |  |
| [#1435](https://github.com/open-mercato/cezar/pull/1435) | 2026-10-14 | fix(runs): continue in a fresh session when Claude has pruned the conversation (#1435) | 8 |  |
| [#1441](https://github.com/open-mercato/cezar/pull/1441) | 2026-10-14 | feat(telemetry): report the transport cause of 'cannot reach the cezar server' errors (#1437) (#1441) | 5 |  |
| [#1390](https://github.com/open-mercato/cezar/pull/1390) | 2026-10-14 | fix(ui): stop rebuilding foreign issue and PR numbers into the project's repo (#819, #854) (#1390) | 5 |  |
| [#1440](https://github.com/open-mercato/cezar/pull/1440) | 2026-10-14 | feat(telemetry): count session-resume fallbacks and task failures (#1440) | 8 |  |
| [#1426](https://github.com/open-mercato/cezar/pull/1426) | 2026-10-15 | feat: GitHub Enterprise as a GitHub provider on any domain (#1426) | 13 |  |
| [#1443](https://github.com/open-mercato/cezar/pull/1443) | 2026-10-15 | chore(release): bump the release set to 0.15.2 and add the changelog entry (#1443) | 8 |  |
| [#1451](https://github.com/open-mercato/cezar/pull/1451) | 2026-10-15 | fix: accept attachment-only tasks on POST /runs (telemetry 18c930de) (#1451) | 4 |  |
| [#1447](https://github.com/open-mercato/cezar/pull/1447) | 2026-10-15 | fix(skills): follow a dropped skills-update apply to its result (#1447) | 6 |  |
| [#1452](https://github.com/open-mercato/cezar/pull/1452) | 2026-10-15 | feat(telemetry): label task archive/pin events with the button used, not the task status (#1452) | 10 |  |
| [#1448](https://github.com/open-mercato/cezar/pull/1448) | 2026-10-15 | feat(attachments): stage uploads on attach — up to 20 per message, 20 MB of images (#1448) | 22 |  |
| [#1453](https://github.com/open-mercato/cezar/pull/1453) | 2026-10-15 | fix(dictation): hide the mic where it can't work, group dictation failures as one (telemetry 38ccdbdc) (#1453) | 6 |  |
| [#1456](https://github.com/open-mercato/cezar/pull/1456) | 2026-10-15 | fix(provider-auth): probe Copilot with --no-auto-update and name a non-ACP copilot (telemetry 298c2e1f) (#1456) | 2 |  |
| [#1454](https://github.com/open-mercato/cezar/pull/1454) | 2026-10-15 | fix(cockpit): reload once when a stale shell's chunk fails to load (#1454) | 1 |  |
| [#1455](https://github.com/open-mercato/cezar/pull/1455) | 2026-10-15 | fix(cockpit): hide Terminal resume in hosted mode (telemetry f179cc7d) (#1455) | 1 |  |
| [#1458](https://github.com/open-mercato/cezar/pull/1458) | 2026-10-15 | fix(pr): survive a dropped response to the PR publish (telemetry 9119d21a) (#1458) | 2 |  |
| [#1462](https://github.com/open-mercato/cezar/pull/1462) | 2026-10-15 | fix(repo): don't offer to switch to a branch another worktree holds (telemetry da5ca728) (#1462) | 5 |  |
| [#1461](https://github.com/open-mercato/cezar/pull/1461) | 2026-10-15 | fix(install): retry with a cezar-owned npm cache when ~/.npm is root-owned (telemetry 7a3f659a) (#1461) | 3 |  |
| [#1463](https://github.com/open-mercato/cezar/pull/1463) | 2026-10-15 | chore(desktop): bump the shell to 0.1.7 for the npm-cache EACCES fix (#1461) (#1463) | 4 |  |
| [#1460](https://github.com/open-mercato/cezar/pull/1460) | 2026-10-15 | fix(spawn): run Windows npm .cmd shims as node <script> (telemetry a330744e) (#1460) | 8 |  |
| [#1459](https://github.com/open-mercato/cezar/pull/1459) | 2026-10-15 | fix(pr): don't offer or push an empty branch as a PR (telemetry 16aef26d) (#1459) | 11 |  |
| [#1466](https://github.com/open-mercato/cezar/pull/1466) | 2026-10-15 | fix(provider-auth): re-ask a CLI that exits 0 having printed nothing (telemetry 35838a52) (#1466) | 2 |  |
| [#1467](https://github.com/open-mercato/cezar/pull/1467) | 2026-10-15 | fix(thread): wait out a session gap instead of failing a reply with 409 session closed (telemetry 1408d7cb) (#1467) | 2 |  |
| [#1433](https://github.com/open-mercato/cezar/pull/1433) | 2026-10-16 | feat(web): sort Tasks by last activity, with a Recent/Created toggle (#1433) | 20 |  |
| [#1470](https://github.com/open-mercato/cezar/pull/1470) | 2026-10-16 | fix(spawn): run npm's .ps1 shims and native-binary shims without a shell (telemetry 3626ac13) (#1470) | 4 |  |
| [#1473](https://github.com/open-mercato/cezar/pull/1473) | 2026-10-16 | fix(thread): treat 'run is still active' on a one-click Continue as already live, not a failure (telemetry 77117b95) (#1473) | 6 |  |
| [#1474](https://github.com/open-mercato/cezar/pull/1474) | 2026-10-16 | test(thread): pin the review send-back recovery; footer Continue is not a message_sent (#1473 review) (#1474) | 4 |  |
| [#1472](https://github.com/open-mercato/cezar/pull/1472) | 2026-10-16 | fix(automations): copy filters and skill steps from another project's automation; flag prompt-only author conditions (#1472) | 8 |  |
| [#1424](https://github.com/open-mercato/cezar/pull/1424) | 2026-10-16 | feat: task terminal and workspace layouts from brutus, with the terminal as a view (#1424) | 42 |  |
| [#1481](https://github.com/open-mercato/cezar/pull/1481) | 2026-10-16 | feat(telemetry): report agent errors shown in a thread; offer Update for an outdated agent CLI (#1481) | 10 |  |
| [#1495](https://github.com/open-mercato/cezar/pull/1495) | 2026-10-17 | feat(worktrees): run lifecycle scripts with explicit recovery (#1495) | 36 |  |
| [#1413](https://github.com/open-mercato/cezar/pull/1413) | 2026-10-17 | feat(settings): one full-screen settings surface with a shared sidebar (#1413) | 24 |  |
| [#1482](https://github.com/open-mercato/cezar/pull/1482) | 2026-10-17 | fix(composer): accept HTML, CSV, JSON and source files as attachments (telemetry 6c4b3066) (#1482) | 1 |  |
| [#1492](https://github.com/open-mercato/cezar/pull/1492) | 2026-10-17 | feat: Design Mode and Preview as the task workspace's Browser view (supersedes #1422, #1423) (#1492) | 40 |  |
| [#1501](https://github.com/open-mercato/cezar/pull/1501) | 2026-10-17 | test(worktrees): a settled lifecycle operation waits for its record to release it (#1501) | 1 |  |
| [#1497](https://github.com/open-mercato/cezar/pull/1497) | 2026-10-17 | fix(provider-gate): name a signed-out selected account, and check it before Start (telemetry ac53a6ef) (#1497) | 7 |  |
| [#1500](https://github.com/open-mercato/cezar/pull/1500) | 2026-10-18 | fix(opencode): answer permission prompts so a run never hangs on one (#1500) | 3 |  |
| [#1503](https://github.com/open-mercato/cezar/pull/1503) | 2026-10-18 | fix(provider-auth): resolve Cursor's cursor-agent first, read older CLIs' plain status (telemetry 8d304c50) (#1503) | 7 |  |
| [#1502](https://github.com/open-mercato/cezar/pull/1502) | 2026-10-18 | fix(telemetry): scrub file names from toast reports so attachment refusals group (telemetry 0f1255b6) (#1502) | 4 |  |
| [#1504](https://github.com/open-mercato/cezar/pull/1504) | 2026-10-18 | fix(provider-auth): report a version-manager shim with nothing behind it as not-installed (telemetry f67df9d2) (#1504) | 2 |  |
| [#1457](https://github.com/open-mercato/cezar/pull/1457) | 2026-10-18 | fix(web): highlight each diff hunk and side separately (#1457) | 0 |  |
| [#1505](https://github.com/open-mercato/cezar/pull/1505) | 2026-10-18 | feat(web): ⌘P task palette — act on tasks, switch fast, keyboard shortcuts (#1505) | 26 |  |
| [#1510](https://github.com/open-mercato/cezar/pull/1510) | 2026-10-18 | fix(attachments): take any file as a path-only binary attachment instead of refusing it (telemetry 48850f4a) (#1510) | 7 |  |
| [#1511](https://github.com/open-mercato/cezar/pull/1511) | 2026-10-18 | fix(provider-auth): latch a runtime auth rejection on the agent account that ran (telemetry 9e4a95db) (#1511) | 7 |  |
| [#1512](https://github.com/open-mercato/cezar/pull/1512) | 2026-10-19 | feat(self-update): update when idle (#1512) | 12 |  |
| [#1514](https://github.com/open-mercato/cezar/pull/1514) | 2026-10-19 | fix(windows): retry transient EPERM/EBUSY when atomically replacing state files (telemetry 4a7c9f6c) (#1514) | 3 |  |
| [#1515](https://github.com/open-mercato/cezar/pull/1515) | 2026-10-19 | fix(windows): retry transient EPERM in the async atomic writers too (#1515) | 8 |  |
| [#1516](https://github.com/open-mercato/cezar/pull/1516) | 2026-10-19 | fix(provider-auth): re-ask a status probe a signal interrupted instead of reporting it (telemetry ce0c5d1f) (#1516) | 2 |  |
| [#1517](https://github.com/open-mercato/cezar/pull/1517) | 2026-10-19 | fix(provider-auth): ask a timed-out status probe once more with a longer budget (telemetry e316b141) (#1517) | 2 |  |
| [#1518](https://github.com/open-mercato/cezar/pull/1518) | 2026-10-19 | fix(agent-profiles): resolve an unregistered boot project when saving an account selection (telemetry d81f8db7) (#1518) | 0 |  |
| [#1519](https://github.com/open-mercato/cezar/pull/1519) | 2026-10-19 | fix(provider-auth): a hung status probe keeps a recent connected answer (telemetry b28d2993) (#1519) | 2 |  |
| [#1520](https://github.com/open-mercato/cezar/pull/1520) | 2026-10-19 | fix(runs): never prune a live run or its dispatch ancestors (telemetry 73c6e796) (#1520) | 2 |  |
| [#1521](https://github.com/open-mercato/cezar/pull/1521) | 2026-10-19 | fix(web): stop the host widget's per-frame effect setState from tripping React #185 (telemetry 21762d83) (#1521) | 4 |  |
| [#1522](https://github.com/open-mercato/cezar/pull/1522) | 2026-10-19 | fix(runs): honor a cancel that lands while a continuation awaits its lifecycle gate (#1522) | 3 |  |
| [#1527](https://github.com/open-mercato/cezar/pull/1527) | 2026-10-19 | fix(runs): honor Finish while a closed session is still settling (telemetry 6a3cecee) (#1527) | 2 |  |
| [#1525](https://github.com/open-mercato/cezar/pull/1525) | 2026-10-19 | feat(web): task tab row, Terminal as a view, layouts saved by name for every task (#1525) | 29 |  |
| [#1523](https://github.com/open-mercato/cezar/pull/1523) | 2026-10-19 | perf(web): make the Changes tab instant to revisit and responsive on large diffs (#1523) | 9 |  |
| [#1528](https://github.com/open-mercato/cezar/pull/1528) | 2026-10-19 | feat(git): Source-Control sync for the main checkout + in-place tasks on a new branch (#1528) | 17 |  |
| [#1530](https://github.com/open-mercato/cezar/pull/1530) | 2026-10-19 | fix(self-update): show a worktree-linked version as -dev (#1530) | 8 |  |
| [#1524](https://github.com/open-mercato/cezar/pull/1524) | 2026-10-19 | fix(self-update): count running tasks across every project; when idle for every picker (#1524) | 9 |  |
| [#1529](https://github.com/open-mercato/cezar/pull/1529) | 2026-10-19 | feat(web): agent-driven git steps with loading states in the run header (#1529) | 24 |  |
| [#1494](https://github.com/open-mercato/cezar/pull/1494) | 2026-10-19 | feat(preview): run the task's app from an empty Preview, with per-project start recipes (#1494) | 14 |  |
| [#1531](https://github.com/open-mercato/cezar/pull/1531) | 2026-10-19 | ci(release): release lines — cut, patch-first release and backport workflows; main → 0.16.0 (#1531) | 12 |  |
| [#1532](https://github.com/open-mercato/cezar/pull/1532) | 2026-10-19 | chore(release): open 0.17.0 on main (#1532) | 5 |  |
| [#1534](https://github.com/open-mercato/cezar/pull/1534) | 2026-10-19 | fix(provider-auth): fall back on any --format rejection, read more plain Cursor status shapes (telemetry 1cd541cc) (#1534) | 2 |  |
| [#1535](https://github.com/open-mercato/cezar/pull/1535) | 2026-10-19 | docs(agents): make the backport decision part of opening a fix PR, add a PR template (#1535) | 2 |  |
| [#1537](https://github.com/open-mercato/cezar/pull/1537) | 2026-10-19 | fix(opencode): don't fail a run whose server starts slowly or prints its URL elsewhere (telemetry 2d01c3c9) (#1537) | 3 |  |
| [#1539](https://github.com/open-mercato/cezar/pull/1539) | 2026-10-20 | fix(boot): don't exit when a project's .ai/cezar cannot be created (telemetry 5af5aec6) (#1539) | 3 |  |
| [#1542](https://github.com/open-mercato/cezar/pull/1542) | 2026-10-20 | docs(changelog): add the 0.16.0 entry (#1542) | 1 |  |
| [#1544](https://github.com/open-mercato/cezar/pull/1544) | 2026-10-20 | fix(desktop): load the task Preview in the app, keep colored ports in detected addresses (shell 0.1.9) (#1544) | 10 |  |
| [#1546](https://github.com/open-mercato/cezar/pull/1546) | 2026-10-20 | fix(provider-auth): hold Copilot's probe stdin open until session/new is answered (telemetry 298c2e1f) (#1546) | 2 |  |
| [#1548](https://github.com/open-mercato/cezar/pull/1548) | 2026-10-20 | fix(provider-auth): report Cursor and pi not-installed when the binary on PATH isn't the CLI (telemetry 8d304c50, f67df9d2) (#1548) | 5 |  |
| [#1550](https://github.com/open-mercato/cezar/pull/1550) | 2026-10-20 | fix(codex): wait out or fork a thread another app-server still holds on resume (telemetry 4c9de01a) (#1550) | 3 |  |
| [#1551](https://github.com/open-mercato/cezar/pull/1551) | 2026-10-20 | fix(desktop): let the macOS app use the microphone for dictation (shell 0.1.10, telemetry c55c7b0b) (#1551) | 7 |  |
| [#1552](https://github.com/open-mercato/cezar/pull/1552) | 2026-10-20 | fix(telemetry): group usage-limit agent errors across reset instants; honor a weekly reset's day (telemetry 987e8238) (#1552) | 3 |  |
| [#1553](https://github.com/open-mercato/cezar/pull/1553) | 2026-10-20 | fix(provider-auth): ask OpenCode 2.x with a private server when its background service fails (telemetry 107e44a9) (#1553) | 2 |  |
| [#1559](https://github.com/open-mercato/cezar/pull/1559) | 2026-10-20 | fix(settings): disable Add project for a launch folder the server refuses (telemetry 48dc0f71) (#1559) | 7 |  |
| [#1560](https://github.com/open-mercato/cezar/pull/1560) | 2026-10-20 | fix(telemetry): scrub every attachable file name from toast reports (telemetry 5fc3ffbb, d77d0047) (#1560) | 3 |  |
| [#1561](https://github.com/open-mercato/cezar/pull/1561) | 2026-10-20 | fix(provider-auth): keep a dead Claude login latched instead of self-checking it away (telemetry 9e4a95db) (#1561) | 5 |  |
| [#1567](https://github.com/open-mercato/cezar/pull/1567) | 2026-10-20 | docs(changelog): add the 0.16.1 entry (#1567) | 1 |  |
| [#1573](https://github.com/open-mercato/cezar/pull/1573) | 2026-10-20 | fix(opencode): name OpenCode 2.x instead of failing with a bare 405 (telemetry dc1a91a6) (#1573) | 3 |  |
| [#1574](https://github.com/open-mercato/cezar/pull/1574) | 2026-10-21 | fix(provider-auth): silence OpenCode CLI startup failures (telemetry 107e44a9) (#1574) | 2 |  |
| [#1575](https://github.com/open-mercato/cezar/pull/1575) | 2026-10-21 | fix(web): retry transient query fetch failures (telemetry 4678fce9) (#1575) | 0 |  |
| [#1592](https://github.com/open-mercato/cezar/pull/1592) | 2026-10-21 | fix(dispatch): don't hand a child another runner's model (telemetry 43bdda11) (#1592) | 3 |  |
| [#1570](https://github.com/open-mercato/cezar/pull/1570) | 2026-10-21 | fix(server-install): forward Host with its port in the nginx vhost (#1570) | 0 |  |
| [#1585](https://github.com/open-mercato/cezar/pull/1585) | 2026-10-21 | fix(opencode): respawn on a fresh port when the random one is taken (#1585) | 2 |  |
| [#1571](https://github.com/open-mercato/cezar/pull/1571) | 2026-10-21 | fix(codex): surface a turn/completed whose status is failed as a turn error (#1571) | 3 |  |
| [#1597](https://github.com/open-mercato/cezar/pull/1597) | 2026-10-21 | feat(projects): trunk-based development model — work in the checkout, review, Commit to the base branch (#1597) | 29 |  |
| [#1606](https://github.com/open-mercato/cezar/pull/1606) | 2026-10-22 | fix(composer): keep the thread still while the composer autosizes (#1606) | 1 |  |
| [#1371](https://github.com/open-mercato/cezar/pull/1371) | 2026-10-23 | fix(security): accept mapped IPv6 loopback authorities (#1371) | 0 |  |
| [#1425](https://github.com/open-mercato/cezar/pull/1425) | 2026-10-23 | fix(web): preserve relative file links in transcripts (#1425) | 3 |  |
| [#1427](https://github.com/open-mercato/cezar/pull/1427) | 2026-10-23 | fix(web): keep the GitHub tab for a recognized remote while the forge probe is cold or failing (#1427) | 9 |  |
| [#1631](https://github.com/open-mercato/cezar/pull/1631) | 2026-10-23 | feat(accounts): manage agent accounts on an authenticated self-hosted cockpit (#1631) | 8 |  |
| [#1419](https://github.com/open-mercato/cezar/pull/1419) | 2026-10-23 | fix(runs): stop processes a task leaves running when it settles (#1419) | 5 |  |
| [#1469](https://github.com/open-mercato/cezar/pull/1469) | 2026-10-23 | fix(gh): run gh without a session bus it would have to start, so no dbus-daemon is left behind per call (#1469) | 6 |  |
| [#1605](https://github.com/open-mercato/cezar/pull/1605) | 2026-10-23 | feat(ask): answer an agent's question with your own text or ask for more context (#1605) | 5 |  |
| [#1434](https://github.com/open-mercato/cezar/pull/1434) | 2026-10-23 | feat(tasks): schedule task starts by date or usage reset (#1340) (#1434) | 50 |  |
| [#1634](https://github.com/open-mercato/cezar/pull/1634) | 2026-10-23 | fix(preview): follow in-page URL changes in the address bar and Reload (#1634) | 4 |  |
| [#1638](https://github.com/open-mercato/cezar/pull/1638) | 2026-10-23 | chore(desktop): bump shell to 0.1.11 (#1638) | 4 |  |
| [#1639](https://github.com/open-mercato/cezar/pull/1639) | 2026-10-23 | docs(changelog): add the 0.16.2 entry (#1639) | 1 |  |
| [#1640](https://github.com/open-mercato/cezar/pull/1640) | 2026-10-23 | ci(release): GitHub App token, tag-triggered publish, resume-safe release lines (#1640) | 17 |  |
| [#1644](https://github.com/open-mercato/cezar/pull/1644) | 2026-10-23 | docs(release): runbook for a conflicted backport (#1644) | 1 |  |
| [#1568](https://github.com/open-mercato/cezar/pull/1568) | 2026-10-23 | feat(changes): preview the old side of deleted and modified images (#1568) | 8 |  |
| [#1335](https://github.com/open-mercato/cezar/pull/1335) | 2026-10-23 | fix(ui): preserve Windows roots in folder browser back navigation (#1335) | 2 |  |
| [#1442](https://github.com/open-mercato/cezar/pull/1442) | 2026-10-23 | fix(runs): carry pasted attachments into a fresh-session continuation (#1442) | 3 |  |
| [#1572](https://github.com/open-mercato/cezar/pull/1572) | 2026-10-23 | fix(models): know `fable` as a Claude tier alias so a runner switch clears it (#1572) | 3 |  |
| [#1309](https://github.com/open-mercato/cezar/pull/1309) | 2026-10-23 | docs(spec): full command in expanded tool cards (#1306) (#1309) | 0 |  |
| [#1645](https://github.com/open-mercato/cezar/pull/1645) | 2026-10-23 | fix(auto-resume): resume now when a clock-only usage-limit reset just passed (telemetry 4bf9686a) (#1645) | 1 |  |
| [#1190](https://github.com/open-mercato/cezar/pull/1190) | 2026-10-23 | perf(events): slim the workspace run frame and serialize each frame once (#1190) | 11 |  |
| [#1479](https://github.com/open-mercato/cezar/pull/1479) | 2026-10-23 | feat(skills): organisation skills repos in Global settings, grouped by repository (#1479) | 18 |  |
| [#1191](https://github.com/open-mercato/cezar/pull/1191) | 2026-10-23 | perf(tasks): render only changed task rows and drop idle cockpit polls (#1191) | 11 |  |
| [#1650](https://github.com/open-mercato/cezar/pull/1650) | 2026-10-23 | feat(web): resizable file tree on the Changes views (#1650) | 5 |  |
| [#1124](https://github.com/open-mercato/cezar/pull/1124) | 2026-10-23 | fix(cli): preserve the cockpit API origin for dispatch (#1124) | 1 |  |
| [#1653](https://github.com/open-mercato/cezar/pull/1653) | 2026-10-24 | feat(queue): Start now — run a queued task over the maxParallel cap (#1653) | 6 |  |
| [#1654](https://github.com/open-mercato/cezar/pull/1654) | 2026-10-24 | fix(opencode): fail a turn stuck in a long session.status retry (#1654) | 3 |  |
| [#1657](https://github.com/open-mercato/cezar/pull/1657) | 2026-10-24 | feat(web): schedule from a split Send button, with telemetry (#1657) | 12 |  |
| [#1658](https://github.com/open-mercato/cezar/pull/1658) | 2026-10-24 | feat(design-mode): batch notes, deliberate delete, ⌥D toggle (#1658) | 12 |  |
| [#1659](https://github.com/open-mercato/cezar/pull/1659) | 2026-10-24 | fix(provider-auth): read probe failures as what they are (telemetry 298c2e1f, a5c13018, 35838a52, b82b92cf, 1ba77383, ff609bf9) (#1659) | 4 |  |
| [#1660](https://github.com/open-mercato/cezar/pull/1660) | 2026-10-24 | fix(agents): attribute errors to the step's backend; copilot add-dir and mid-turn exit (#1660) | 7 |  |
| [#1661](https://github.com/open-mercato/cezar/pull/1661) | 2026-10-24 | fix: deliver Continue through a settling run, a lost POST and a refused history write (#1661) | 7 |  |
| [#1662](https://github.com/open-mercato/cezar/pull/1662) | 2026-10-24 | fix(cockpit): fix toast bugs and stop reporting expected outcomes as errors (#1662) | 15 |  |
| [#1664](https://github.com/open-mercato/cezar/pull/1664) | 2026-10-24 | fix(agents): latch real vendor auth failures, read JSON error envelopes (+ spec) (#1664) | 9 |  |
| [#1665](https://github.com/open-mercato/cezar/pull/1665) | 2026-10-24 | fix(engine): drop a foreign model pin when Continue switches runner (#1665) | 0 |  |
| [#1663](https://github.com/open-mercato/cezar/pull/1663) | 2026-10-24 | fix(desktop): boot the sidecar from home, take wry's drag-drop fix; guard child stdin EPIPE (#1663) | 9 |  |
| [#1678](https://github.com/open-mercato/cezar/pull/1678) | 2026-10-24 | fix(provider-auth): recognize configured Codex API keys (#1678) | 0 |  |
| [#1666](https://github.com/open-mercato/cezar/pull/1666) | 2026-10-24 | fix(models): accept Copilot/Cursor vendor ids; automations drop a cross-runner model (#1666) | 6 |  |
| [#1676](https://github.com/open-mercato/cezar/pull/1676) | 2026-10-25 | feat(telemetry): measure who uses automations, workflows, skills and dispatch (#1676) | 11 |  |
| [#1629](https://github.com/open-mercato/cezar/pull/1629) | 2026-10-25 | fix(workspace): never merge-write defaults over a config that could not be read (#1629) | 4 |  |
| [#976](https://github.com/open-mercato/cezar/pull/976) | 2026-10-25 | fix(cockpit): use full task detail width by default (#976) | 7 |  |
| [#1315](https://github.com/open-mercato/cezar/pull/1315) | 2026-10-25 | fix(workflows): resume remaining steps after a usage limit (#1315) | 5 |  |

## Planned (7)

| Upstream | Date | Title | Fork | Decided | Reason / note |
| --- | --- | --- | --- | --- | --- |
| [#940](https://github.com/open-mercato/cezar/pull/940) | 2026-09-14 | feat(tasks): in-task drafts survive leaving the task (#940) | [issue #1009](https://github.com/hearsay-tools/cezarion/issues/1009) | 2026-10-13 | Adapt bounded per-run and per-surface drafts, attachments and failed-send preservation to current reachable views and browser coordination; preserve drafts through archive retention. |
| [#1283](https://github.com/open-mercato/cezar/pull/1283) | 2026-10-05 | feat(cockpit): comment on diff lines and send them to the agent as a review (#1283) | [issue #1010](https://github.com/hearsay-tools/cezarion/issues/1010) | 2026-10-13 | Depends on hearsay-tools/cezarion#1009; adapt line/range comments, per-run draft reconciliation and review transcript rendering to the fork review gate. |
| [#1265](https://github.com/open-mercato/cezar/pull/1265) | 2026-10-05 | feat(workflows): gate the check retry loop by exit code, for agentic e2e checks (#1265) | [issue #1011](https://github.com/hearsay-tools/cezarion/issues/1011) | 2026-10-13 | Port onFail.retryOn while preserving absent/empty any-nonzero semantics, bounded retries and GUI serialization; exclude unrelated graph/planner changes. |
| [#1231](https://github.com/open-mercato/cezar/pull/1231) | 2026-10-06 | fix(skills): preserve YAML frontmatter and atomic writes (#1231) | [issue #1008](https://github.com/hearsay-tools/cezarion/issues/1008) | 2026-10-13 | Parser portion planned in hearsay-tools/cezarion#1008. Upstream atomic workspace-write changes remain unplanned; mark partial after the parser lands unless separate evidence proves equivalent writer guarantees. |
| [#1324](https://github.com/open-mercato/cezar/pull/1324) | 2026-10-08 | feat: private, per-project MCP servers for every agent run (#1324) | [issue #1013](https://github.com/hearsay-tools/cezarion/issues/1013) | 2026-10-13 | Adapt private project MCP launch configuration to all six fork runners with native-wire coverage or explicit executable exemptions; preserve governed-worker grants and credential handling. |
| [#1249](https://github.com/open-mercato/cezar/pull/1249) | 2026-10-09 | fix(cockpit): keep an ask card's picks when the thread unmounts its row (#1249) | [issue #1007](https://github.com/hearsay-tools/cezarion/issues/1007) | 2026-10-13 | Retain option selections and free-text answers across card remounts and navigation; preserve parent routing, human fallback and answer delivery. |
| [#1402](https://github.com/open-mercato/cezar/pull/1402) | 2026-10-12 | feat: create a new project (fresh git repo, optional private GitHub repo, templates) (#1402) | [issue #1014](https://github.com/hearsay-tools/cezarion/issues/1014) | 2026-10-13 | Adapt local and explicitly chosen private GitHub/template project creation to the current registry and checkout flow; exclude upstream telemetry. |

## Ported (29)

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
| [#953](https://github.com/open-mercato/cezar/pull/953) | 2026-09-14 | feat(sidebar): drag project groups to set their order, shared across devices (#952) (#953) | [PR #999](https://github.com/hearsay-tools/cezarion/pull/999), [issue #438](https://github.com/hearsay-tools/cezarion/issues/438) | 2026-10-13 | drag moved to the fork's project rail (ProjectGroups no longer renders); fallback is registry order, not lastOpenedAt |
| [#973](https://github.com/open-mercato/cezar/pull/973) | 2026-09-14 | feat(ui): filter the new-task base branch picker (#973) | [PR #720](https://github.com/hearsay-tools/cezarion/pull/720), [issue #436](https://github.com/hearsay-tools/cezarion/issues/436) | 2026-10-01 | Ported optional branch-name filtering, preserving fork picker presentation and keyboard query refinement. |
| [#984](https://github.com/open-mercato/cezar/pull/984) | 2026-09-14 | fix(workflows): park intermediate asks for input (#984) | [PR #813](https://github.com/hearsay-tools/cezarion/pull/813), [issue #427](https://github.com/hearsay-tools/cezarion/issues/427), [33aa7462](https://github.com/hearsay-tools/cezarion/commit/33aa7462), [cd0cc36a](https://github.com/hearsay-tools/cezarion/commit/cd0cc36a) | 2026-10-04 | Ported intermediate ASK parking and lifecycle coverage using the fork durable waiting and Continue-tail recovery; upstream dispatch and budget-brake logic excluded. |
| [#968](https://github.com/open-mercato/cezar/pull/968) | 2026-09-14 | fix(clone): recover from GitHub organization SAML auth (#968) | [PR #719](https://github.com/hearsay-tools/cezarion/pull/719), [issue #437](https://github.com/hearsay-tools/cezarion/issues/437), [01e6d382](https://github.com/hearsay-tools/cezarion/commit/01e6d382061c18095793ff256cb247229382a2aa) | 2026-09-30 | Ported SAML recovery, HTTPS credentials, fork-parent HTTPS transport, and unterminated error output. |
| [#993](https://github.com/open-mercato/cezar/pull/993) | 2026-09-16 | fix(automations): a stale poll lock no longer silences every project for ten minutes (#993) | [PR #651](https://github.com/hearsay-tools/cezarion/pull/651), [issue #428](https://github.com/hearsay-tools/cezarion/issues/428), [0f47bdfa](https://github.com/hearsay-tools/cezarion/commit/0f47bdfa), [3ff408df](https://github.com/hearsay-tools/cezarion/commit/3ff408df) | 2026-09-27 |  |
| [#1014](https://github.com/open-mercato/cezar/pull/1014) | 2026-09-17 | fix(providers): a runtime auth rejection verifies itself before it sticks (#1014) | [PR #598](https://github.com/hearsay-tools/cezarion/pull/598), [issue #431](https://github.com/hearsay-tools/cezarion/issues/431) | 2026-09-25 |  |
| [#1009](https://github.com/open-mercato/cezar/pull/1009) | 2026-09-17 | fix(server-deploy): fail the deploy when the service did not actually restart (#1009) | [PR #644](https://github.com/hearsay-tools/cezarion/pull/644), [issue #430](https://github.com/hearsay-tools/cezarion/issues/430), [2d328382](https://github.com/hearsay-tools/cezarion/commit/2d328382), [0dfb93c6](https://github.com/hearsay-tools/cezarion/commit/0dfb93c6), [3e676ecd](https://github.com/hearsay-tools/cezarion/commit/3e676ecd) | 2026-09-27 |  |
| [#994](https://github.com/open-mercato/cezar/pull/994) | 2026-09-18 | fix(server-install): ubuntu-vps vhost emits a standalone http2 directive nginx < 1.25.1 rejects (#994) | [PR #648](https://github.com/hearsay-tools/cezarion/pull/648), [issue #429](https://github.com/hearsay-tools/cezarion/issues/429), [5847c428](https://github.com/hearsay-tools/cezarion/commit/5847c4282c26ba56fb95d833efc4f391e53b8600) | 2026-09-27 |  |
| [#1082](https://github.com/open-mercato/cezar/pull/1082) | 2026-10-09 | feat(skills): unify browsing, activation, and preview (#1082) | [PR #1424](https://github.com/hearsay-tools/cezarion/pull/1424) | 2026-10-21 | the selection is stored per project with the legacy workspace fallback; the bookmarklet relocation was not ported |
| [#1318](https://github.com/open-mercato/cezar/pull/1318) | 2026-10-09 | fix(git): avoid shared config locks during worktree creation (#1318) | [PR #1075](https://github.com/hearsay-tools/cezarion/pull/1075), [issue #1006](https://github.com/hearsay-tools/cezarion/issues/1006) | 2026-10-15 | No-track creation on both fresh paths (ordinary tasks and owned workers, upstream patched only the task path); reattach unchanged; real-Git regressions cover both under a held config lock. |
| [#1349](https://github.com/open-mercato/cezar/pull/1349) | 2026-10-10 | feat(cockpit): Markdown preview toggle in the Changes diff (#1349) | [PR #1076](https://github.com/hearsay-tools/cezarion/pull/1076), [issue #1012](https://github.com/hearsay-tools/cezarion/issues/1012) | 2026-10-15 | Re-implemented by hearsay-tools/cezarion#1076 on the existing file readers with no recurring polling; adds a per-file switch and phone support, and loads repository images only (never remote ones). |
| [#1362](https://github.com/open-mercato/cezar/pull/1362) | 2026-10-10 | feat: speed up GitHub tab with paged hydration (#1362) | [PR #1189](https://github.com/hearsay-tools/cezarion/pull/1189) | 2026-10-17 | re-implemented together with open-mercato/cezar#1362, #1366 and #1374 on the fork's own GitHub surface (assignees, viewer filters, boards, account-keyed cache, sidebar); owner decisions: list-backed presets keep paging, and the list keeps a deprecated body |
| [#1366](https://github.com/open-mercato/cezar/pull/1366) | 2026-10-11 | fix(github): make the paged GitHub list query valid on real GitHub (#1366) | [PR #1189](https://github.com/hearsay-tools/cezarion/pull/1189) | 2026-10-17 | re-implemented together with open-mercato/cezar#1362, #1366 and #1374 on the fork's own GitHub surface (assignees, viewer filters, boards, account-keyed cache, sidebar); owner decisions: list-backed presets keep paging, and the list keeps a deprecated body |
| [#1374](https://github.com/open-mercato/cezar/pull/1374) | 2026-10-11 | fix(github): virtualize the list against its own pane and auto-load pages on scroll (#1374) | [PR #1189](https://github.com/hearsay-tools/cezarion/pull/1189) | 2026-10-17 | re-implemented together with open-mercato/cezar#1362, #1366 and #1374 on the fork's own GitHub surface (assignees, viewer filters, boards, account-keyed cache, sidebar); owner decisions: list-backed presets keep paging, and the list keeps a deprecated body |

## Partial (1)

| Upstream | Date | Title | Fork | Decided | Reason / note |
| --- | --- | --- | --- | --- | --- |
| [#985](https://github.com/open-mercato/cezar/pull/985) | 2026-09-15 | feat(automations): scheduled triggers, default-on, redesigned surface, creation from a prompt (#985) | [issue #766](https://github.com/hearsay-tools/cezarion/issues/766) | 2026-10-02 | stage 1 (hearsay-tools/cezarion#766) ported the schedule trigger, run-now, the kind-aware editor, list and log; the fork keeps CEZ_AUTOMATIONS=1 opt-in, the hearsay-tools/cezarion#651 lease and governed workers instead of default-on, lock replacement and task.dispatch. The CLI, built-in skill, prompt part, templates, calendars and stats are stages 2 and 3 — Adapt scheduling, prompt-based creation and the redesigned surface in stages; preserve the fork's opt-in default and governed workers instead of upstream dispatch |

## Diverged (6)

| Upstream | Date | Title | Fork | Decided | Reason / note |
| --- | --- | --- | --- | --- | --- |
| [#966](https://github.com/open-mercato/cezar/pull/966) | 2026-09-13 | fix(web): improve task detail rendering performance (#966) | [PR #140](https://github.com/hearsay-tools/cezarion/pull/140) | 2026-09-18 | the fork did its own transcript virtualization and anchor work in hearsay-tools/cezarion#140, hearsay-tools/cezarion#162, hearsay-tools/cezarion#306 and hearsay-tools/cezarion#333; upstream patch is not applicable, ideas only |
| [#972](https://github.com/open-mercato/cezar/pull/972) | 2026-09-13 | feat(dispatch): a task may dispatch other tasks (replaces the missions experiment) (#972) | [PR #138](https://github.com/hearsay-tools/cezarion/pull/138) | 2026-09-18 | the fork built owned workers behind an authenticated controller (PRs hearsay-tools/cezarion#138, hearsay-tools/cezarion#151, hearsay-tools/cezarion#159, opt-in CEZ_DELEGATION=1) instead of upstream dispatch (cez task, default-on, budget carve-out); same primitive, incompatible control plane. Owner decision 2026-09-18: nothing borrowed — different by design: fork built owned workers with an authenticated controller (CEZ_DELEGATION); upstream dispatch (CEZ_DISPATCH) is an incompatible model. Units specs worth reading for the escalation ladder |
| [#965](https://github.com/open-mercato/cezar/pull/965) | 2026-09-14 | fix(ui): keep the task thread readable on a phone while an agent works (#965) | [PR #303](https://github.com/hearsay-tools/cezarion/pull/303) | 2026-09-18 | mobile thread jumps were fixed differently in hearsay-tools/cezarion#303; the throttling helpers here would conflict with the fork virtualizer |
| [#1005](https://github.com/open-mercato/cezar/pull/1005) | 2026-09-16 | fix(opencode): a turn longer than five minutes no longer parks the run under Needs you (#1005) | [PR #24](https://github.com/hearsay-tools/cezarion/pull/24) | 2026-09-18 | the fork already takes the OpenCode turn end from session.idle instead of the 300 s undici long-poll (PR hearsay-tools/cezarion#24, 2026-09-01), which is the same fix |
| [#1015](https://github.com/open-mercato/cezar/pull/1015) | 2026-09-17 | fix(dispatch): tell parents --budget is optional so uncapped trees don't get invented caps (#1015) | [PR #138](https://github.com/hearsay-tools/cezarion/pull/138) | 2026-09-18 | dispatch prompt fix for --budget; the fork has no dispatch budget and its worker CLI is documented in PR hearsay-tools/cezarion#138 |
| [#995](https://github.com/open-mercato/cezar/pull/995) | 2026-09-18 | fix(runs): a turn parked on its own dispatched subagents stops reading as "needs you" (#995) | [PR #258](https://github.com/hearsay-tools/cezarion/pull/258) | 2026-09-18 | dispatch-specific fix; the fork keeps live worker parents out of human attention in PR hearsay-tools/cezarion#258 |

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

